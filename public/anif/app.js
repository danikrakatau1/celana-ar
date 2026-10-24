
const DOMAINS = "celana-ar-store.my.id,dini-faqih.my.id".split(",");
let domain = localStorage.getItem("tm_dom");
let address = localStorage.getItem("tm_addr");
const _ad = address ? address.split("@")[1] : null;
if(!domain || DOMAINS.indexOf(domain) === -1) domain = (_ad && DOMAINS.indexOf(_ad) !== -1) ? _ad : DOMAINS[0];
if(!address || address.split("@")[1] !== domain){ address = rand() + "@" + domain; localStorage.setItem("tm_addr", address); }
function renderDomSel(){
  document.getElementById("domsel").innerHTML = DOMAINS.map(function(d){
    return '<button class="' + (d === domain ? "on" : "") + '" onclick="setDomain(\'' + d + '\')">' + esc(d) + "</button>";
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
  const m = s.match(/(d{1,2})s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*s+(d{4})s+(d{1,2}):(d{2})(?::(d{2}))?/i);
  if(!m) return s;
  const utc = Date.UTC(+m[3], EN_MON[m[2].toLowerCase()], +m[1], +m[4], +m[5], +(m[6] || 0));
  return fmtWIB(utc);
}
function toWIBshort(v){
  const f = toWIB(v);
  const m = f.match(/(d{2}):(d{2}):d{2} WIB/);
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
    return '<div class="mail' + fresh + '" style="animation-delay:' + (i*60) + 'ms" onclick="readMail(\'' + e.id + '\')">' +
    '<div class="avatar" style="background:' + avatarGrad(e.from) + '">' + initialOf(esc(e.from)) + '</div>' +
    '<div class="minfo"><div class="mfrom">' + esc(e.from) + '</div>' +
    '<div class="msubj">' + esc(e.subject) + '</div></div>' +
    '<div class="mright"><div class="mdate">' + esc(toWIBshort(e.date)) + ' WIB</div><div class="cd"' + exp + '></div></div>' +
    '<button class="delbtn" onclick="event.stopPropagation();deleteMail(\'' + e.id + '\')" title="Hapus email">✕</button>' +
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
  if(j.date) meta += "\n📤 Terkirim: " + toWIB(j.date);
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
