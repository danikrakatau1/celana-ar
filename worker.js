/**
 * TempMail Worker — celana-ar-store.my.id
 *
 * 1. Email masuk via Cloudflare Email Routing (catch-all -> "Send to a Worker")
 *    disimpan ke Durable Object (strongly consistent, tanpa delay replikasi KV),
 *    otomatis terhapus setelah 2 jam (expirationTtl).
 * 2. Web inbox + API JSON disajikan dari fetch handler yang sama.
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

/* ---------------- web UI ---------------- */



/* ---------------- TempMail HTML (halaman utama, tanpa JS) ----------------
   Semua render di server, tanpa font eksternal, tanpa animasi, tanpa polling.
   Rute:
     GET  /                              -> form alamat / inbox
     GET  /?address=a@d                  -> inbox (20 pesan per halaman, ?p=0,1,2, cari ?q=)
     GET  /?prefix=x&domain=d            -> redirect ke /?address=x@d
     GET  /?random=1&domain=d            -> redirect ke alamat acak
     GET  /read?address=a@d&id=xx        -> isi email lengkap
     POST /delete                        -> hapus lalu redirect balik ke inbox
   Rute /lite lama redirect ke padanannya di root. API JSON (/api/*) tidak diubah.
   UI fancy lama dicopot 2026-10-25 (riwayat git masih menyimpan versi sebelumnya). */

const LITE_PAGE_SIZE = 20;

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LITE_CSS = "body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0a0f1e;color:#e9eefb;margin:0;padding:0}main{max-width:640px;margin:0 auto;padding:14px 12px 40px}a{color:#67e8f9}h1{font-size:20px;margin:8px 0 4px}h2{font-size:17px;margin:18px 0 8px}p{line-height:1.5;color:#c7d0e8}.addr{background:#111827;border:1px solid #334155;border-radius:10px;padding:12px 14px;font-family:ui-monospace,Consolas,monospace;font-size:17px;font-weight:700;word-break:break-all;margin:12px 0 4px}.hint{font-size:12px;color:#8b98b8;margin:0 0 14px}form{margin:12px 0}input,select{width:100%;box-sizing:border-box;background:#111827;color:#e9eefb;border:1px solid #334155;border-radius:10px;padding:11px 12px;font-size:15px;margin:6px 0}button{background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:11px 18px;font-size:15px;font-weight:700;cursor:pointer}button.sec{background:#1e293b;color:#e9eefb}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row a,.row button{margin:4px 0}.mail{border:1px solid #263349;border-radius:12px;padding:11px 12px;margin:10px 0;background:#0f172a}.mail a.subj{color:#e9eefb;text-decoration:none;font-weight:700;font-size:15px;line-height:1.4;display:block}.mail .meta{font-size:12.5px;color:#8b98b8;margin-top:5px;word-break:break-all}.mail form{margin:8px 0 0}.mail form button{background:#3b1220;color:#fda4af;padding:6px 12px;font-size:13px}pre.body{background:#111827;border:1px solid #334155;border-radius:10px;padding:14px;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6;color:#e9eefb}.nav{margin:16px 0}.err{background:#3b1220;border:1px solid #7f1d2d;border-radius:10px;padding:12px 14px}.top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:13px}";

function liteShell(title, body) {
  return "<!DOCTYPE html>\n<html lang=\"id\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>" + escHtml(title) + " — TempMail</title>\n<style>" + LITE_CSS + "</style>\n</head>\n<body>\n<main>\n" + body + "\n</main>\n</body>\n</html>";
}

function liteResp(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function liteRedirect(to) {
  return new Response(null, { status: 303, headers: { location: to } });
}

function liteAddrForm(domains, primary, msg) {
  let opts = "";
  for (let i = 0; i < domains.length; i++) {
    opts += "<option value=\"" + escHtml(domains[i]) + "\"" + (domains[i] === primary ? " selected" : "") + ">" + escHtml(domains[i]) + "</option>";
  }
  let body = "<h1>TempMail</h1><p>Versi ringan, tanpa animasi dan tanpa refresh otomatis. Cocok buat HP.</p>";
  if (msg) body += "<div class=\"err\">" + escHtml(msg) + "</div>";
  body += "<form method=\"get\" action=\"/\">" +
    "<label>Nama depan alamat (kosongkan = acak)</label>" +
    "<input name=\"prefix\" placeholder=\"mis. opoyvvtt\" autocomplete=\"off\">" +
    "<label>Domain</label><select name=\"domain\">" + opts + "</select>" +
    "<div class=\"row\"><button type=\"submit\">Buka inbox</button>" +
    "<button type=\"submit\" class=\"sec\" formaction=\"/?random=1\">Alamat acak</button></div>" +
    "</form><p>Instan • tanpa daftar • 100% gratis</p>";
  return liteResp(liteShell("TempMail", body));
}

function liteDateStr(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    try {
      return new Date(v).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB";
    } catch (e) {
      return String(v);
    }
  }
  return String(v).slice(0, 48);
}

async function handleLite(request, env, url, domains, primary) {
  const path = url.pathname;

  if (path === "/delete" || path === "/lite/delete") {
    if (request.method !== "POST") return liteRedirect("/");
    let fd = null;
    try {
      fd = await request.formData();
    } catch (e) {
      return liteRedirect("/");
    }
    const address = String(fd.get("address") || "").toLowerCase().trim();
    const id = String(fd.get("id") || "").trim();
    const p = String(fd.get("p") || "0");
    const qd = String(fd.get("q") || "");
    if (!validAddress(address, domains) || !/^[a-z0-9]+$/i.test(id)) return liteRedirect("/");
    try {
      await getStore(env, address).fetch("https://do/delete?id=" + encodeURIComponent(id), { method: "DELETE" });
    } catch (e) {}
    return liteRedirect("/?address=" + encodeURIComponent(address) + "&p=" + encodeURIComponent(p) + (qd ? "&q=" + encodeURIComponent(qd) : ""));
  }

  if (path === "/read" || path === "/lite/read") {
    const address = (url.searchParams.get("address") || "").toLowerCase().trim();
    const id = (url.searchParams.get("id") || "").trim();
    if (!validAddress(address, domains) || !/^[a-z0-9]+$/i.test(id)) {
      return liteResp(liteShell("Tidak ditemukan", "<div class=\"err\">Alamat atau email tidak valid.</div><p><a href=\"/\">Kembali ke form alamat</a></p>"), 400);
    }
    let email = null;
    try {
      const r = await getStore(env, address).fetch("https://do/read?id=" + encodeURIComponent(id));
      email = await r.json();
    } catch (e) {}
    if (!email || email.error) {
      return liteResp(liteShell("Tidak ditemukan", "<div class=\"err\">Email tidak ditemukan / sudah dihapus.</div><p><a href=\"/?address=" + encodeURIComponent(address) + "\">Kembali ke inbox</a></p>"), 404);
    }
    let meta = "Dari: " + escHtml(email.from);
    if (email.date) meta += "<br>Terkirim: " + escHtml(email.date);
    if (email.receivedAt) meta += "<br>Diterima web: " + escHtml(liteDateStr(email.receivedAt));
    const back = "/?address=" + encodeURIComponent(address);
    const body = "<div class=\"top\"><a href=\"" + back + "\">← Kembali ke inbox</a></div>" +
      "<h1>" + escHtml(email.subject) + "</h1>" +
      "<p>" + meta + "</p>" +
      "<pre class=\"body\">" + escHtml(email.body || "(kosong)") + "</pre>" +
      "<form method=\"post\" action=\"/delete\">" +
      "<input type=\"hidden\" name=\"address\" value=\"" + escHtml(address) + "\">" +
      "<input type=\"hidden\" name=\"id\" value=\"" + escHtml(email.id) + "\">" +
      "<button type=\"submit\">Hapus email ini</button></form>";
    return liteResp(liteShell(email.subject, body));
  }

  // / — inbox / form alamat
  const address = (url.searchParams.get("address") || "").toLowerCase().trim();
  if (!address) {
    const random = url.searchParams.get("random");
    const prefix = (url.searchParams.get("prefix") || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    let domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
    if (domains.indexOf(domain) === -1) domain = primary;
    if (random !== null || url.searchParams.has("prefix")) {
      const local = random !== null ? Math.random().toString(36).slice(2, 10) : prefix;
      if (!local && random === null) return liteAddrForm(domains, primary, "Isi nama depan dulu, atau pakai tombol Alamat acak.");
      const built = (local || Math.random().toString(36).slice(2, 10)) + "@" + domain;
      return liteRedirect("/?address=" + encodeURIComponent(built));
    }
    return liteAddrForm(domains, primary, "");
  }
  if (!validAddress(address, domains)) {
    return liteResp(liteShell("Alamat tidak valid", "<div class=\"err\">Alamat tidak valid untuk domain temp mail ini.</div><p><a href=\"/\">Kembali ke form alamat</a></p>"), 400);
  }

  let emails = [];
  try {
    const r = await getStore(env, address).fetch("https://do/inbox");
    emails = (await r.json()).emails || [];
  } catch (e) {}
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const qParam = q ? "&q=" + encodeURIComponent(q) : "";
  const shown = q ? emails.filter(function (e) { return (e.from + " " + e.subject).toLowerCase().indexOf(q) !== -1; }) : emails;
  let p = parseInt(url.searchParams.get("p") || "0", 10);
  if (isNaN(p) || p < 0) p = 0;
  const maxPage = Math.max(0, Math.ceil(shown.length / LITE_PAGE_SIZE) - 1);
  if (p > maxPage) p = maxPage;
  const page = shown.slice(p * LITE_PAGE_SIZE, p * LITE_PAGE_SIZE + LITE_PAGE_SIZE);
  const prefix = address.split("@")[0] || "";

  let domLinks = "";
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (d === address.split("@")[1]) continue;
    domLinks += " <a href=\"/?prefix=" + encodeURIComponent(prefix) + "&domain=" + encodeURIComponent(d) + "\">" + escHtml(d) + "</a>";
  }

  let body = "<div class=\"top\"><a href=\"/\">Alamat lain</a></div>" +
    "<h1>TempMail</h1>" +
    "<input class=\"addr\" readonly value=\"" + escHtml(address) + "\">" +
    "<p class=\"hint\">Ketuk alamat, pilih semua, lalu salin. Kirim email ke alamat ini, lalu tekan Refresh.</p>" +
    "<div class=\"row\"><a href=\"/?address=" + encodeURIComponent(address) + "\">↻ Refresh</a>" +
    (domLinks ? "<span>Ganti domain:" + domLinks + "</span>" : "") + "</div>" +
    "<h2>Inbox (" + emails.length + " pesan)" + (q ? " • hasil cari '" + escHtml(q) + "': " + shown.length : "") + "</h2>" +
    "<form method=\"get\" action=\"/\"><input type=\"hidden\" name=\"address\" value=\"" + escHtml(address) + "\"><input name=\"q\" value=\"" + escHtml(q) + "\" placeholder=\"Cari pengirim / subjek\"><div class=\"row\"><button type=\"submit\">Cari</button>" + (q ? "<a href=\"/?address=" + encodeURIComponent(address) + "\">Hapus filter</a>" : "") + "</div></form>";
  if (!emails.length) {
    body += "<p>Belum ada email masuk. Kirim ke alamat di atas, lalu tekan Refresh.</p>";
  } else {
    for (let i = 0; i < page.length; i++) {
      const e = page[i];
      const readUrl = "/read?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(e.id);
      body += "<div class=\"mail\">" +
        "<a class=\"subj\" href=\"" + readUrl + "\">" + escHtml(e.subject) + "</a>" +
        "<div class=\"meta\">" + escHtml(e.from) + (e.date ? " • " + escHtml(String(e.date).slice(0, 48)) : "") + "</div>" +
        "<form method=\"post\" action=\"/delete\">" +
        "<input type=\"hidden\" name=\"address\" value=\"" + escHtml(address) + "\">" +
        "<input type=\"hidden\" name=\"id\" value=\"" + escHtml(e.id) + "\">" +
        "<input type=\"hidden\" name=\"p\" value=\"" + p + "\">" +
        (q ? "<input type=\"hidden\" name=\"q\" value=\"" + escHtml(q) + "\">" : "") +
        "<button type=\"submit\">✕ Hapus</button></form></div>";
    }
    body += "<div class=\"nav row\">";
    if (p > 0) body += "<a href=\"/?address=" + encodeURIComponent(address) + "&p=" + (p - 1) + qParam + "\">← Lebih baru</a>";
    body += "<span>Halaman " + (p + 1) + " dari " + (maxPage + 1) + "</span>";
    if (p < maxPage) body += "<a href=\"/?address=" + encodeURIComponent(address) + "&p=" + (p + 1) + qParam + "\">Lebih lama →</a>";
    body += "</div>";
  }
  return liteResp(liteShell("Inbox — " + address, body));
}

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

    if (url.pathname === "/" || url.pathname === "/read" || url.pathname === "/delete" || url.pathname === "/lite" || url.pathname === "/lite/read" || url.pathname === "/lite/delete") {
      if (url.pathname.startsWith("/lite") && request.method === "GET") {
        const target = url.pathname.replace(/^\/lite/, "") || "/";
        return liteRedirect(target + url.search);
      }
      return handleLite(request, env, url, domains, primary);
    }

    return liteResp(liteShell("Tidak ditemukan", "<div class=\"err\">Halaman tidak ditemukan.</div><p><a href=\"/\">Kembali ke TempMail</a></p>"), 404);
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
