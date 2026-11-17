/**
 * TempMail Worker — celana-ar-store.my.id
 *
 * 1. Email masuk via Cloudflare Email Routing (catch-all -> "Send to a Worker")
 *    disimpan ke Durable Object (strongly consistent, tanpa delay replikasi KV),
 *    otomatis terhapus setelah 2 jam (expirationTtl).
 * 2. API JSON dari fetch handler; web UI = file statis di public/ (Static Assets).
 *
 * Setup:
 *  - Buat KV namespace di dashboard, isi ID-nya di wrangler.toml
 *  - Deploy otomatis via Workers Git integration tiap push ke main
 *  - Pasang custom domain, misal mail.celana-ar-store.my.id
 *  - Email Routing > Routing rules > Catch-all > "Send to a Worker" > pilih worker ini
 */

const TTL = 7200; // email kedaluwarsa 2 jam
const MAX_BODY = 20000; // potong isi email
const MAX_RAW = 512 * 1024; // baca raw maksimal 512 KB

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function getStore(env, address) {
  const id = env.INBOX_STORE.idFromName(address.toLowerCase());
  return env.INBOX_STORE.get(id);
}

function validAddress(addr, domains) {
  if (!/^[a-z0-9._-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(addr)) return false;
  const lower = addr.toLowerCase();
  return domains.some((d) => lower.endsWith("@" + d));
}

/* ---------------- parser email ringan ---------------- */

function decodeWords(s) {
  // =?charset?B|Q?encoded?=
  return String(s || "").replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (m, charset, enc, text) => {
      try {
        let bytes;
        if (enc.toUpperCase() === "B") {
          const bin = atob(text.replace(/\s/g, ""));
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } else {
          const qp = text
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16))
            );
          bytes = Uint8Array.from(qp, (c) => c.charCodeAt(0));
        }
        const cs = charset.toLowerCase();
        return new TextDecoder(
          cs === "iso-8859-1" || cs === "latin1" ? "latin1" : "utf-8"
        ).decode(bytes);
      } catch {
        return text;
      }
    }
  );
}

function decodeBody(text, encoding) {
  encoding = (encoding || "").toLowerCase().trim();
  if (encoding === "base64") {
    try {
      const bin = atob(String(text).replace(/\s/g, ""));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return text;
    }
  }
  if (encoding === "quoted-printable") {
    let t = String(text).replace(/=\r?\n/g, ""); // soft break
    t = t.replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    try {
      return new TextDecoder("utf-8").decode(
        Uint8Array.from(t, (c) => c.charCodeAt(0))
      );
    } catch {
      return t;
    }
  }
  return text;
}

function parseHeaders(raw) {
  const headers = {};
  const headEnd = raw.search(/\r?\n\r?\n/);
  const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
  let current = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers[current] += " " + line.trim();
    } else {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        current = m[1].toLowerCase();
        headers[current] = (headers[current] ? headers[current] + " " : "") + m[2].trim();
      }
    }
  }
  const body =
    headEnd === -1 ? "" : raw.slice(headEnd).replace(/^\r?\n\r?\n/, "");
  return { headers, body };
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(raw) {
  const { headers, body } = parseHeaders(raw);
  const ct = (headers["content-type"] || "text/plain").toLowerCase();
  const bm = ct.match(/boundary="?([^";\s]+)"?/);
  if (bm) {
    const boundary = bm[1];
    const parts = body.split("--" + boundary);
    let htmlFallback = "";
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--") continue;
      const ph = parseHeaders(trimmed);
      const pct = (ph.headers["content-type"] || "").toLowerCase();
      const enc = ph.headers["content-transfer-encoding"] || "";
      if (pct.includes("text/plain")) {
        return decodeBody(ph.body, enc).slice(0, MAX_BODY);
      }
      if (pct.includes("text/html") && !htmlFallback) {
        htmlFallback = decodeBody(ph.body, enc);
      }
    }
    if (htmlFallback) return stripHtml(htmlFallback).slice(0, MAX_BODY);
  }
  const enc = headers["content-transfer-encoding"] || "";
  const decoded = decodeBody(body, enc);
  if (ct.includes("text/html")) return stripHtml(decoded).slice(0, MAX_BODY);
  return decoded.slice(0, MAX_BODY);
}

/* ---------------- email handler ---------------- */

async function handleEmail(message, env) {
  try {
    const toAddr = String(message.to || "").toLowerCase().trim();
    if (!toAddr || !toAddr.includes("@")) return;

    const reader = message.raw.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RAW) break;
      chunks.push(value);
    }
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    const raw = new TextDecoder("utf-8").decode(buf);

    const { headers } = parseHeaders(raw);
    const from = decodeWords(headers["from"] || "(tidak dikenal)");
    const subject = decodeWords(headers["subject"] || "(tanpa subjek)");
    const date = headers["date"] || "";
    const body = extractBody(raw);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const expiresAt = Date.now() + TTL * 1000;
    const email = { id, from, to: toAddr, subject, date, body, expiresAt, receivedAt: Date.now() };
    await getStore(env, toAddr).fetch("https://do/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(email),
    });
  } catch {
    // jangan bounce — terima diam-diam
  }
}

/* ---------------- web UI ----------------
   Halaman = file statis di public/ (index.html + style.css + app.js),
   disajikan Workers Static Assets. Worker hanya menangani /api/* dan email. */

export default {
  async email(message, env, ctx) {
    ctx.waitUntil(handleEmail(message, env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const domains = (env.DOMAINS || env.DOMAIN || "celana-ar-store.my.id")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const primary = domains[0];

    if (url.pathname === "/api/inbox") {
      const address = (url.searchParams.get("address") || "").toLowerCase().trim();
      if (!validAddress(address, domains)) return json({ error: "alamat tidak valid" }, 400);
      let idx = [];
      try {
        const r = await getStore(env, address).fetch("https://do/inbox");
        idx = (await r.json()).emails || [];
      } catch {}
      return json({ emails: idx });
    }

    if (url.pathname === "/api/read") {
      const address = (url.searchParams.get("address") || "").toLowerCase().trim();
      const id = (url.searchParams.get("id") || "").trim();
      if (!validAddress(address, domains) || !/^[a-z0-9]+$/i.test(id))
        return json({ error: "invalid" }, 400);
      let email = null;
      try {
        const r = await getStore(env, address).fetch("https://do/read?id=" + encodeURIComponent(id));
        email = await r.json();
      } catch {}
      if (!email || email.error) return json({ error: "not found" }, 404);
      return json(email);
    }

    if (url.pathname === "/api/delete" && request.method === "DELETE") {
      const address = (url.searchParams.get("address") || "").toLowerCase().trim();
      const id = (url.searchParams.get("id") || "").trim();
      if (!validAddress(address, domains) || !/^[a-z0-9]+$/i.test(id))
        return json({ error: "invalid" }, 400);
      try {
        await getStore(env, address).fetch("https://do/delete?id=" + encodeURIComponent(id), { method: "DELETE" });
      } catch {}
      return json({ ok: true });
    }


    if (url.pathname === "/api/domains") {
      return json({ domains });
    }

    return new Response("not found", { status: 404 });
  },
};

/* ---------------- Durable Object: penyimpanan inbox ----------------
   Strongly consistent — tulis langsung kebaca, tanpa delay replikasi KV.
   Satu instance per alamat email (idFromName). */

export class InboxStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const st = this.state.storage;

    if (req.method === "POST" && path === "/save") {
      const email = await req.json();
      await st.put("msg:" + email.id, email, { expirationTtl: TTL });
      let idx = (await st.get("idx")) || [];
      idx.unshift({ id: email.id, from: email.from, subject: email.subject, date: email.date, expiresAt: email.expiresAt });
      idx = idx.slice(0, 50);
      await st.put("idx", idx, { expirationTtl: TTL });
      return new Response("ok");
    }

    if (path === "/inbox") {
      const idx = (await st.get("idx")) || [];
      return Response.json({ emails: idx });
    }

    if (path === "/read") {
      const email = await st.get("msg:" + (url.searchParams.get("id") || ""));
      if (!email) return Response.json({ error: "not_found" });
      return Response.json(email);
    }

    if (req.method === "DELETE" && path === "/delete") {
      const id = url.searchParams.get("id") || "";
      await st.delete("msg:" + id);
      let idx = (await st.get("idx")) || [];
      idx = idx.filter((e) => e.id !== id);
      await st.put("idx", idx, { expirationTtl: TTL });
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}
