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

/* ---------------- gerbang anti-bot (Turnstile) ----------------
   Aktif hanya bila env.TURNSTILE_SECRET terpasang (dashboard Worker).
   Tanpa secret = gerbang nonaktif (masa pemasangan aman).
   Manusia: Turnstile managed (diam-diam / interaktif bila mencurigakan)
   -> cookie izin HMAC 24 jam. Bot UA dikenal -> 403 langsung.
   Sinyal otomatisasi keras (webdriver, renderer headless) -> ditolak
   walau token Turnstile valid. */
const TS_SITE_KEY = "0x4AAAAAAGE_iDGyGCGuXDB7";
const CLEAR_COOKIE = "tm_clear";
const CLEAR_TTL = 86400;
const BOT_UA = /(gptbot|claudebot|ccbot|bytespider|amazonbot|anthropic-ai|cohere-ai|ai2bot|perplexitybot|meta-externalagent|facebookbot|twitterbot|linkedinbot|slackbot|discordbot|bingbot|googlebot|yandexbot|baiduspider|duckduckbot|semrushbot|ahrefsbot|mj12bot|curl|wget|python-requests|python-urllib|go-http-client|okhttp|java\/|node-fetch|axios|headlesschrome|phantomjs|puppeteer|playwright)/i;
const RL = new Map();

function isBotUA(request) {
  return BOT_UA.test(request.headers.get("user-agent") || "");
}

async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeClearance(secret) {
  const exp = Math.floor(Date.now() / 1000) + CLEAR_TTL;
  return exp + "." + (await hmacB64(secret, "clear:" + exp));
}

async function checkClearance(request, secret) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(new RegExp("(?:^|; )" + CLEAR_COOKIE + "=([^;]+)"));
  if (!m) return false;
  const parts = decodeURIComponent(m[1]).split(".");
  if (parts.length !== 2) return false;
  const exp = parseInt(parts[0], 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  return (await hmacB64(secret, "clear:" + exp)) === parts[1];
}

function botWall() {
  const html = "<!DOCTYPE html><html lang=\"id\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>403 — Khusus Manusia</title><style>body{background:#070a14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:20px}div{max-width:420px}h1{font-size:46px;margin:0 0 10px}p{color:#94a3b8;line-height:1.65}</style></head><body><div><h1>🤖🚫</h1><p><b>Ups, ketahuan.</b></p><p>Halaman ini khusus manusia. Bot, crawler AI, dan skrip otomatis tidak dipersilakan masuk.</p></div></body></html>";
  return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
}

function gatePage(dest) {
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memeriksa Browser — TempMail PRO</title>
<style>
body{background:#070a14;color:#eef2fd;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:20px}
.box{max-width:400px;width:100%;text-align:center;background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.16);border-radius:20px;padding:34px 26px}
.ic{font-size:42px}
h1{font-size:20px;margin:14px 0 8px}
p{color:#93a1c0;font-size:14px;line-height:1.65;margin:0 0 20px}
.ts{display:flex;justify-content:center;min-height:66px}
#st{margin-top:16px;font-size:13px;color:#93a1c0;min-height:18px}
.spin{width:34px;height:34px;border-radius:50%;border:3.5px solid rgba(99,102,241,.25);border-top-color:#6366f1;margin:0 auto 6px;animation:sp 0.9s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
<div class="box">
  <div class="spin"></div>
  <h1>Sebentar, lagi dicek dulu 🛡️</h1>
  <p>Kami memastikan kamu manusia beneran, bukan bot. Biasanya cuma 2–3 detik — kalau muncul kotak verifikasi, selesaikan aja ya.</p>
  <div class="ts"><div class="cf-turnstile" data-sitekey="${TS_SITE_KEY}" data-callback="onTs" data-theme="dark"></div></div>
  <div id="st">Menunggu verifikasi…</div>
</div>
<script>
var DEST = ${JSON.stringify(dest)};
function signals() {
  var s = { webdriver: !!navigator.webdriver, plugins: navigator.plugins ? navigator.plugins.length : -1, langs: navigator.languages ? navigator.languages.length : 0, renderer: "" };
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (gl) { var e = gl.getExtension("WEBGL_debug_renderer_info"); s.renderer = e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : "?"; }
  } catch (err) { s.renderer = "err"; }
  return s;
}
function onTs(token) {
  var st = document.getElementById("st");
  st.textContent = "Memverifikasi…";
  fetch("/__verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token, sig: signals() }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok) { st.textContent = "Lolos! Membuka TempMail…"; location.replace(DEST); }
      else { st.textContent = "Verifikasi gagal — coba lagi ya."; if (window.turnstile) turnstile.reset(); }
    })
    .catch(function () { st.textContent = "Koneksi bermasalah — coba lagi ya."; if (window.turnstile) turnstile.reset(); });
}
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function handleVerify(request, env) {
  if (isBotUA(request)) return json({ ok: false, error: "bot" }, 403);
  let body = {};
  try { body = await request.json(); } catch {}
  const token = body.token || "";
  const sig = body.sig || {};
  if (!token) return json({ ok: false }, 400);
  if (sig.webdriver === true) return json({ ok: false, error: "automation" }, 403);
  if (typeof sig.renderer === "string" && /(swiftshader|llvmpipe)/i.test(sig.renderer)) return json({ ok: false, error: "headless" }, 403);
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  let ok = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const d = await r.json();
    ok = !!d.success;
  } catch {}
  if (!ok) return json({ ok: false }, 403);
  const val = await makeClearance(env.TURNSTILE_SECRET);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": CLEAR_COOKIE + "=" + encodeURIComponent(val) + "; Path=/; Max-Age=" + CLEAR_TTL + "; HttpOnly; Secure; SameSite=Lax",
    },
  });
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
    // TempMail pindah ke domain utama (17 Nov 2026): host mail.* lama
    // dialihkan permanen ke domain utama, path + query dipertahankan.
    if (url.hostname === "mail.celana-ar-store.my.id") {
      url.hostname = "celana-ar-store.my.id";
      return Response.redirect(url.toString(), 301);
    }
    const domains = (env.DOMAINS || env.DOMAIN || "celana-ar-store.my.id")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const primary = domains[0];

    // --- gerbang anti-bot (aktif hanya bila secret Turnstile terpasang) ---
    if (env.TURNSTILE_SECRET) {
      if (url.pathname === "/__gate") {
        if (isBotUA(request)) return botWall();
        const to = url.searchParams.get("to") || "/";
        const dest = to.startsWith("/") && !to.startsWith("//") ? to : "/";
        return gatePage(dest);
      }
      if (url.pathname === "/__verify" && request.method === "POST") {
        return handleVerify(request, env);
      }
      const isApi = url.pathname.startsWith("/api/");
      const accept = request.headers.get("accept") || "";
      const isDoc = request.method === "GET" && (accept.includes("text/html") || url.pathname === "/" || url.pathname === "/anif/" || url.pathname.endsWith(".html"));
      if (isApi || isDoc) {
        if (isBotUA(request)) return isApi ? json({ error: "bot tidak diizinkan" }, 403) : botWall();
        if (!(await checkClearance(request, env.TURNSTILE_SECRET))) {
          if (isApi) return json({ error: "perlu verifikasi", gate: "/__gate" }, 403);
          return Response.redirect(new URL("/__gate?to=" + encodeURIComponent(url.pathname + url.search), request.url).toString(), 302);
        }
        if (isApi) {
          const ip = request.headers.get("cf-connecting-ip") || "x";
          const now = Date.now();
          const rec = RL.get(ip);
          if (rec && now < rec.reset && rec.n >= 240) return json({ error: "terlalu cepat, santai dulu" }, 429);
          if (!rec || now >= rec.reset) RL.set(ip, { n: 1, reset: now + 60000 }); else rec.n++;
        }
      }
    }

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

    // Sisanya = file statis (public/) lewat binding ASSETS. run_worker_first
    // di wrangler.toml bikin redirect host mail.* jalan juga untuk halaman.
    return env.ASSETS.fetch(request);
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
