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

const PAGE = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TempMail — __DOMAIN__</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg0:#04060d; --bg1:#0a0f1e;
  --stroke:rgba(148,163,184,.14);
  --txt:#e9eefb; --mut:#8b98b8;
  --ind:#6366f1; --cy:#22d3ee;
  --grad:linear-gradient(135deg,#6366f1 0%,#22d3ee 100%);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Inter','Segoe UI',system-ui,-apple-system,Roboto,sans-serif;
  background:var(--bg0);color:var(--txt);min-height:100vh;overflow-x:hidden;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
/* ---------- background statis (LITE: tanpa blur, tanpa animasi drift) ---------- */
.bg{position:fixed;inset:0;z-index:-2;overflow:hidden;background:radial-gradient(1200px 800px at 50% -10%,#0d1530 0%,var(--bg0) 60%)}
.orb{position:absolute;border-radius:50%;opacity:.5}
.o1{width:480px;height:480px;top:-140px;left:-120px;background:radial-gradient(circle,rgba(79,70,229,.5) 0%,transparent 70%)}
.o2{width:420px;height:420px;bottom:-160px;right:-100px;background:radial-gradient(circle,rgba(14,116,144,.45) 0%,transparent 70%)}
.o3{width:300px;height:300px;top:38%;left:58%;opacity:.32;background:radial-gradient(circle,rgba(124,58,237,.45) 0%,transparent 70%)}
.grid{position:absolute;inset:0;
  background-image:linear-gradient(rgba(148,163,184,.05) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(148,163,184,.05) 1px,transparent 1px);
  background-size:44px 44px;
  -webkit-mask-image:radial-gradient(700px 480px at 50% 0%,#000 30%,transparent 75%);
          mask-image:radial-gradient(700px 480px at 50% 0%,#000 30%,transparent 75%)}
/* ---------- topbar (LITE: tanpa backdrop-filter) ---------- */
.topbar{position:sticky;top:0;z-index:10;
  background:rgba(4,6,13,.94);border-bottom:1px solid var(--stroke)}
.topbar-in{max-width:780px;margin:0 auto;padding:13px 20px;display:flex;align-items:center;gap:11px}
.logo-anim{animation:float 3.4s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-5px) rotate(4deg)}}
.brand{font-family:'Inter',sans-serif;font-size:20px;font-weight:700;letter-spacing:.02em}
.brand em{font-style:normal;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.ver{font-size:10px;font-weight:800;color:#04060d;background:var(--grad);border-radius:6px;padding:3px 7px;letter-spacing:.08em}
.clock{margin-left:auto;font-size:14px;color:#fff;background:rgba(99,102,241,.14);
  border:1px solid rgba(99,102,241,.35);padding:6px 15px;border-radius:999px;font-weight:700;
  font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:.06em;
  box-shadow:0 0 18px rgba(99,102,241,.25) inset;white-space:nowrap;text-shadow:0 0 12px rgba(165,180,252,.5)}
/* ---------- layout ---------- */
.wrap{max-width:780px;margin:0 auto;padding:28px 20px 60px}
.card{background:rgba(13,19,36,.94);border:1px solid var(--stroke);border-radius:20px;
  padding:24px;margin-bottom:18px;
  box-shadow:0 12px 40px rgba(0,0,0,.35);transition:transform .25s,box-shadow .25s}
.card:hover{transform:translateY(-2px);box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(99,102,241,.12)}
.rise{animation:rise .8s cubic-bezier(.16,.8,.24,1) both}
@keyframes rise{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}
.label{font-family:'Inter',sans-serif;font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
  background:linear-gradient(90deg,#a5b4fc,#67e8f9);-webkit-background-clip:text;background-clip:text;color:transparent;
  margin-bottom:14px;display:flex;align-items:center;gap:8px}
.label::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--stroke),transparent)}
/* ---------- address (LITE: border gradient statis, tanpa animasi spinborder) ---------- */
.addrbox{position:relative;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;
  font-size:clamp(16px,3.8vw,23px);font-weight:700;letter-spacing:.01em;word-break:break-all;cursor:pointer;
  background:rgba(4,6,13,.55);border:1px solid rgba(99,102,241,.4);border-radius:14px;
  padding:16px 18px;margin-bottom:16px;color:#fff;
  box-shadow:0 0 28px rgba(99,102,241,.18) inset,0 0 24px rgba(99,102,241,.1);
  transition:box-shadow .2s,border-color .2s}
.addrbox:hover{border-color:var(--cy);box-shadow:0 0 28px rgba(34,211,238,.22) inset,0 0 30px rgba(34,211,238,.14)}
.addrbox .dom{color:#7d8db4;font-weight:500}
.addrbox::before{content:"";position:absolute;inset:-1px;border-radius:14px;padding:1.5px;
  background:linear-gradient(135deg,rgba(99,102,241,.9),rgba(34,211,238,.9),rgba(168,85,247,.9),rgba(99,102,241,.9));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.btnrow{display:flex;gap:10px;flex-wrap:wrap}
button{border:none;cursor:pointer;font-size:14px;font-weight:700;border-radius:12px;padding:12px 20px;
  transition:transform .1s,box-shadow .2s,background .2s,filter .2s;font-family:inherit}
button:active{transform:scale(.96)}
.btn-p{position:relative;overflow:hidden;background:var(--grad);color:#fff;
  box-shadow:0 4px 22px rgba(99,102,241,.45)}
.btn-p:hover{filter:brightness(1.1);box-shadow:0 6px 28px rgba(34,211,238,.4)}
.btn-p::after{content:"";position:absolute;top:0;left:-80%;width:50%;height:100%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.4),transparent);
  transform:skewX(-20deg);transition:left .5s}
.btn-p:hover::after{left:130%}
.btn-p.done{background:linear-gradient(135deg,#16a34a,#22c55e);box-shadow:0 4px 22px rgba(34,197,94,.4)}
.btn-s{background:rgba(148,163,184,.1);color:var(--txt);border:1px solid var(--stroke)}
.btn-s:hover{background:rgba(148,163,184,.2);border-color:rgba(148,163,184,.3)}
.customrow{display:flex;gap:10px;margin-top:14px}
.customrow input{flex:1;border:1px solid var(--stroke);border-radius:12px;padding:12px 15px;font-size:14px;
  outline:none;background:rgba(4,6,13,.5);color:var(--txt);font-family:inherit;transition:border-color .2s,box-shadow .2s}
.customrow input:focus{border-color:var(--ind);box-shadow:0 0 0 3px rgba(99,102,241,.25)}
.customrow input::placeholder{color:#5b6a8c}
.domsel{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.domsel button{flex:1;min-width:0;background:rgba(148,163,184,.08);border:1px solid var(--stroke);color:var(--mut);
  font-size:12.5px;font-weight:700;padding:9px 10px;border-radius:999px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.domsel button.on{background:var(--grad);color:#fff;border-color:transparent;box-shadow:0 2px 14px rgba(99,102,241,.45)}
/* ---------- stats (LITE: tanpa backdrop-filter) ---------- */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
.stat{background:rgba(13,19,36,.94);border:1px solid var(--stroke);border-radius:14px;padding:13px 8px;
  text-align:center;animation:rise .8s cubic-bezier(.16,.8,.24,1) both}
.stat .ic{font-size:20px;display:block;margin-bottom:5px}
.stat .t{font-size:11.5px;color:var(--mut);font-weight:600;line-height:1.4}
/* ---------- inbox ---------- */
.inbox-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.inbox-head h2{font-family:'Inter',sans-serif;font-size:20px;font-weight:700;letter-spacing:.01em;
  background:linear-gradient(90deg,#fff,#a5b4fc);-webkit-background-clip:text;background-clip:text;color:transparent}
.badge{background:var(--grad);color:#fff;font-size:12px;font-weight:800;border-radius:999px;
  padding:4px 12px;min-width:30px;text-align:center;box-shadow:0 2px 12px rgba(99,102,241,.5)}
.live{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut);font-weight:600}
.head-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.refresh{width:32px;height:32px;border-radius:50%;background:rgba(148,163,184,.1);border:1px solid var(--stroke);
  color:var(--txt);font-size:17px;padding:0;display:flex;align-items:center;justify-content:center}
.refresh:hover{background:rgba(99,102,241,.25);border-color:var(--ind)}
.refresh.spin{animation:spin .7s linear}
@keyframes spin{to{transform:rotate(360deg)}}
.rings{position:relative;width:12px;height:12px}
.rings i{position:absolute;inset:0;border-radius:50%;background:#22c55e}
.rings i:last-child{animation:ring 1.8s ease-out infinite;background:transparent;border:2px solid #22c55e}
@keyframes ring{from{transform:scale(.5);opacity:1}to{transform:scale(2.1);opacity:0}}
.mail{display:flex;gap:13px;align-items:center;flex-wrap:wrap;padding:14px 12px;border-bottom:1px solid rgba(148,163,184,.1);
  cursor:pointer;border-radius:12px;border-left:3px solid transparent;
  animation:rowin .5s cubic-bezier(.16,.8,.24,1) both;transition:background .15s,transform .15s,border-color .2s,box-shadow .2s}
.expbar{flex:1 1 100%}
.mail:last-child{border-bottom:none}
.mail:hover{background:rgba(99,102,241,.1);transform:translateX(4px);border-left-color:var(--cy);
  box-shadow:-4px 0 18px rgba(34,211,238,.25)}
@keyframes rowin{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}
.avatar{flex:none;width:44px;height:44px;border-radius:50%;color:#fff;display:flex;align-items:center;
  justify-content:center;font-weight:800;font-size:17px;font-family:'Inter',sans-serif;
  box-shadow:0 0 0 2px rgba(255,255,255,.1),0 0 18px rgba(99,102,241,.35),0 4px 14px rgba(0,0,0,.4)}
.minfo{flex:1;min-width:0}
.mfrom{font-weight:800;font-size:14.5px;color:#ffffff;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  text-shadow:0 0 20px rgba(255,255,255,.12)}
.msubj{font-size:13.5px;font-weight:500;color:#c3cee9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.mdate{font-family:ui-monospace,monospace;font-size:12px;font-weight:700;color:#67e8f9;
  white-space:nowrap;flex:none;letter-spacing:.03em;text-shadow:0 0 10px rgba(103,232,249,.35)}
.chev{color:#3d4a6b;font-size:20px;flex:none;transition:transform .15s,color .15s}
.mail:hover .chev{transform:translateX(4px);color:var(--cy)}
.searchrow{margin:2px 0 8px}
.searchrow input{width:100%;border:1px solid var(--stroke);border-radius:10px;padding:10px 14px;font-size:13.5px;
  background:rgba(4,6,13,.5);color:var(--txt);outline:none;font-family:inherit;transition:border-color .2s,box-shadow .2s}
.searchrow input:focus{border-color:var(--ind);box-shadow:0 0 0 3px rgba(99,102,241,.2)}
.mright{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.cd{font-size:11px;color:#fbbf24;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.delbtn{flex:none;width:30px;height:30px;border-radius:50%;background:rgba(148,163,184,.07);border:1px solid var(--stroke);
  color:#8b98b8;font-size:12px;padding:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.delbtn:hover{background:rgba(248,113,113,.2);border-color:rgba(248,113,113,.45);color:#fca5a5;transform:scale(1.08)}
.mail.fresh{animation:freshglow 2.4s ease-out}
@keyframes freshglow{0%{background:rgba(34,211,238,.2)}100%{background:transparent}}
.shake{animation:shake .6s}
@keyframes shake{0%,100%{transform:rotate(0)}20%{transform:rotate(-18deg)}40%{transform:rotate(14deg)}
  60%{transform:rotate(-10deg)}80%{transform:rotate(6deg)}}
.expbar{height:3px;border-radius:99px;background:rgba(148,163,184,.15);margin-top:7px;overflow:hidden}
.expbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#22d3ee,#6366f1);
  transition:width 1s linear;box-shadow:0 0 8px rgba(34,211,238,.6)}
/* skeleton */
.skel{border-radius:12px;padding:14px 10px;border-bottom:1px solid rgba(148,163,184,.08)}
.skel div{height:14px;border-radius:7px;background:linear-gradient(90deg,rgba(148,163,184,.1) 25%,rgba(148,163,184,.22) 50%,rgba(148,163,184,.1) 75%);
  background-size:200% 100%;animation:shimmer 1.3s infinite;margin-bottom:9px}
.skel div:last-child{margin-bottom:0;width:60%}
@keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
/* empty */
.empty{text-align:center;padding:48px 16px;color:var(--mut)}
.empty .big{animation:float 4s ease-in-out infinite;display:inline-block}
.empty p{font-size:14px;margin-top:14px;line-height:1.7}
/* ---------- modal (LITE: tanpa backdrop-filter) ---------- */
.modal{position:fixed;inset:0;background:rgba(2,4,10,.84);
  display:none;align-items:center;justify-content:center;padding:18px;z-index:50}
.modal.open{display:flex}
.mbox{background:#0b1120;border:1px solid var(--stroke);border-radius:20px;max-width:640px;width:100%;
  max-height:86vh;overflow:auto;box-shadow:0 30px 80px rgba(0,0,0,.6);position:relative;
  animation:pop .28s cubic-bezier(.2,1.4,.4,1) both}
@keyframes pop{from{opacity:0;transform:scale(.92) translateY(14px)}to{opacity:1;transform:none}}
.mbox::before{content:"";position:absolute;top:0;left:24px;right:24px;height:3px;border-radius:0 0 4px 4px;background:var(--grad)}
.mhead{padding:26px 24px 0}
.mhead h3{font-size:18px;margin-bottom:8px;word-break:break-word;line-height:1.45}
.mmeta{font-size:12.5px;color:var(--mut);word-break:break-word;line-height:1.7;white-space:pre-line}
.mbody{padding:18px 24px;font-size:14.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;color:#cdd7ee}
.mfoot{padding:0 24px 24px}
.mfoot button{width:100%}
.x{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;background:rgba(148,163,184,.12);
  color:var(--mut);font-size:15px;padding:0;line-height:1}
.x:hover{background:rgba(248,113,113,.2);color:#fca5a5}
/* ---------- toast (LITE: tanpa backdrop-filter) ---------- */
.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(24px);
  background:rgba(11,17,32,.96);border:1px solid rgba(99,102,241,.45);color:#fff;font-size:14px;font-weight:600;
  padding:13px 24px;border-radius:999px;opacity:0;pointer-events:none;transition:all .3s cubic-bezier(.2,1,.4,1);
  z-index:60;box-shadow:0 10px 34px rgba(0,0,0,.5),0 0 20px rgba(99,102,241,.25);white-space:nowrap}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.note{text-align:center;font-size:12.5px;color:var(--mut);margin-top:4px}
.note b{color:#fbbf24}

@media(max-width:560px){.mdate{display:none}.stats{grid-template-columns:repeat(3,1fr)}.stat .t{font-size:10px}}
</style>
</head>
<body>
<div class="bg"><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div><div class="grid"></div></div>

<div class="topbar"><div class="topbar-in">
  <svg class="logo-anim" width="30" height="30" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="5" width="18" height="14" rx="3" stroke="url(#lg)" stroke-width="1.8"/>
    <path d="M4.5 7.5l7.5 5.5 7.5-5.5" stroke="url(#lg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <defs><linearGradient id="lg" x1="3" y1="5" x2="21" y2="19"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
  </svg>
  <span class="brand">Temp<em>Mail</em></span><span class="ver">PRO</span>
  <span class="clock" id="clock">--.--.--</span>
</div></div>

<div class="wrap">
  <div class="card rise" style="animation-delay:.05s">
    <div class="label">⚡ Alamat email sementara</div>
    <div class="addrbox" id="addr" onclick="copyAddr(this)" title="Klik untuk salin">…</div>
    <div class="domsel" id="domsel"></div>
    <div class="btnrow">
      <button class="btn-p" id="copyBtn" onclick="copyAddr(this)">📋 Salin Alamat</button>
      <button class="btn-s" onclick="newAddr()">🎲 Alamat Baru</button>
    </div>
    <div class="customrow">
      <input id="prefix" placeholder="Atau bikin nama sendiri, mis: belanja123" maxlength="64" onkeydown="if(event.key==='Enter')useCustom()">
      <button class="btn-s" onclick="useCustom()">Pakai</button>
    </div>
  </div>

  <div class="stats">
    <div class="stat" style="animation-delay:.15s"><span class="ic">⚡</span><span class="t">Instan<br>tanpa daftar</span></div>
    <div class="stat" style="animation-delay:.25s"><span class="ic">🕐</span><span class="t">Hapus otomatis<br>setelah 2 jam</span></div>
    <div class="stat" style="animation-delay:.35s"><span class="ic">🛡️</span><span class="t">100% gratis<br>tanpa kartu</span></div>
  </div>

  <div class="card rise" style="animation-delay:.45s">
    <div class="inbox-head">
      <h2>Kotak Masuk</h2><span class="badge" id="count">0</span>
      <span class="head-right">
        <button class="refresh" id="muteBtn" onclick="toggleMute()" title="Suara notifikasi">🔔</button>
        <button class="refresh" id="refreshBtn" onclick="manualRefresh()" title="Refresh inbox">↻</button>
        <span class="live"><span class="rings"><i></i><i></i></span>live</span>
      </span>
    </div>
    <div class="searchrow"><input id="q" placeholder="🔍 Cari pengirim / subjek..." oninput="paint()"></div>
    <div id="list"></div>
  </div>

  <div class="note">⏱️ Email terhapus otomatis setelah <b>2 jam</b>. Jangan pakai untuk hal penting.</div>
</div>

<div class="modal" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="mbox">
    <button class="x" onclick="closeModal()">✕</button>
    <div class="mhead"><h3 id="mSubj"></h3><div class="mmeta" id="mMeta"></div></div>
    <div class="mbody" id="mBody"></div>
    <div class="mfoot"><button class="btn-s" onclick="closeModal()">Tutup</button></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const DOMAINS = "__DOMAINS__".split(",");
let domain = localStorage.getItem("tm_dom");
let address = localStorage.getItem("tm_addr");
const _ad = address ? address.split("@")[1] : null;
if(!domain || DOMAINS.indexOf(domain) === -1) domain = (_ad && DOMAINS.indexOf(_ad) !== -1) ? _ad : DOMAINS[0];
if(!address || address.split("@")[1] !== domain){ address = rand() + "@" + domain; localStorage.setItem("tm_addr", address); }
function renderDomSel(){
  document.getElementById("domsel").innerHTML = DOMAINS.map(function(d){
    return '<button class="' + (d === domain ? "on" : "") + '" onclick="setDomain(\\'' + d + '\\')">' + esc(d) + "</button>";
  }).join("");
}
function setDomain(d){
  const local = address.split("@")[0];
  domain = d; address = local + "@" + d;
  localStorage.setItem("tm_dom", d); localStorage.setItem("tm_addr", address);
  resetInboxState(); renderDomSel(); renderAddr(true); load(); toast("🔄 Domain: " + d);
}
function rand(){ return Math.random().toString(36).slice(2,10); }
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove("show"); }, 2200);
}
function manualRefresh(){
  const b = document.getElementById("refreshBtn");
  b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin");
  load();
}
/* scramble reveal animation */
function scramble(el, text){
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const local = text.split("@")[0], dom = "@" + text.split("@")[1];
  let frame = 0; const total = 26;
  const iv = setInterval(function(){
    frame++;
    const p = frame / total, n = Math.floor(local.length * p);
    let out = local.slice(0, n);
    for(let i = n; i < local.length; i++) out += chars[Math.floor(Math.random()*chars.length)];
    el.innerHTML = esc(out) + '<span class="dom">' + esc(dom) + "</span>";
    if(frame >= total){
      el.innerHTML = esc(local) + '<span class="dom">' + esc(dom) + "</span>";
      clearInterval(iv);
    }
  }, 26);
}
function renderAddr(animate){
  const el = document.getElementById("addr");
  if(animate) scramble(el, address);
  else { const p = address.split("@"); el.innerHTML = esc(p[0]) + '<span class="dom">@' + esc(p[1]) + "</span>"; }
}
function copyAddr(btn){
  const done = function(){
    toast("✅ Alamat disalin ke clipboard");
    const b = document.getElementById("copyBtn");
    if(!b.classList.contains("done")){
      const old = b.innerHTML; b.classList.add("done"); b.innerHTML = "✓ Tersalin!";
      setTimeout(function(){ b.classList.remove("done"); b.innerHTML = old; }, 1600);
    }
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(address).then(done).catch(function(){ fallbackCopy(done); });
  } else fallbackCopy(done);
}
function fallbackCopy(done){
  const ta = document.createElement("textarea");
  ta.value = address; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); done(); }catch(e){}
  document.body.removeChild(ta);
}
function newAddr(){
  address = rand() + "@" + domain;
  localStorage.setItem("tm_addr", address);
  resetInboxState(); renderAddr(true); load(); toast("🎲 Alamat baru dibuat");
}
function useCustom(){
  const p = document.getElementById("prefix").value.trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
  if(!p){ toast("Isi nama dulu ya ✏️"); return; }
  address = p + "@" + domain;
  localStorage.setItem("tm_addr", address);
  document.getElementById("prefix").value = "";
  resetInboxState(); renderAddr(true); load(); toast("✨ Alamat dipakai");
}
function avatarGrad(from){
  let h = 0; for(let i = 0; i < from.length; i++) h = (h*31 + from.charCodeAt(i)) % 360;
  return "linear-gradient(135deg,hsl(" + h + ",70%,58%),hsl(" + ((h+50)%360) + ",65%,42%))";
}
function initialOf(from){
  const m = /([a-zA-Z0-9])/.exec(from);
  return m ? m[1].toUpperCase() : "?";
}
const ID_BULAN = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
const EN_MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function pad2(x){ return (x < 10 ? "0" + x : x); }
function fmtWIB(ms){
  const w = new Date(ms + 7 * 3600 * 1000);
  return w.getUTCDate() + " " + ID_BULAN[w.getUTCMonth()] + " " + w.getUTCFullYear() +
    ", " + pad2(w.getUTCHours()) + ":" + pad2(w.getUTCMinutes()) + ":" + pad2(w.getUTCSeconds()) + " WIB";
}
function toWIB(v){
  if(v === undefined || v === null || v === "") return "";
  if(typeof v === "number") return fmtWIB(v);
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if(!m) return s;
  const utc = Date.UTC(+m[3], EN_MON[m[2].toLowerCase()], +m[1], +m[4], +m[5], +(m[6] || 0));
  return fmtWIB(utc);
}
function toWIBshort(v){
  const f = toWIB(v);
  const m = f.match(/(\d{2}):(\d{2}):\d{2} WIB/);
  return m ? m[1] + "." + m[2] : f;
}
function countUp(el, to){
  const from = parseInt(el.textContent) || 0;
  if(from === to){ el.textContent = to; return; }
  const t0 = performance.now(), d = 450;
  (function tick(t){
    const p = Math.min(1, (t - t0) / d);
    el.textContent = Math.round(from + (to - from) * (p<.5 ? 2*p*p : 1-Math.pow(-2*p+2,2)/2));
    if(p < 1) requestAnimationFrame(tick);
  })(t0);
}
function skeleton(){
  let h = "";
  for(let i = 0; i < 3; i++) h += '<div class="skel"><div></div><div></div></div>';
  document.getElementById("list").innerHTML = h;
}
let firstLoad = true;
let cacheEmails = [];
const knownIds = new Set();
const freshIds = new Set();
let muted = localStorage.getItem("tm_mute") === "1";
function emptyHTML(){
  return '<div class="empty"><span class="big">' +
    '<svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="url(#eg)" stroke-width="1.3">' +
    '<rect x="3" y="5" width="18" height="14" rx="3"/>' +
    '<path d="M4.5 7.5l7.5 5.5 7.5-5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<defs><linearGradient id="eg" x1="3" y1="5" x2="21" y2="19"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs></svg></span>' +
    '<p>Belum ada email masuk.<br>Kirim ke alamat di atas — muncul di sini otomatis ✨</p></div>';
}
function paint(){
  const q = document.getElementById("q").value.trim().toLowerCase();
  const list = document.getElementById("list");
  countUp(document.getElementById("count"), cacheEmails.length);
  const emails = q ? cacheEmails.filter(function(e){ return (e.from + " " + e.subject).toLowerCase().indexOf(q) !== -1; }) : cacheEmails;
  if(!emails.length){
    list.innerHTML = cacheEmails.length ? '<div class="empty"><p>Tidak ketemu.<br>Coba kata kunci lain 🔍</p></div>' : emptyHTML();
    return;
  }
  list.innerHTML = emails.map(function(e, i){
    const fresh = freshIds.has(e.id) ? " fresh" : "";
    const exp = e.expiresAt ? ' data-exp="' + e.expiresAt + '"' : "";
    return '<div class="mail' + fresh + '" style="animation-delay:' + (i*60) + 'ms" onclick="readMail(\\'' + e.id + '\\')">' +
    '<div class="avatar" style="background:' + avatarGrad(e.from) + '">' + initialOf(esc(e.from)) + '</div>' +
    '<div class="minfo"><div class="mfrom">' + esc(e.from) + '</div>' +
    '<div class="msubj">' + esc(e.subject) + '</div></div>' +
    '<div class="mright"><div class="mdate">' + esc(toWIBshort(e.date)) + ' WIB</div><div class="cd"' + exp + '></div></div>' +
    '<button class="delbtn" onclick="event.stopPropagation();deleteMail(\\'' + e.id + '\\')" title="Hapus email">✕</button>' +
    (e.expiresAt ? '<div class="expbar"><i data-expbar="' + e.expiresAt + '"></i></div>' : '') + '</div>';
  }).join("");
}
function ding(){
  if(muted) return;
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    [[880, 0], [1318, 0.12]].forEach(function(pair){
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = "sine"; o.frequency.value = pair[0];
      const t = ctx.currentTime + pair[1];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.start(t); o.stop(t + 0.5);
    });
  }catch(e){}
}
function toggleMute(){
  muted = !muted;
  localStorage.setItem("tm_mute", muted ? "1" : "0");
  document.getElementById("muteBtn").textContent = muted ? "🔕" : "🔔";
  toast(muted ? "🔕 Suara notifikasi mati" : "🔔 Suara notifikasi nyala");
}
async function deleteMail(id){
  try{
    const r = await fetch("/api/delete?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(id), { method: "DELETE" });
    const j = await r.json();
    if(j.ok){
      knownIds.delete(id); freshIds.delete(id);
      cacheEmails = cacheEmails.filter(function(e){ return e.id !== id; });
      paint(); toast("🗑️ Email dihapus");
    } else toast("⚠️ Gagal menghapus");
  }catch(e){ toast("⚠️ Gagal menghapus"); }
}
function resetInboxState(){
  knownIds.clear(); freshIds.clear(); cacheEmails = [];
  const q = document.getElementById("q"); if(q) q.value = "";
}
async function load(){
  if(firstLoad) skeleton();
  try{
    const r = await fetch("/api/inbox?address=" + encodeURIComponent(address));
    const j = await r.json();
    let hasNew = false;
    j.emails.forEach(function(e){
      if(!knownIds.has(e.id)){
        knownIds.add(e.id);
        if(!firstLoad){ freshIds.add(e.id); hasNew = true; }
      }
    });
    cacheEmails = j.emails;
    paint();
    if(hasNew){
      ding(); toast("📩 Email baru masuk!");
      const bell = document.getElementById("muteBtn");
      bell.classList.remove("shake"); void bell.offsetWidth; bell.classList.add("shake");
      setTimeout(function(){ freshIds.clear(); paint(); }, 2500);
    }
  }catch(e){
    if(firstLoad) document.getElementById("list").innerHTML = '<div class="empty"><p>Gagal memuat. Cek koneksi lalu refresh 🔄</p></div>';
  }
  firstLoad = false;
}
setInterval(function(){
  const now = Date.now();
  const els = document.querySelectorAll(".cd[data-exp]");
  for(let i = 0; i < els.length; i++){
    const exp = parseInt(els[i].getAttribute("data-exp"), 10) || 0;
    let s = Math.max(0, Math.floor((exp - now) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    els[i].textContent = "⏱" + h + ":" + (m < 10 ? "0" + m : m) + ":" + (ss < 10 ? "0" + ss : ss);
  }
  const bars = document.querySelectorAll(".expbar i[data-expbar]");
  for(let i = 0; i < bars.length; i++){
    const exp = parseInt(bars[i].getAttribute("data-expbar"), 10) || 0;
    const pct = Math.max(0, Math.min(100, (exp - now) / 7200000 * 100));
    bars[i].style.width = pct + "%";
  }
}, 1000);
async function readMail(id){
  const r = await fetch("/api/read?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(id));
  const j = await r.json();
  if(j.error){ toast("⚠️ Email tidak ditemukan / kedaluwarsa"); load(); return; }
  document.getElementById("mSubj").textContent = j.subject;
  let meta = "Dari: " + j.from;
  if(j.date) meta += "\\n📤 Terkirim: " + toWIB(j.date);
  if(j.receivedAt) meta += "   •   📥 Diterima web: " + toWIB(j.receivedAt);
  document.getElementById("mMeta").textContent = meta;
  document.getElementById("mBody").textContent = j.body || "(kosong)";
  document.getElementById("modal").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeModal(){
  document.getElementById("modal").classList.remove("open");
  document.body.style.overflow = "";
}
document.addEventListener("keydown", function(e){ if(e.key === "Escape") closeModal(); });
function tickClock(){
  const el = document.getElementById("clock");
  if(!el) return;
  const w = new Date(Date.now() + 7 * 3600 * 1000);
  el.textContent = pad2(w.getUTCHours()) + "." + pad2(w.getUTCMinutes()) + "." + pad2(w.getUTCSeconds()) + " WIB";
}
renderDomSel(); renderAddr(true);
document.getElementById("muteBtn").textContent = muted ? "🔕" : "🔔";
tickClock(); setInterval(tickClock, 1000);
load();
setInterval(load, 8000);
document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible") load(); });
</script>
</body>
</html>
`;

/* ---------------- lite HTML version (tanpa JS, tanpa aset eksternal) ----------------
   Tujuan: buka inbox di HP tetap enteng. Semua render di server, halaman cuma
   HTML + CSS inline kecil, tanpa font Google, tanpa animasi, tanpa polling.
   Rute:
     GET  /lite                          -> form alamat / inbox
     GET  /lite?address=a@d              -> inbox (20 pesan per halaman, ?p=0,1,2)
     GET  /lite?prefix=x&domain=d        -> redirect ke /lite?address=x@d
     GET  /lite?random=1&domain=d        -> redirect ke alamat acak
     GET  /lite/read?address=a@d&id=xx   -> isi email lengkap
     POST /lite/delete                   -> hapus lalu redirect balik ke inbox
   UI utama (/) dan API JSON (/api/*) tidak diubah sama sekali. */

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
  return "<!DOCTYPE html>\n<html lang=\"id\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>" + escHtml(title) + " — TempMail Lite</title>\n<style>" + LITE_CSS + "</style>\n</head>\n<body>\n<main>\n" + body + "\n</main>\n</body>\n</html>";
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
  let body = "<h1>TempMail Lite</h1><p>Versi ringan, tanpa animasi dan tanpa refresh otomatis. Cocok buat HP.</p>";
  if (msg) body += "<div class=\"err\">" + escHtml(msg) + "</div>";
  body += "<form method=\"get\" action=\"/lite\">" +
    "<label>Nama depan alamat (kosongkan = acak)</label>" +
    "<input name=\"prefix\" placeholder=\"mis. opoyvvtt\" autocomplete=\"off\">" +
    "<label>Domain</label><select name=\"domain\">" + opts + "</select>" +
    "<div class=\"row\"><button type=\"submit\">Buka inbox</button>" +
    "<button type=\"submit\" class=\"sec\" formaction=\"/lite?random=1\">Alamat acak</button></div>" +
    "</form><p><a href=\"/\">Versi lengkap</a></p>";
  return liteResp(liteShell("TempMail Lite", body));
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

  if (path === "/lite/delete") {
    if (request.method !== "POST") return liteRedirect("/lite");
    let fd = null;
    try {
      fd = await request.formData();
    } catch (e) {
      return liteRedirect("/lite");
    }
    const address = String(fd.get("address") || "").toLowerCase().trim();
    const id = String(fd.get("id") || "").trim();
    const p = String(fd.get("p") || "0");
    if (!validAddress(address, domains) || !/^[a-z0-9]+$/i.test(id)) return liteRedirect("/lite");
    try {
      await getStore(env, address).fetch("https://do/delete?id=" + encodeURIComponent(id), { method: "DELETE" });
    } catch (e) {}
    return liteRedirect("/lite?address=" + encodeURIComponent(address) + "&p=" + encodeURIComponent(p));
  }

  if (path === "/lite/read") {
    const address = (url.searchParams.get("address") || "").toLowerCase().trim();
    const id = (url.searchParams.get("id") || "").trim();
    if (!validAddress(address, domains) || !/^[a-z0-9]+$/i.test(id)) {
      return liteResp(liteShell("Tidak ditemukan", "<div class=\"err\">Alamat atau email tidak valid.</div><p><a href=\"/lite\">Kembali ke form alamat</a></p>"), 400);
    }
    let email = null;
    try {
      const r = await getStore(env, address).fetch("https://do/read?id=" + encodeURIComponent(id));
      email = await r.json();
    } catch (e) {}
    if (!email || email.error) {
      return liteResp(liteShell("Tidak ditemukan", "<div class=\"err\">Email tidak ditemukan / sudah dihapus.</div><p><a href=\"/lite?address=" + encodeURIComponent(address) + "\">Kembali ke inbox</a></p>"), 404);
    }
    let meta = "Dari: " + escHtml(email.from);
    if (email.date) meta += "<br>Terkirim: " + escHtml(email.date);
    if (email.receivedAt) meta += "<br>Diterima web: " + escHtml(liteDateStr(email.receivedAt));
    const back = "/lite?address=" + encodeURIComponent(address);
    const body = "<div class=\"top\"><a href=\"" + back + "\">← Kembali ke inbox</a><a href=\"/\">Versi lengkap</a></div>" +
      "<h1>" + escHtml(email.subject) + "</h1>" +
      "<p>" + meta + "</p>" +
      "<pre class=\"body\">" + escHtml(email.body || "(kosong)") + "</pre>" +
      "<form method=\"post\" action=\"/lite/delete\">" +
      "<input type=\"hidden\" name=\"address\" value=\"" + escHtml(address) + "\">" +
      "<input type=\"hidden\" name=\"id\" value=\"" + escHtml(email.id) + "\">" +
      "<button type=\"submit\">Hapus email ini</button></form>";
    return liteResp(liteShell(email.subject, body));
  }

  // /lite — inbox / form alamat
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
      return liteRedirect("/lite?address=" + encodeURIComponent(built));
    }
    return liteAddrForm(domains, primary, "");
  }
  if (!validAddress(address, domains)) {
    return liteResp(liteShell("Alamat tidak valid", "<div class=\"err\">Alamat tidak valid untuk domain temp mail ini.</div><p><a href=\"/lite\">Kembali ke form alamat</a></p>"), 400);
  }

  let emails = [];
  try {
    const r = await getStore(env, address).fetch("https://do/inbox");
    emails = (await r.json()).emails || [];
  } catch (e) {}
  let p = parseInt(url.searchParams.get("p") || "0", 10);
  if (isNaN(p) || p < 0) p = 0;
  const maxPage = Math.max(0, Math.ceil(emails.length / LITE_PAGE_SIZE) - 1);
  if (p > maxPage) p = maxPage;
  const page = emails.slice(p * LITE_PAGE_SIZE, p * LITE_PAGE_SIZE + LITE_PAGE_SIZE);
  const prefix = address.split("@")[0] || "";

  let domLinks = "";
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (d === address.split("@")[1]) continue;
    domLinks += " <a href=\"/lite?prefix=" + encodeURIComponent(prefix) + "&domain=" + encodeURIComponent(d) + "\">" + escHtml(d) + "</a>";
  }

  let body = "<div class=\"top\"><a href=\"/lite\">Alamat lain</a><a href=\"/\">Versi lengkap</a></div>" +
    "<h1>TempMail Lite</h1>" +
    "<div class=\"addr\">" + escHtml(address) + "</div>" +
    "<p class=\"hint\">Tekan lama alamat untuk menyalin. Kirim email ke alamat ini, lalu tekan Refresh.</p>" +
    "<div class=\"row\"><a href=\"/lite?address=" + encodeURIComponent(address) + "\">↻ Refresh</a>" +
    (domLinks ? "<span>Ganti domain:" + domLinks + "</span>" : "") + "</div>" +
    "<h2>Inbox (" + emails.length + " pesan)</h2>";
  if (!emails.length) {
    body += "<p>Belum ada email masuk. Kirim ke alamat di atas, lalu tekan Refresh.</p>";
  } else {
    for (let i = 0; i < page.length; i++) {
      const e = page[i];
      const readUrl = "/lite/read?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(e.id);
      body += "<div class=\"mail\">" +
        "<a class=\"subj\" href=\"" + readUrl + "\">" + escHtml(e.subject) + "</a>" +
        "<div class=\"meta\">" + escHtml(e.from) + (e.date ? " • " + escHtml(String(e.date).slice(0, 48)) : "") + "</div>" +
        "<form method=\"post\" action=\"/lite/delete\">" +
        "<input type=\"hidden\" name=\"address\" value=\"" + escHtml(address) + "\">" +
        "<input type=\"hidden\" name=\"id\" value=\"" + escHtml(e.id) + "\">" +
        "<input type=\"hidden\" name=\"p\" value=\"" + p + "\">" +
        "<button type=\"submit\">✕ Hapus</button></form></div>";
    }
    body += "<div class=\"nav row\">";
    if (p > 0) body += "<a href=\"/lite?address=" + encodeURIComponent(address) + "&p=" + (p - 1) + "\">← Lebih baru</a>";
    body += "<span>Halaman " + (p + 1) + " dari " + (maxPage + 1) + "</span>";
    if (p < maxPage) body += "<a href=\"/lite?address=" + encodeURIComponent(address) + "&p=" + (p + 1) + "\">Lebih lama →</a>";
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

    if (url.pathname === "/lite" || url.pathname === "/lite/read" || url.pathname === "/lite/delete") {
      return handleLite(request, env, url, domains, primary);
    }

    const html = PAGE.split("__DOMAIN__").join(primary).split("__DOMAINS__").join(domains.join(","));
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
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
