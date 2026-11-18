/* Ikon: Lucide (ISC) — lucide.dev, digambar ulang sebagai SVG sebaris agar selalu tampil tajam di semua HP. */
const ICONS = {
  "at-sign": "<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8\" />",
  "bell-off": "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /> <path d=\"M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742\" /> <path d=\"m2 2 20 20\" /> <path d=\"M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05\" />",
  "bell": "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /> <path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\" />",
  "check": "<path d=\"M20 6 9 17l-5-5\" />",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 6v6l4 2\" />",
  "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />",
  "dices": "<rect width=\"12\" height=\"12\" x=\"2\" y=\"10\" rx=\"2\" ry=\"2\" /> <path d=\"m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6\" /> <path d=\"M6 18h.01\" /> <path d=\"M10 14h.01\" /> <path d=\"M15 6h.01\" /> <path d=\"M18 9h.01\" />",
  "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />",
  "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /> <path d=\"M2 12h20\" />",
  "inbox": "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\" /> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" />",
  "key-round": "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\" /> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />",
  "lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\" />",
  "mail": "<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\" /> <rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\" />",
  "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />",
  "search": "<path d=\"m21 21-4.34-4.34\" /> <circle cx=\"11\" cy=\"11\" r=\"8\" />",
  "send": "<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\" /> <path d=\"m21.854 2.147-10.94 10.939\" />",
  "shield-check": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" /> <path d=\"m9 12 2 2 4-4\" />",
  "sparkles": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" /> <path d=\"M20 2v4\" /> <path d=\"M22 4h-4\" /> <circle cx=\"4\" cy=\"20\" r=\"2\" />",
  "timer": "<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\" /> <line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\" /> <circle cx=\"12\" cy=\"14\" r=\"8\" />",
  "trash-2": "<path d=\"M10 11v6\" /> <path d=\"M14 11v6\" /> <path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\" /> <path d=\"M3 6h18\" /> <path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" />",
  "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /> <path d=\"M12 9v4\" /> <path d=\"M12 17h.01\" />",
  "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />",
  "zap": "<path d=\"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z\" />",
};
function icon(name, size){
  const inner = ICONS[name] || "";
  return '<svg width="' + (size||18) + '" height="' + (size||18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;display:block">' + inner + "</svg>";
}
let DOMAINS = "moai.my.id,celana-ar-store.my.id,dini-faqih.my.id,anif-tools.my.id,4n1f-tutorial.my.id,4n1f.my.id,4n1f-tutorial.web.id,4nif.my.id,anif.biz.id,anif.my.id,anif-promo.my.id,anifstore.my.id,celanaar.biz.id,celanaar.my.id,celana-arstore.biz.id,celana-arstore.my.id,celana-arstore.web.id,celanaar.web.id,dinzzz.my.id,official-arstore.my.id,shopee-arstore.biz.id,shopee-arstore.my.id,tiktok-arstore.my.id,tiktok-arstore.web.id,toko-arstore.my.id,undangankuuu.my.id,vardz.my.id,shopee-arstore.web.id,4n1f.web.id,jannnn.co.uk,anif.eu.cc,bosku.eu.cc,hitamkan.eu.cc,anifff.eu.cc,hytamkannn.eu.cc,gaskoennn.eu.cc,anjaymuse.eu.cc,wkwkmuse.eu.cc,gokilmuse.eu.cc,gokilcue.eu.cc,wkwkcue.eu.cc,anjaycue.eu.cc,museterbaik.eu.cc,musegokil.eu.cc,museanjay.eu.cc,mailgokil.eu.cc,mailanjay.eu.cc,mailwkwk.eu.cc".split(",");
/* Daftar domain otoritatif dari Worker (env DOMAINS) — fallback di atas hanya cadangan. */
fetch("/api/domains").then(function(r){ return r.json(); }).then(function(d){
  if(d && d.domains && d.domains.length){
    DOMAINS = d.domains;
    if(DOMAINS.indexOf(domain) === -1){
      domain = DOMAINS[0]; address = rand() + "@" + domain;
      localStorage.setItem("tm_dom", domain); localStorage.setItem("tm_addr", address);
      renderAddr(true);
    }
    renderDomSel(); load();
  }
}).catch(function(){});
let domain = localStorage.getItem("tm_dom");
let address = localStorage.getItem("tm_addr");
const _ad = address ? address.split("@")[1] : null;
if(!domain || DOMAINS.indexOf(domain) === -1) domain = (_ad && DOMAINS.indexOf(_ad) !== -1) ? _ad : DOMAINS[0];
if(!address || address.split("@")[1] !== domain){ address = rand() + "@" + domain; localStorage.setItem("tm_addr", address); }
function renderDomSel(){
  var wrap = document.getElementById("domsel");
  wrap.innerHTML =
    '<button type="button" class="dom-btn" id="domBtn" aria-haspopup="listbox" aria-expanded="false">' +
      '<span>' + esc(domain) + '</span>' +
      '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>' +
    '</button>' +
    '<div class="dom-list" id="domList" role="listbox">' +
      DOMAINS.map(function(d, i){
        return '<button type="button" class="dom-opt' + (d === domain ? ' sel' : '') + '" role="option" data-dom="' + esc(d) + '" style="animation-delay:' + Math.min(i * 10, 150) + 'ms"><span>' + esc(d) + '</span>' + (d === domain ? '<span aria-hidden="true">&#10003;</span>' : '') + '</button>';
      }).join("") +
    '</div>';
  var btn = document.getElementById("domBtn");
  var list = document.getElementById("domList");
  btn.addEventListener("click", function(e){ e.stopPropagation(); toggleDomList(); });
  list.addEventListener("click", function(e){
    var t = e.target.closest("[data-dom]");
    if(!t) return;
    var d = t.getAttribute("data-dom");
    closeDomList();
    if(d !== domain) setTimeout(function(){ setDomain(d); }, 280);
  });
}
function toggleDomList(force){
  var btn = document.getElementById("domBtn"), list = document.getElementById("domList");
  if(!btn || !list) return;
  var open = typeof force === "boolean" ? force : !list.classList.contains("open");
  list.classList.toggle("open", open);
  btn.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if(open){ var sel = list.querySelector(".dom-opt.sel"); if(sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
}
function closeDomList(){ toggleDomList(false); }
document.addEventListener("click", function(e){
  var w = document.getElementById("domsel");
  if(w && !w.contains(e.target)) closeDomList();
});
document.addEventListener("keydown", function(e){ if(e.key === "Escape") closeDomList(); });
function setDomain(d){
  const local = address.split("@")[0];
  domain = d; address = local + "@" + d;
  localStorage.setItem("tm_dom", d); localStorage.setItem("tm_addr", address);
  resetInboxState(); renderDomSel(); renderAddr(true); load(); toast("Domain diganti: " + d);
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
function copyText(text, done){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(function(){ fallbackCopy(text, done); });
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done){
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); done(); }catch(e){}
  document.body.removeChild(ta);
}
function copyAddr(btn){
  copyText(address, function(){
    toast("Alamat disalin ke clipboard");
    const b = document.getElementById("copyBtn");
    if(!b.classList.contains("done")){
      const old = b.innerHTML; b.classList.add("done"); b.innerHTML = icon("check", 17) + " Tersalin!";
      setTimeout(function(){ b.classList.remove("done"); b.innerHTML = old; }, 1600);
    }
  });
}
function copyCode(btn, code){
  copyText(code, function(){ toast("Kode disalin: " + code); });
}
function newAddr(){
  address = rand() + "@" + domain;
  localStorage.setItem("tm_addr", address);
  resetInboxState(); renderAddr(true); load(); toast("Alamat baru dibuat");
}
function useCustom(){
  const p = document.getElementById("prefix").value.trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
  if(!p){ toast("Isi nama dulu ya"); return; }
  address = p + "@" + domain;
  localStorage.setItem("tm_addr", address);
  document.getElementById("prefix").value = "";
  resetInboxState(); renderAddr(true); load(); toast("Alamat dipakai");
}
function avatarGrad(from){
  let h = 0; for(let i = 0; i < from.length; i++) h = (h*31 + from.charCodeAt(i)) % 360;
  return "linear-gradient(135deg,hsl(" + h + ",70%,58%),hsl(" + ((h+50)%360) + ",65%,42%))";
}
function initialOf(from){
  const m = /([a-zA-Z0-9])/.exec(from);
  return m ? m[1].toUpperCase() : "?";
}
function splitFrom(from){
  const s = String(from || "").trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if(m) return { name: (m[1] || m[2]).trim(), addr: m[2].trim() };
  return { name: s || "(tidak dikenal)", addr: "" };
}
/* ---- tanggal: parse header email (RFC 2822) lalu tampilkan WIB ---- */
function parseMailDate(v){
  if(v === undefined || v === null || v === "") return null;
  if(typeof v === "number") return v;
  const t = Date.parse(String(v).trim());
  if(!isNaN(t)) return t;
  const m = String(v).match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const mon = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11}[m[2].slice(0,3).toLowerCase()];
    if(mon !== undefined) return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +(m[6] || 0));
  }
  return null;
}
const DTF = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function wibParts(ms){
  const o = {};
  DTF.formatToParts(new Date(ms)).forEach(function(p){ o[p.type] = p.value; });
  return o;
}
function fmtFull(ms){
  const o = wibParts(ms);
  return o.day + " " + o.month + " " + o.year + " · " + o.hour + "." + o.minute + "." + o.second + " WIB";
}
function fmtList(ms, fallbackMs){
  const t = ms || fallbackMs;
  if(!t) return "";
  const diff = Date.now() - t;
  if(diff > -60000 && diff < 60000) return "baru saja";
  if(diff > 0 && diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + " mnt lalu";
  if(diff > 0 && diff < 86400000) return Math.floor(diff / 3600000) + " jam lalu";
  const o = wibParts(t);
  return o.day + " " + o.month + " · " + o.hour + "." + o.minute;
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
  return '<div class="empty"><span class="big">' + icon("inbox", 54) + '</span>' +
    '<p>Belum ada email masuk.<br>Kirim ke alamat di atas — muncul di sini otomatis.</p></div>';
}
function paint(){
  const q = document.getElementById("q").value.trim().toLowerCase();
  const list = document.getElementById("list");
  countUp(document.getElementById("count"), cacheEmails.length);
  const emails = q ? cacheEmails.filter(function(e){ return (e.from + " " + e.subject).toLowerCase().indexOf(q) !== -1; }) : cacheEmails;
  if(!emails.length){
    list.innerHTML = cacheEmails.length ? '<div class="empty"><p>Tidak ketemu.<br>Coba kata kunci lain.</p></div>' : emptyHTML();
    return;
  }
  list.innerHTML = emails.map(function(e, i){
    const fresh = freshIds.has(e.id) ? " fresh" : "";
    const f = splitFrom(e.from);
    const ms = parseMailDate(e.date);
    const recv = e.expiresAt ? e.expiresAt - 7200000 : null;
    const when = fmtList(ms, recv);
    return '<div class="mail' + fresh + '" style="animation-delay:' + (i*60) + 'ms" onclick="readMail(\'' + e.id + '\')">' +
    '<div class="avatar" style="background:' + avatarGrad(e.from) + '">' + esc(initialOf(f.name)) + '</div>' +
    '<div class="minfo"><div class="mfrom">' + esc(f.name) + '</div>' +
    '<div class="msubj">' + esc(e.subject) + '</div>' +
    (e.preview ? '<div class="mprev">' + esc(e.preview) + '</div>' : '') + '</div>' +
    '<div class="mright"><div class="mdate">' + esc(when) + '</div>' +
    (e.expiresAt ? '<div class="cd" data-exp="' + e.expiresAt + '">' + icon("timer", 11) + '<span class="cdt"></span></div>' : '') + '</div>' +
    '<button class="delbtn" onclick="event.stopPropagation();deleteMail(\'' + e.id + '\')" title="Hapus email">' + icon("trash-2", 13) + '</button>' +
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
function renderMute(){
  document.getElementById("muteBtn").innerHTML = icon(muted ? "bell-off" : "bell", 17);
}
function toggleMute(){
  muted = !muted;
  localStorage.setItem("tm_mute", muted ? "1" : "0");
  renderMute();
  toast(muted ? "Suara notifikasi mati" : "Suara notifikasi nyala");
}
async function deleteMail(id){
  try{
    const r = await fetch("/api/delete?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(id), { method: "DELETE" });
    const j = await r.json();
    if(j.ok){
      knownIds.delete(id); freshIds.delete(id);
      cacheEmails = cacheEmails.filter(function(e){ return e.id !== id; });
      paint(); toast("Email dihapus");
    } else toast("Gagal menghapus");
  }catch(e){ toast("Gagal menghapus"); }
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
      ding(); toast("Email baru masuk!");
      const bell = document.getElementById("muteBtn");
      bell.classList.remove("shake"); void bell.offsetWidth; bell.classList.add("shake");
      setTimeout(function(){ freshIds.clear(); paint(); }, 2500);
    }
  }catch(e){
    if(firstLoad) document.getElementById("list").innerHTML = '<div class="empty"><p>Gagal memuat. Cek koneksi lalu refresh.</p></div>';
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
    const span = els[i].querySelector(".cdt");
    if(span) span.textContent = h + ":" + (m < 10 ? "0" + m : m) + ":" + (ss < 10 ? "0" + ss : ss);
  }
  const bars = document.querySelectorAll(".expbar i[data-expbar]");
  for(let i = 0; i < bars.length; i++){
    const exp = parseInt(bars[i].getAttribute("data-expbar"), 10) || 0;
    const pct = Math.max(0, Math.min(100, (exp - now) / 7200000 * 100));
    bars[i].style.width = pct + "%";
  }
}, 1000);
/* ---- deteksi kode verifikasi dari subjek + isi teks ---- */
function extractCode(subject, body){
  const hay = String(subject || "") + "\n" + String(body || "");
  let m = hay.match(/\b(\d{3})[- ](\d{3})\b/);
  if(m) return m[1] + "-" + m[2];
  m = hay.match(/(?:code|kode|otp|verifikasi|verification|pin|confirm)/i);
  if(m){
    const after = hay.slice(m.index, m.index + 120);
    const c = after.match(/\b(\d{4,8})\b/);
    if(c && !/^(19|20)\d{2}$/.test(c[1])) return c[1];
  }
  m = hay.match(/\b(\d{6})\b/);
  if(m) return m[1];
  m = hay.match(/\b(\d{4})\b/);
  if(m && !/^(19|20)\d{2}$/.test(m[1])) return m[1];
  return "";
}
async function readMail(id){
  const r = await fetch("/api/read?address=" + encodeURIComponent(address) + "&id=" + encodeURIComponent(id));
  const j = await r.json();
  if(j.error){ toast("Email tidak ditemukan / kedaluwarsa"); load(); return; }
  document.getElementById("mSubj").textContent = j.subject;
  const f = splitFrom(j.from);
  const av = document.getElementById("mAvatar");
  av.textContent = initialOf(f.name);
  av.style.background = avatarGrad(j.from);
  document.getElementById("mFrom").textContent = f.name;
  document.getElementById("mTo").textContent = (f.addr ? f.addr + "  →  " : "untuk  ") + (j.to || address);
  let meta = "";
  const sentMs = parseMailDate(j.date);
  if(j.date) meta += '<span class="mrow">' + icon("send", 13) + "<span>Terkirim: " + esc(sentMs ? fmtFull(sentMs) : String(j.date)) + "</span></span>";
  if(j.receivedAt) meta += '<span class="mrow">' + icon("inbox", 13) + "<span>Diterima: " + esc(fmtFull(j.receivedAt)) + "</span></span>";
  document.getElementById("mMeta").innerHTML = meta;
  const code = extractCode(j.subject, j.body || "");
  const mc = document.getElementById("mCode");
  if(code){
    mc.hidden = false;
    mc.innerHTML = '<span class="mc-label">' + icon("key-round", 15) + " Kode verifikasi</span>" +
      '<span class="mc-code">' + esc(code) + "</span>" +
      '<button class="mc-copy" onclick="copyCode(this,\'' + esc(code) + '\')">' + icon("copy", 14) + " Salin kode</button>";
  } else {
    mc.hidden = true;
    mc.innerHTML = "";
  }
  const mb = document.getElementById("mBody");
  if(j.html){
    mb.classList.add("html");
    mb.textContent = "";
    const ifr = document.createElement("iframe");
    ifr.className = "mailframe";
    ifr.setAttribute("sandbox", "");
    ifr.setAttribute("title", "Isi email");
    ifr.srcdoc = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<style>html,body{margin:0;padding:0;background:#ffffff}body{font-family:Arial,Helvetica,sans-serif;padding:16px;box-sizing:border-box;color:#111827}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}a{color:#2563eb}</style>" +
      "</head><body>" + j.html + "</body></html>";
    mb.appendChild(ifr);
  } else {
    mb.classList.remove("html");
    mb.textContent = j.body || "(kosong)";
  }
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
  const o = wibParts(Date.now());
  el.textContent = o.hour + "." + o.minute + "." + o.second + " WIB";
}
renderDomSel(); renderAddr(true);
renderMute();
tickClock(); setInterval(tickClock, 1000);
load();
setInterval(load, 8000);
document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible") load(); });

/* ---------- efek scroll: header pintar + hero memudar ---------- */
(function(){
  var bar = document.querySelector(".topbar");
  var hero = document.querySelector(".hero");
  var lastY = window.scrollY || 0, ticking = false;
  function heroFree(){ if(hero && hero.style.animation !== "none") hero.style.animation = "none"; }
  if(hero){ hero.addEventListener("animationend", heroFree); setTimeout(heroFree, 1200); }
  function onScroll(){
    var y = window.scrollY || 0;
    if(bar){
      if(y > 90 && y > lastY + 4) bar.classList.add("bar-hide");
      else if(y < lastY - 4 || y <= 90) bar.classList.remove("bar-hide");
    }
    if(hero){
      if(y > 0) heroFree();
      var p = Math.min(y / 300, 1);
      hero.style.opacity = String(1 - p);
      hero.style.transform = "translateY(" + (-p * 22).toFixed(1) + "px)";
      hero.style.pointerEvents = p >= 0.98 ? "none" : "";
    }
    lastY = y; ticking = false;
  }
  window.addEventListener("scroll", function(){
    if(!ticking){ ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();
})();

/* ---------- scroll reveal: panel muncul satu-satu, smooth ---------- */
(function(){
  if(!("IntersectionObserver" in window)) return;
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(en.isIntersecting){ en.target.classList.add("in"); io.unobserve(en.target); }
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });
  var vh = window.innerHeight || 800;
  document.querySelectorAll(".wrap > section:not(.hero):not(.stats), .stats > .stat, .footer").forEach(function(el){
    var r = el.getBoundingClientRect();
    if(r.top < vh * 0.94) return; /* sudah kelihatan pas halaman dimuat: biarkan animasi bawaan */
    el.style.animation = "none";
    el.classList.add("rv");
    if(el.classList.contains("stat")){
      var idx = Array.prototype.indexOf.call(el.parentNode.children, el);
      el.style.transitionDelay = (idx * 0.09) + "s";
    }
    io.observe(el);
  });
})();
