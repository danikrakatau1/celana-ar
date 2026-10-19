/**
 * TempMail Worker — celana-ar-store.my.id
 *
 * 1. Email masuk via Cloudflare Email Routing (catch-all -> "Send to a Worker")
 *    disimpan ke KV, otomatis terhapus setelah 2 jam (expirationTtl).
 * 2. Web inbox + API JSON disajikan dari fetch handler yang sama.
 *
 * Setup:
 *  - Buat KV namespace di dashboard, isi ID-nya di wrangler.toml
 *  - Deploy (otomatis via GitHub Actions tiap push ke main)
 *  - Pasang custom domain, misal mail.celana-ar-store.my.id
 *  - Email Routing > Routing rules > Catch-all > Edit > "Send to a Worker" > pilih worker ini
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

function validAddress(addr, domain) {
  return (
    /^[a-z0-9._-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(addr) &&
    addr.toLowerCase().endsWith("@" + domain.toLowerCase())
  );
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
    const email = { id, from, to: toAddr, subject, date, body };
    await env.INBOX.put("msg:" + id, JSON.stringify(email), {
      expirationTtl: TTL,
    });

    const idxKey = "idx:" + toAddr;
    let idx = [];
    try {
      idx = JSON.parse((await env.INBOX.get(idxKey)) || "[]");
    } catch {}
    idx.unshift({ id, from, subject, date });
    await env.INBOX.put(idxKey, JSON.stringify(idx.slice(0, 50)), {
      expirationTtl: TTL,
    });
  } catch {
    // jangan bounce — terima diam-diam
  }
}

/* ---------------- web UI ---------------- */

const PAGE = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TempMail — __DOMAIN__</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
.wrap{width:100%;max-width:720px}
h1{font-size:28px;margin-bottom:4px}
.sub{color:#94a3b8;margin-bottom:20px;font-size:14px}
.addrbox{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;margin-bottom:16px}
.addr{font-size:20px;font-weight:700;word-break:break-all;color:#7dd3fc;margin-bottom:12px}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{background:#0284c7;border:none;color:#fff;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
button:hover{background:#0369a1}
button.ghost{background:#334155}
button.ghost:hover{background:#475569}
.custom{display:flex;gap:8px;margin-top:12px}
.custom input{flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:10px 12px;border-radius:8px;font-size:14px}
.inbox{background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden}
.inboxhead{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #334155}
.inboxhead h2{font-size:16px}
#count{font-size:12px;color:#94a3b8}
.mail{padding:12px 16px;border-bottom:1px solid #334155;cursor:pointer}
.mail:last-child{border-bottom:none}
.mail:hover{background:#273449}
.mail .from{font-weight:600;font-size:14px;margin-bottom:2px}
.mail .subj{font-size:14px;color:#cbd5e1;margin-bottom:2px}
.mail .date{font-size:12px;color:#64748b}
.empty{padding:32px 16px;text-align:center;color:#64748b;font-size:14px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:16px;z-index:10}
.modal.open{display:flex}
.mbox{background:#1e293b;border:1px solid #334155;border-radius:12px;max-width:640px;width:100%;max-height:85vh;overflow:auto;padding:20px}
.mbox h3{font-size:18px;margin-bottom:4px;word-break:break-word}
.mbox .meta{font-size:12px;color:#94a3b8;margin-bottom:12px;word-break:break-word}
.mbox pre{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6;font-family:inherit}
.mclose{margin-top:16px;width:100%}
.note{margin-top:16px;font-size:12px;color:#64748b;text-align:center}
.spin{display:inline-block;width:14px;height:14px;border:2px solid #475569;border-top-color:#7dd3fc;border-radius:50%;animation:s 1s linear infinite;vertical-align:-2px}
@keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <h1>📩 TempMail</h1>
  <div class="sub">Email sementara di <b>__DOMAIN__</b> — gratis, tanpa daftar.</div>

  <div class="addrbox">
    <div class="addr" id="addr">…</div>
    <div class="row">
      <button onclick="copyAddr()">📋 Salin</button>
      <button class="ghost" onclick="newAddr()">🔄 Alamat Baru</button>
    </div>
    <div class="custom">
      <input id="prefix" placeholder="nama sendiri, mis: belanja123" maxlength="64">
      <button class="ghost" onclick="useCustom()">Pakai</button>
    </div>
  </div>

  <div class="inbox">
    <div class="inboxhead">
      <h2>Kotak Masuk</h2>
      <span id="count"></span>
    </div>
    <div id="list"><div class="empty">Menunggu email… <span class="spin"></span></div></div>
  </div>

  <div class="note">Email terhapus otomatis setelah 2 jam. Jangan pakai untuk hal penting.</div>
</div>

<div class="modal" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="mbox">
    <h3 id="mSubj"></h3>
    <div class="meta" id="mMeta"></div>
    <pre id="mBody"></pre>
    <button class="mclose ghost" onclick="closeModal()">Tutup</button>
  </div>
</div>

<script>
const DOMAIN = "__DOMAIN__";
let address = localStorage.getItem("tm_addr") || (rand() + "@" + DOMAIN);
function rand(){ return Math.random().toString(36).slice(2,10); }
function render(){ document.getElementById("addr").textContent = address; }
function copyAddr(){
  navigator.clipboard.writeText(address).then(()=>alert("Alamat tersalin!"));
}
function newAddr(){
  address = rand() + "@" + DOMAIN;
  localStorage.setItem("tm_addr", address);
  render(); load();
}
function useCustom(){
  const p = document.getElementById("prefix").value.trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
  if(!p){ alert("Isi nama dulu ya"); return; }
  address = p + "@" + DOMAIN;
  localStorage.setItem("tm_addr", address);
  render(); load();
}
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
async function load(){
  try{
    const r = await fetch("/api/inbox?address=" + encodeURIComponent(address));
    const j = await r.json();
    const list = document.getElementById("list");
    document.getElementById("count").textContent = j.emails.length + " email";
    if(!j.emails.length){
      list.innerHTML = '<div class="empty">Belum ada email. Coba kirim ke alamat di atas.</div>';
      return;
    }
    list.innerHTML = j.emails.map(e =>
      '<div class="mail" onclick="readMail(\\'' + e.id + '\\')">' +
      '<div class="from">' + esc(e.from) + '</div>' +
      '<div class="subj">' + esc(e.subject) + '</div>' +
      '<div class="date">' + esc(e.date) + '</div></div>'
    ).join("");
  }catch(e){}
}
async function readMail(id){
  const r = await fetch("/api/read?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(id));
  const j = await r.json();
  if(j.error){ alert("Email tidak ditemukan / sudah kedaluwarsa"); return; }
  document.getElementById("mSubj").textContent = j.subject;
  document.getElementById("mMeta").textContent = "Dari: " + j.from + " • " + j.date;
  document.getElementById("mBody").textContent = j.body || "(kosong)";
  document.getElementById("modal").classList.add("open");
}
function closeModal(){ document.getElementById("modal").classList.remove("open"); }
render(); load();
setInterval(load, 5000);
</script>
</body>
</html>`;

export default {
  async email(message, env, ctx) {
    ctx.waitUntil(handleEmail(message, env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const domain = env.DOMAIN || "celana-ar-store.my.id";

    if (url.pathname === "/api/inbox") {
      const address = (url.searchParams.get("address") || "").toLowerCase().trim();
      if (!validAddress(address, domain)) return json({ error: "alamat tidak valid" }, 400);
      let idx = [];
      try {
        idx = JSON.parse((await env.INBOX.get("idx:" + address)) || "[]");
      } catch {}
      return json({ emails: idx });
    }

    if (url.pathname === "/api/read") {
      const address = (url.searchParams.get("address") || "").toLowerCase().trim();
      const id = (url.searchParams.get("id") || "").trim();
      if (!validAddress(address, domain) || !/^[a-z0-9]+$/i.test(id))
        return json({ error: "invalid" }, 400);
      let idx = [];
      try {
        idx = JSON.parse((await env.INBOX.get("idx:" + address)) || "[]");
      } catch {}
      if (!idx.some((e) => e.id === id)) return json({ error: "not found" }, 404);
      const raw = await env.INBOX.get("msg:" + id);
      if (!raw) return json({ error: "expired" }, 410);
      return json(JSON.parse(raw));
    }

    return new Response(PAGE.split("__DOMAIN__").join(domain), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
