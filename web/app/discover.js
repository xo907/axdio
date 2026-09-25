/* Axdio — Discover: a vertical feed of songs you've never played, each starting at its catchiest part
   (loaded after core.js). Swipe or scroll to the next one, double-tap the cover to like it. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Discover) return;
const { UI, U, S, esc, ic, api, coverUrl, L, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const on = () => !!(U.token && feat('discover'));
const F = { el: null, items: [], i: -1, audio: null, io: null, busy: false, liked: 0, wasPlaying: false, tap: 0, tapT: 0, fade: 0 };

function homeCard() {
  if (!on() || L.tracks.length < 5) return '';
  const pics = L.tracks.filter(t => t.hc && !(U.plays && U.plays.get(t.rel))).slice(0, 40), k = new Date().getDate();
  const covers = [0, 1, 2].map(n => pics[(k * 7 + n * 13) % Math.max(1, pics.length)]).filter(Boolean).map(t => coverUrl(t.rel));
  return `<div class="hcard dc-hc" data-dc="open" role="button" aria-label="Open Discover"><span class="dc-hc-art">${[...new Set(covers)].map((c, n) => `<img src="${esc(c)}" alt="" style="--n:${n}" loading="lazy">`).join('') || ic('compass')}</span>`
    + `<span class="hcard-t"><small>Discover</small><b>Songs you've never heard</b><span>Swipe through, like what you love</span></span><span class="hcard-go">${ic('compass')}</span></div>`;
}

/* ---- Feed ---- */
async function more() {
  if (F.busy) return;
  F.busy = true;
  try {
    const d = await api('/api/discover?n=12');
    const fresh = (d.items || []).filter(it => L.byRel.get(it.rel) && !F.items.some(x => x.rel === it.rel));
    const start = F.items.length;
    F.items.push(...fresh);
    const feed = F.el && F.el.querySelector('.dc-feed');
    if (!feed) return;
    const end = feed.querySelector('.dc-end');
    fresh.forEach((it, k) => { end.insertAdjacentHTML('beforebegin', itemHtml(it, start + k)); F.io.observe(feed.querySelector(`[data-i="${start + k}"]`)); });
    if (!start) feed.scrollTop = 0;
    if (!F.items.length) end.innerHTML = `<p>${ic('compass')}<br>You've heard everything here. Add more music and come back!</p>`;
  } catch (e) { toast(e.message); }
  finally { F.busy = false; }
}
function itemHtml(it, i) {
  const t = L.byRel.get(it.rel), liked = U.likedSet && U.likedSet.has(it.rel), cov = t && t.hc ? coverUrl(it.rel) : '';
  const who = it.why && it.why.kind === 'friend' && AX.personAvatar ? AX.personAvatar({ username: it.why.user, display_name: it.why.text }, 'dc-av') : '';
  return `<section class="dc-item" data-i="${i}">${cov ? `<div class="dc-bg" style="background-image:url('${esc(cov)}')"></div>` : '<div class="dc-bg none"></div>'}`
    + `<div class="dc-art" data-dc="art">${cov ? `<img src="${esc(cov)}" alt="">` : `<span class="dc-noart">${ic('note')}</span>`}<span class="dc-heart">${ic('heart')}</span><span class="dc-paused">${ic('play')}</span></div>`
    + `<div class="dc-meta"><span class="dc-why ${esc(it.why ? it.why.kind : '')}">${who}${esc(it.why ? it.why.text : '')}</span><h2>${esc(it.title)}</h2><p>${esc(it.artist)}${it.album ? ' · ' + esc(it.album) : ''}</p></div>`
    + `<div class="dc-side"><button data-dc="like" class="${liked ? 'on' : ''}" aria-label="Like">${ic('heart')}<small>Like</small></button><button data-dc="queue" aria-label="Add to queue">${ic('queue')}<small>Queue</small></button><button data-dc="full" aria-label="Play the whole song">${ic('play')}<small>Play</small></button></div>`
    + `<div class="dc-prog"><i></i></div></section>`;
}
function activate(i) {
  if (i === F.i || !F.items[i]) return;
  F.i = i;
  const it = F.items[i], a = F.audio;
  F.el.querySelectorAll('.dc-item').forEach(s => s.classList.toggle('on', +s.dataset.i === i));
  clearInterval(F.fade);
  a.pause();
  a.src = AX.playUrl(it.rel);
  a.volume = 0;
  const go = () => {
    try { a.currentTime = Math.max(0, Math.min(it.hook || 0, (a.duration || it.dur || 60) - 20)); } catch (e) { /* not seekable yet */ }
    a.play().then(() => fadeTo(vol())).catch(() => F.el && F.el.querySelector(`[data-i="${i}"]`).classList.add('paused'));
  };
  a.addEventListener('loadedmetadata', go, { once: true });
  if (i >= F.items.length - 3) more();
}
const vol = () => S.muted ? 0 : Math.max(0, Math.min(1, +S.volume || 1));
function fadeTo(v, done) {
  const a = F.audio, from = a.volume, t0 = performance.now();
  clearInterval(F.fade);
  F.fade = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 450); a.volume = from + (v - from) * p; if (p >= 1) { clearInterval(F.fade); if (done) done(); } }, 30);
}
function toggle() {
  const a = F.audio, s = F.el.querySelector('.dc-item.on');
  if (a.paused) { a.play().catch(() => {}); fadeTo(vol()); s && s.classList.remove('paused'); }
  else { a.pause(); s && s.classList.add('paused'); }
}
function step(d) {
  const next = F.el.querySelector(`[data-i="${Math.max(0, F.i + d)}"]`);
  if (next) next.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function like(i, fromTap) {
  const it = F.items[i], t = it && L.byRel.get(it.rel); if (!t) return;
  const was = U.likedSet.has(t.rel);
  if (fromTap && was) { burst(i); return; }             // a double-tap only ever likes
  AX.toggleLike(t);
  const now = U.likedSet.has(t.rel);
  F.el.querySelector(`[data-i="${i}"] [data-dc="like"]`).classList.toggle('on', now);
  if (now) { burst(i); F.liked++; count(); api('/api/discover/log', { action: 'like', rel: t.rel }).catch(() => {}); }
}
function burst(i) {
  const h = F.el.querySelector(`[data-i="${i}"] .dc-heart`); if (!h) return;
  h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
  if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) { /* no vibration */ }
}
function count() { const c = F.el.querySelector('.dc-count'); c.innerHTML = F.liked ? `${ic('heart', 'sm')}${F.liked}` : ''; }

/* ---- Open / close ---- */
async function open() {
  if (!on()) { toast(U.token ? 'Discover is turned off on this server' : 'Log in to use Discover'); return; }
  if (F.el) return;
  F.wasPlaying = !!(AX.isPlaying && AX.isPlaying());
  if (F.wasPlaying) AX.pause();
  const el = F.el = document.createElement('div');
  el.className = 'dc'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Discover');
  el.innerHTML = `<div class="dc-frame"><div class="dc-top"><b>${ic('compass', 'sm')} Discover</b><span class="dc-count"></span><span class="flex1"></span><button class="dc-x" data-dc="close" aria-label="Close">${ic('close')}</button></div>`
    + `<div class="dc-feed"><div class="dc-end"><span class="dc-spin"></span></div></div><div class="dc-hint">${ic('down', 'sm')} Swipe for the next song · double-tap to like</div></div>`;
  document.body.appendChild(el);
  document.documentElement.classList.add('dc-open');
  requestAnimationFrame(() => el.classList.add('on'));
  F.items = []; F.i = -1; F.liked = 0;
  F.audio = new Audio();
  F.audio.preload = 'auto';
  // Touching the audio inside the tap that opened Discover lets it keep playing as you swipe (iPhone).
  F.audio.play().catch(() => {});
  F.audio.addEventListener('timeupdate', () => {
    const it = F.items[F.i], bar = F.el && F.el.querySelector('.dc-item.on .dc-prog i');
    if (bar && it) bar.style.width = (F.audio.currentTime / (F.audio.duration || it.dur || 1) * 100).toFixed(2) + '%';
  });
  F.audio.addEventListener('ended', () => step(1));
  F.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.intersectionRatio > .6) activate(+e.target.dataset.i); }), { root: el.querySelector('.dc-feed'), threshold: [.6] });
  el.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  await more();
  setTimeout(() => el.querySelector('.dc-hint') && el.querySelector('.dc-hint').classList.add('gone'), 3500);
}
function close(keepQuiet) {
  if (!F.el) return;
  const el = F.el; F.el = null;
  clearInterval(F.fade);
  if (F.audio) { F.audio.pause(); F.audio.removeAttribute('src'); F.audio.load(); F.audio = null; }
  if (F.io) F.io.disconnect();
  document.removeEventListener('keydown', onKey, true);
  document.documentElement.classList.remove('dc-open');
  el.classList.remove('on'); setTimeout(() => el.remove(), 220);
  if (F.wasPlaying && !keepQuiet && AX.play) AX.play();
  if (F.liked) { toast(`${F.liked} new ${F.liked === 1 ? 'song' : 'songs'} in your Liked Songs`); if (AX.Achieve) setTimeout(() => AX.Achieve.refresh(), 1500); }
}
function onClick(e) {
  const b = e.target.closest('[data-dc]'); if (!b) return;
  const a = b.dataset.dc, sec = b.closest('.dc-item'), i = sec ? +sec.dataset.i : F.i, it = F.items[i];
  if (a === 'close') close();
  else if (a === 'like') like(i);
  else if (a === 'queue') { const t = L.byRel.get(it.rel); if (t) { AX.addToQueue([t.id]); toast('Added to your queue'); api('/api/discover/log', { action: 'queue', rel: t.rel }).catch(() => {}); } }
  else if (a === 'full') {
    const ids = F.items.slice(i).map(x => L.byRel.get(x.rel)).filter(Boolean).map(t => t.id);
    api('/api/discover/log', { action: 'full', rel: it.rel }).catch(() => {});
    close(true);
    AX.playCtx(AX.makeCtx('list', 'discover', 'Discover', ids), 0);
  }
  else if (a === 'art') {
    const now = performance.now();
    if (now - F.tapT < 320) { clearTimeout(F.tap); F.tapT = 0; like(i, true); return; }
    F.tapT = now;
    F.tap = setTimeout(() => { if (F.el) toggle(); }, 320);
  }
}
function onKey(e) {
  if (!F.el) return;
  const k = e.key;
  if (k === 'Escape') close();
  else if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') step(1);
  else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') step(-1);
  else if (k === ' ') toggle();
  else if (k === 'l') like(F.i);
  else return;
  e.preventDefault(); e.stopPropagation();
}

document.addEventListener('click', e => { const c = e.target.closest('[data-dc="open"]'); if (c) { e.preventDefault(); open(); } });
if (AX.HOME_CARDS) { const at = AX.HOME_CARDS.indexOf(AX.Daily && AX.Daily.homeCard); AX.HOME_CARDS.splice(at >= 0 ? at + 1 : 0, 0, homeCard); }

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
html.dc-open { overflow: hidden; }
.dc { position: fixed; inset: 0; z-index: 99970; background: #000; color: #fff; display: grid; place-items: center; opacity: 0; transition: opacity .2s; }
.dc.on { opacity: 1; }
.dc-frame { position: relative; width: 100vw; height: 100dvh; }
@media (min-width: 700px) { .dc-frame { width: min(480px, calc(94dvh * 9 / 16)); height: 94dvh; border-radius: 18px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.6); } }
.dc-top { position: absolute; top: 0; left: 0; right: 0; z-index: 5; display: flex; align-items: center; gap: 10px; padding: calc(env(safe-area-inset-top, 0px) + 12px) 14px 30px; background: linear-gradient(rgba(0,0,0,.55), transparent); pointer-events: none; }
.dc-top > * { pointer-events: auto; }
.dc-top b { display: inline-flex; align-items: center; gap: 6px; font-size: 18px; font-weight: 900; letter-spacing: -.01em; }
.dc-top b .i { width: 20px; height: 20px; }
.dc .flex1 { flex: 1; }
.dc-count { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 800; color: #f472b6; }
.dc-count .i { width: 16px; height: 16px; }
.dc-x { width: 40px; height: 40px; border: 0; border-radius: 50%; background: rgba(255,255,255,.14); color: #fff; display: grid; place-items: center; cursor: pointer; }
.dc-feed { height: 100%; overflow-y: auto; scroll-snap-type: y mandatory; overscroll-behavior: contain; scrollbar-width: none; overflow-anchor: none; }
.dc-feed::-webkit-scrollbar { display: none; }
.dc-item { position: relative; height: 100%; scroll-snap-align: start; scroll-snap-stop: always; overflow: hidden; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 70px 22px 110px; }
.dc-bg { position: absolute; inset: -40px; background: center / cover; filter: blur(40px) brightness(.5) saturate(1.3); transform: scale(1.1); }
.dc-bg.none { background: linear-gradient(160deg, #312e81, #0f172a); filter: none; }
.dc-art { position: relative; width: min(calc(100% - 130px), 360px, 46dvh); aspect-ratio: 1; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 70px rgba(0,0,0,.55); cursor: pointer; transform: scale(.94); transition: transform .5s cubic-bezier(.2,.8,.2,1); background: rgba(255,255,255,.08); }
.dc-item.on .dc-art { transform: none; }
.dc-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dc-noart { width: 100%; height: 100%; display: grid; place-items: center; background: linear-gradient(135deg, #6366f1, #ec4899); }
.dc-noart .i { width: 90px; height: 90px; opacity: .8; }
.dc-heart { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; opacity: 0; pointer-events: none; }
.dc-heart .i { width: 120px; height: 120px; filter: drop-shadow(0 8px 30px rgba(236,72,153,.8)); color: #f472b6; }
.dc-heart.go { animation: dc-heart .8s cubic-bezier(.2,.8,.2,1); }
@keyframes dc-heart { 0% { opacity: 0; transform: scale(.4); } 25% { opacity: 1; transform: scale(1.15); } 60% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.3) translateY(-30px); } }
.dc-paused { position: absolute; inset: 0; display: none; place-items: center; background: rgba(0,0,0,.3); }
.dc-paused .i { width: 70px; height: 70px; }
.dc-item.paused .dc-paused { display: grid; }
.dc-meta { position: relative; width: 100%; max-width: 420px; margin-top: 24px; padding-right: 64px; }
.dc-why { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 800; padding: 5px 10px 5px 8px; border-radius: 99px; background: rgba(255,255,255,.16); backdrop-filter: blur(8px); }
.dc-why.friend { background: rgba(236,72,153,.35); } .dc-why.artist { background: rgba(99,102,241,.4); }
.dc-why .avatar.dc-av { width: 20px; height: 20px; font-size: 10px; }
.dc-meta h2 { font-size: clamp(24px, 7vw, 32px); font-weight: 900; letter-spacing: -.03em; line-height: 1.08; margin: 10px 0 4px; overflow-wrap: anywhere; }
.dc-meta p { font-size: 15px; font-weight: 600; opacity: .8; margin: 0; }
.dc-side { position: absolute; right: 12px; bottom: 120px; display: flex; flex-direction: column; gap: 16px; z-index: 2; }
.dc-side button { display: flex; flex-direction: column; align-items: center; gap: 3px; border: 0; background: none; color: #fff; font: inherit; cursor: pointer; }
.dc-side button .i { width: 30px; height: 30px; padding: 11px; box-sizing: content-box; border-radius: 50%; background: rgba(0,0,0,.35); backdrop-filter: blur(8px); transition: transform .15s; }
.dc-side button:active .i { transform: scale(.88); }
.dc-side button.on .i { color: #f472b6; }
.dc-side small { font-size: 11px; font-weight: 800; text-shadow: 0 1px 4px rgba(0,0,0,.6); }
.dc-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.2); }
.dc-prog i { display: block; height: 100%; width: 0; background: #fff; }
.dc-end { height: 100%; display: grid; place-items: center; text-align: center; padding: 30px; scroll-snap-align: start; opacity: .8; }
.dc-end .i { width: 44px; height: 44px; }
.dc-spin { width: 32px; height: 32px; border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; animation: dc-spin .8s linear infinite; }
@keyframes dc-spin { to { transform: rotate(360deg); } }
.dc-hint { position: absolute; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 24px); transform: translateX(-50%); z-index: 4; display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; padding: 8px 14px; border-radius: 99px; background: rgba(0,0,0,.5); white-space: nowrap; transition: opacity .6s; pointer-events: none; }
.dc-hint.gone { opacity: 0; }
.dc-hc { background: linear-gradient(120deg, #be185d, #7c3aed 55%, #1d4ed8); }
.dc-hc-art { position: relative; width: 76px; height: 60px; flex-shrink: 0; }
.dc-hc-art img { position: absolute; top: 2px; left: calc(var(--n) * 10px); width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,255,255,.8); box-shadow: 0 4px 12px rgba(0,0,0,.35); }
.dc-hc-art > .i { width: 40px; height: 40px; margin: 10px; }
@media (prefers-reduced-motion: reduce) { .dc-heart.go { animation: none; } .dc-art { transition: none; } }
` }));

AX.Discover = { open, close, homeCard };
})();
