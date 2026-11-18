/**
 * TempMail Worker — moai.my.id
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
const MAX_HTML = 120000; // potong versi HTML email
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
        return decodeBytes(bytes, charset);
      } catch {
        return text;
      }
    }
  );
}

function normCharset(cs) {
  cs = String(cs || "utf-8").toLowerCase().trim().replace(/["']/g, "");
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "iso-8859-15" || cs === "us-ascii" || cs === "ascii") return "windows-1252";
  return cs || "utf-8";
}

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(normCharset(charset)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Isi email ditangani sebagai "byte string" (1 char = 1 byte) supaya charset
// asli tiap bagian MIME tidak rusak sebelum sempat didekode menurut charset-nya.
function byteStrToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function transferDecode(bodyStr, encoding) {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") {
    try {
      const bin = atob(String(bodyStr).replace(/\s/g, ""));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return byteStrToBytes(String(bodyStr));
    }
  }
  if (enc === "quoted-printable") {
    const t = String(bodyStr).replace(/=\r?\n/g, ""); // soft break
    const out = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) {
        out.push(parseInt(t.substr(i + 1, 2), 16));
        i += 2;
      } else {
        out.push(t.charCodeAt(i) & 0xff);
      }
    }
    return Uint8Array.from(out);
  }
  return byteStrToBytes(String(bodyStr));
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

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•", deg: "°", plusmn: "±", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶" };
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return " "; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => (named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m));
}

// HTML -> teks polos dengan struktur paragraf & baris tetap terjaga.
function stripHtml(html) {
  let t = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<td[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function charsetOf(ct) {
  const m = /charset="?([^";\s]+)"?/i.exec(ct || "");
  return m ? m[1] : "utf-8";
}

// Telusuri MIME secara rekursif (multipart bertingkat) dan ambil bagian
// text/plain + text/html pertama, masing-masing didekode menurut charset-nya.
function extractParts(rawStr) {
  const { headers, body } = parseHeaders(rawStr);
  const ct = headers["content-type"] || "text/plain";
  const ctl = ct.toLowerCase();
  const bm = ct.match(/boundary="?([^";\s]+)"?/i);
  if (ctl.startsWith("multipart/") && bm) {
    let text = "";
    let html = "";
    for (const seg of body.split("--" + bm[1])) {
      const part = seg.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      if (!part || part.startsWith("--")) continue;
      const sub = extractParts(part);
      if (!text && sub.text) text = sub.text;
      if (!html && sub.html) html = sub.html;
      if (text && html) break;
    }
    return { text, html };
  }
  const enc = headers["content-transfer-encoding"] || "";
  const decoded = decodeBytes(transferDecode(body, enc), charsetOf(ct));
  if (ctl.includes("text/html")) return { text: "", html: decoded };
  return { text: decoded, html: "" };
}

// Buang elemen berbahaya dari HTML email sebelum disimpan; tampilan akhir
// dirender di iframe sandbox tanpa skrip.
function sanitizeHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<base[^>]*>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/<meta[^>]*http-equiv[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

function extractBody(rawStr) {
  const { text, html } = extractParts(rawStr);
  let t = text;
  if (!t && html) t = stripHtml(html);
  return { text: t.slice(0, MAX_BODY), html: sanitizeHtml(html).slice(0, MAX_HTML) };
}

/* ---------------- gerbang anti-bot (Turnstile) ----------------
   Aktif hanya bila env.TURNSTILE_SECRET terpasang (dashboard Worker).
   Tanpa secret = gerbang nonaktif (masa pemasangan aman).
   Manusia: Turnstile managed (diam-diam / interaktif bila mencurigakan)
   -> cookie izin HMAC 24 jam. Bot UA dikenal -> 403 langsung.
   Sinyal otomatisasi keras (webdriver, renderer headless) -> ditolak
   walau token Turnstile valid. */
const TS_SITE_KEY = "0x4AAAAAAGFDhp4eMUo9VAUW";
const CLEAR_COOKIE = "tm_clear";
const CLEAR_TTL = 3600; // umur cookie izin: 1 jam + terikat IP (keputusan user 18 Nov 2026; sebelumnya 24 jam tanpa ikatan)
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

async function ipTag(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function makeClearance(request, secret) {
  const exp = Math.floor(Date.now() / 1000) + CLEAR_TTL;
  const payload = exp + "." + (await ipTag(request));
  return payload + "." + (await hmacB64(secret, "clear:" + payload));
}

async function checkClearance(request, secret) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(new RegExp("(?:^|; )" + CLEAR_COOKIE + "=([^;]+)"));
  if (!m) return false;
  const parts = decodeURIComponent(m[1]).split(".");
  if (parts.length !== 3) return false;
  const exp = parseInt(parts[0], 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  if (parts[1] !== (await ipTag(request))) return false;
  return (await hmacB64(secret, "clear:" + parts[0] + "." + parts[1])) === parts[2];
}

function pageShell(title, inner) {
  return "<!DOCTYPE html><html lang=\"id\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>" + title + "</title>" +
  "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>" +
  "<link href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap\" rel=\"stylesheet\">" +
  "<style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{font-family:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif;background:radial-gradient(900px 500px at 88% -8%,rgba(99,102,241,.20),transparent 62%),radial-gradient(760px 520px at -12% 108%,rgba(13,148,136,.14),transparent 62%),#070a14;color:#eef2fd;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 18px;-webkit-font-smoothing:antialiased}" +
  ".card{width:100%;max-width:430px;background:linear-gradient(180deg,rgba(148,163,184,.08),rgba(148,163,184,.035));border:1px solid rgba(148,163,184,.18);border-radius:24px;padding:38px 32px 30px;box-shadow:0 24px 60px rgba(2,6,17,.6);text-align:center}" +
  ".brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:26px}" +
  ".brand .name{font-size:20px;font-weight:800;letter-spacing:-.02em}" +
  ".brand .name em{font-style:normal;background:linear-gradient(135deg,#6366f1,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}" +
  ".pro{font-size:9.5px;font-weight:800;letter-spacing:.12em;color:#fff;background:linear-gradient(135deg,#6366f1,#22d3ee);padding:3px 7px;border-radius:99px}" +
  ".spin{width:42px;height:42px;border-radius:50%;border:3.5px solid rgba(99,102,241,.22);border-top-color:#6366f1;margin:2px auto 20px;animation:sp .9s linear infinite}" +
  "@keyframes sp{to{transform:rotate(360deg)}}" +
  ".shield{font-size:40px;line-height:1;margin-bottom:16px}" +
  "h1{font-size:21px;font-weight:800;letter-spacing:-.015em;margin-bottom:10px}" +
  "p.desc{color:#93a1c0;font-size:14px;line-height:1.7;margin-bottom:22px}" +
  ".ts{display:flex;justify-content:center;min-height:66px}" +
  "#st{margin-top:18px;font-size:13px;color:#93a1c0;min-height:18px;font-weight:600}" +
  ".meta{margin-top:24px;padding-top:18px;border-top:1px solid rgba(148,163,184,.14);font-size:11.5px;color:#64748f;display:flex;align-items:center;justify-content:center;gap:6px}" +
  ".foot{margin-top:20px;font-size:11.5px;color:#475569}" +
  "</style></head><body>" + inner + "</body></html>";
}

function brandRow() {
  return "<div class=\"brand\">" +
  "<svg width=\"30\" height=\"30\" viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"3\" stroke=\"url(#lg)\" stroke-width=\"1.8\"/><path d=\"M4.5 7.5l7.5 5.5 7.5-5.5\" stroke=\"url(#lg)\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><defs><linearGradient id=\"lg\" x1=\"3\" y1=\"5\" x2=\"21\" y2=\"19\"><stop stop-color=\"#6366f1\"/><stop offset=\"1\" stop-color=\"#22d3ee\"/></linearGradient></defs></svg>" +
  "<span class=\"name\">Temp<em>Mail</em></span><span class=\"pro\">PRO</span></div>";
}

function botWall() {
  const inner = "<div class=\"card\">" + brandRow() +
    "<div class=\"shield\"><svg width=\"44\" height=\"44\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#818cf8\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"m9 12 2 2 4-4\"/></svg></div>" +
    "<h1>Akses Ditolak</h1>" +
    "<p class=\"desc\">Permintaan Anda terdeteksi sebagai lalu lintas otomatis (bot atau crawler) dan tidak dapat kami layani. Layanan ini hanya dapat diakses melalui browser standar.</p>" +
    "<div class=\"meta\">Koneksi terenkripsi · Dilindungi Cloudflare</div></div>" +
    "<div class=\"foot\">© 2026 moai.my.id</div>";
  return new Response(pageShell("403 — Akses Ditolak · TempMail PRO", inner), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
}

function gatePage(dest) {
  const inner = "<div class=\"card\">" + brandRow() +
    "<div class=\"spin\"></div>" +
    "<h1>Verifikasi Keamanan</h1>" +
    "<p class=\"desc\">Untuk melindungi layanan dari penyalahgunaan dan akses otomatis, kami perlu memastikan bahwa Anda bukan bot. Proses ini biasanya selesai dalam beberapa detik. Apabila diminta, silakan selesaikan verifikasi pada kotak di bawah ini.</p>" +
    "<div class=\"ts\"><div class=\"cf-turnstile\" data-sitekey=\"" + TS_SITE_KEY + "\" data-callback=\"onTs\" data-theme=\"dark\"></div></div>" +
    "<div id=\"st\">Menunggu verifikasi…</div>" +
    "<div class=\"meta\">Koneksi terenkripsi · Dilindungi Cloudflare Turnstile</div></div>" +
    "<div class=\"foot\">© 2026 moai.my.id</div>";
  const script = "<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" async defer></script>" +
  "<script>" +
  "var DEST = " + JSON.stringify(dest) + ";" +
  "function signals(){" +
  "var s={webdriver:!!navigator.webdriver,plugins:navigator.plugins?navigator.plugins.length:-1,langs:navigator.languages?navigator.languages.length:0,renderer:''};" +
  "try{var c=document.createElement('canvas');var gl=c.getContext('webgl')||c.getContext('experimental-webgl');" +
  "if(gl){var e=gl.getExtension('WEBGL_debug_renderer_info');s.renderer=e?String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)):'?';}}catch(err){s.renderer='err';}" +
  "return s;}" +
  "function onTs(token){" +
  "var st=document.getElementById('st');st.textContent='Sedang memverifikasi…';" +
  "fetch('/__verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token,sig:signals()})})" +
  ".then(function(r){return r.json();})" +
  ".then(function(d){if(d&&d.ok){st.textContent='Verifikasi berhasil. Anda akan dialihkan…';location.replace(DEST);}" +
  "else{st.textContent='Verifikasi belum berhasil. Silakan coba lagi.';if(window.turnstile)turnstile.reset();}})" +
  ".catch(function(){st.textContent='Terjadi gangguan koneksi. Silakan coba lagi.';if(window.turnstile)turnstile.reset();});}" +
  "</script>";
  const html = pageShell("Verifikasi Keamanan — TempMail PRO", inner).replace("</body>", script + "</body>");
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
  const val = await makeClearance(request, env.TURNSTILE_SECRET);
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
    // Pertahankan byte asli sebagai byte string (1 char = 1 byte). Decode
    // UTF-8 langsung di sini akan merusak bagian email ber-charset lain
    // sebelum parser MIME sempat membaca charset-nya.
    let raw = "";
    for (let i = 0; i < buf.length; i += 8192) {
      raw += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    }

    const { headers } = parseHeaders(raw);
    const from = decodeWords(headers["from"] || "(tidak dikenal)");
    const subject = decodeWords(headers["subject"] || "(tanpa subjek)");
    const date = headers["date"] || "";
    const parts = extractBody(raw);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const expiresAt = Date.now() + TTL * 1000;
    const email = { id, from, to: toAddr, subject, date, body: parts.text, html: parts.html, expiresAt, receivedAt: Date.now() };
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
    if (url.hostname === "mail.celana-ar-store.my.id" || url.hostname === "celana-ar-store.my.id") {
      url.hostname = "moai.my.id";
      return Response.redirect(url.toString(), 301);
    }
    const domains = (env.DOMAINS || env.DOMAIN || "moai.my.id")
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
      idx.unshift({ id: email.id, from: email.from, subject: email.subject, date: email.date, expiresAt: email.expiresAt, preview: String(email.body || "").replace(/\s+/g, " ").trim().slice(0, 110) });
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
