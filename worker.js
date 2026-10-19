/**
 * TempMail Worker — celana-ar-store.my.id
 *
 * 1. Email masuk via Cloudflare Email Routing (catch-all -> "Send to a Worker")
 *    disimpan ke KV, otomatis terhapus setelah 2 jam (expirationTtl).
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
:root{
  --bg:#f1f5f9; --card:#ffffff; --text:#0f172a; --muted:#64748b;
  --border:#e2e8f0; --primary:#4f46e5; --primary-d:#4338ca; --soft:#eef2ff;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.topbar{background:var(--card);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
.topbar-in{max-width:760px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:10px}
.logo{font-size:24px}
.brand{font-size:18px;font-weight:800}
.domain-pill{margin-left:auto;font-size:12px;color:var(--primary);background:var(--soft);padding:5px 12px;border-radius:999px;font-weight:600}
.wrap{max-width:760px;margin:0 auto;padding:24px 20px 48px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(15,23,42,.06)}
.label{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.addr{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:19px;font-weight:700;color:var(--primary-d);word-break:break-all;background:var(--soft);border:1px dashed #c7d2fe;border-radius:10px;padding:12px 14px;margin-bottom:14px}
.btnrow{display:flex;gap:10px;flex-wrap:wrap}
button{border:none;cursor:pointer;font-size:14px;font-weight:700;border-radius:10px;padding:11px 18px;transition:transform .08s,box-shadow .15s,background .15s}
button:active{transform:scale(.97)}
.btn-p{background:var(--primary);color:#fff;box-shadow:0 2px 8px rgba(79,70,229,.35)}
.btn-p:hover{background:var(--primary-d)}
.btn-s{background:#f1f5f9;color:var(--text);border:1px solid var(--border)}
.btn-s:hover{background:#e2e8f0}
.customrow{display:flex;gap:10px;margin-top:14px}
.customrow input{flex:1;border:1px solid var(--border);border-radius:10px;padding:11px 14px;font-size:14px;outline:none;background:#fbfdff}
.customrow input:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--soft)}
.inbox-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.inbox-head h2{font-size:17px;font-weight:800}
.badge{background:var(--soft);color:var(--primary-d);font-size:12px;font-weight:700;border-radius:999px;padding:3px 11px}
.live{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.mail{display:flex;gap:13px;align-items:center;padding:14px 6px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:10px}
.mail:last-child{border-bottom:none}
.mail:hover{background:#f8fafc}
.avatar{flex:none;width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#818cf8,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px}
.minfo{flex:1;min-width:0}
.mfrom{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msubj{font-size:13.5px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.mdate{font-size:12px;color:var(--muted);white-space:nowrap}
.chev{color:#cbd5e1;font-size:18px;flex:none}
.empty{text-align:center;padding:44px 16px;color:var(--muted)}
.empty svg{margin-bottom:12px;opacity:.5}
.empty p{font-size:14px}
.modal{position:fixed;inset:0;background:rgba(15,23,42,.5);backdrop-filter:blur(2px);display:none;align-items:center;justify-content:center;padding:18px;z-index:20}
.modal.open{display:flex;animation:fade .15s}
@keyframes fade{from{opacity:0}}
.mbox{background:#fff;border-radius:18px;max-width:640px;width:100%;max-height:86vh;overflow:auto;box-shadow:0 20px 60px rgba(15,23,42,.25)}
.mhead{padding:20px 22px 0}
.mhead h3{font-size:18px;margin-bottom:6px;word-break:break-word}
.mmeta{font-size:12.5px;color:var(--muted);word-break:break-word}
.mbody{padding:16px 22px;font-size:14.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#1e293b}
.mfoot{padding:0 22px 20px}
.mfoot button{width:100%}
.toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);background:#0f172a;color:#fff;font-size:14px;font-weight:600;padding:12px 22px;border-radius:999px;opacity:0;pointer-events:none;transition:all .25s;z-index:30;box-shadow:0 8px 24px rgba(15,23,42,.3)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.note{text-align:center;font-size:12.5px;color:var(--muted);margin-top:6px}
.note b{color:#b45309}
@media(max-width:520px){.addr{font-size:15px}.mdate{display:none}}
</style>
</head>
<body>
<div class="topbar"><div class="topbar-in">
  <span class="logo">📩</span><span class="brand">TempMail</span>
  <span class="domain-pill">__DOMAIN__</span>
</div></div>

<div class="wrap">
  <div class="card">
    <div class="label">Alamat email sementara kamu</div>
    <div class="addr" id="addr">…</div>
    <div class="btnrow">
      <button class="btn-p" onclick="copyAddr()">📋 Salin Alamat</button>
      <button class="btn-s" onclick="newAddr()">🔄 Alamat Baru</button>
    </div>
    <div class="customrow">
      <input id="prefix" placeholder="Atau bikin nama sendiri, mis: belanja123" maxlength="64">
      <button class="btn-s" onclick="useCustom()">Pakai</button>
    </div>
  </div>

  <div class="card">
    <div class="inbox-head">
      <h2>Kotak Masuk</h2><span class="badge" id="count">0</span>
      <span class="live"><span class="dot"></span>auto-refresh</span>
    </div>
    <div id="list"></div>
  </div>

  <div class="note">⏱️ Email terhapus otomatis setelah <b>2 jam</b>. Jangan pakai untuk hal penting.</div>
</div>

<div class="modal" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="mbox">
    <div class="mhead"><h3 id="mSubj"></h3><div class="mmeta" id="mMeta"></div></div>
    <div class="mbody" id="mBody"></div>
    <div class="mfoot"><button class="btn-s" onclick="closeModal()">Tutup</button></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const DOMAIN = "__DOMAIN__";
let address = localStorage.getItem("tm_addr") || (rand() + "@" + DOMAIN);
function rand(){ return Math.random().toString(36).slice(2,10); }
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove("show"), 2200);
}
function render(){ document.getElementById("addr").textContent = address; }
function copyAddr(){
  const done = ()=>toast("Alamat disalin! 📋");
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(address).then(done).catch(()=>fallbackCopy(done));
  } else fallbackCopy(done);
}
function fallbackCopy(done){
  const ta = document.createElement("textarea");
  ta.value = address; document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); done(); }catch(e){}
  document.body.removeChild(ta);
}
function newAddr(){
  address = rand() + "@" + DOMAIN;
  localStorage.setItem("tm_addr", address);
  render(); load(); toast("Alamat baru dibuat 🔄");
}
function useCustom(){
  const p = document.getElementById("prefix").value.trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
  if(!p){ toast("Isi nama dulu ya"); return; }
  address = p + "@" + DOMAIN;
  localStorage.setItem("tm_addr", address);
  document.getElementById("prefix").value = "";
  render(); load(); toast("Alamat dipakai ✓");
}
function avatarColor(from){
  let h = 0; for(const c of from) h = (h*31 + c.charCodeAt(0)) % 360;
  return "linear-gradient(135deg,hsl("+h+",65%,62%),hsl("+((h+40)%360)+",60%,45%))";
}
function initialOf(from){
  const m = /([a-zA-Z0-9])/.exec(from);
  return m ? m[1].toUpperCase() : "?";
}
async function load(){
  try{
    const r = await fetch("/api/inbox?address=" + encodeURIComponent(address));
    const j = await r.json();
    const list = document.getElementById("list");
    document.getElementById("count").textContent = j.emails.length;
    if(!j.emails.length){
      list.innerHTML = '<div class="empty">' +
        '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>' +
        '<p>Belum ada email.<br>Kirim ke alamat di atas, nanti muncul di sini.</p></div>';
      return;
    }
    list.innerHTML = j.emails.map(e =>
      '<div class="mail" onclick="readMail(\\'' + e.id + '\\')">' +
      '<div class="avatar" style="background:' + avatarColor(esc(e.from)) + '">' + initialOf(esc(e.from)) + '</div>' +
      '<div class="minfo"><div class="mfrom">' + esc(e.from) + '</div>' +
      '<div class="msubj">' + esc(e.subject) + '</div></div>' +
      '<div class="mdate">' + esc(e.date) + '</div><div class="chev">›</div></div>'
    ).join("");
  }catch(e){}
}
async function readMail(id){
  const r = await fetch("/api/read?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(id));
  const j = await r.json();
  if(j.error){ toast("Email tidak ditemukan / kedaluwarsa"); load(); return; }
  document.getElementById("mSubj").textContent = j.subject;
  document.getElementById("mMeta").textContent = "Dari: " + j.from + (j.date ? " • " + j.date : "");
  document.getElementById("mBody").textContent = j.body || "(kosong)";
  document.getElementById("modal").classList.add("open");
}
function closeModal(){ document.getElementById("modal").classList.remove("open"); }
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeModal(); });
render(); load();
setInterval(load, 8000);
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
