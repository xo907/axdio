/* Axdio — Sing along: the vocals turned down live and big synced lyrics that fill as they're sung (loaded after core.js).
   Vocal reduction happens in core's audio graph (FX, S.karaoke): what's identical in both channels, usually the lead
   voice, cancels out, and the bass is put back. Browsers that can't route audio through Web Audio in the background
   (iPhone) keep the vocals and still get the lyrics. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Karaoke) return;
const { UI, S, FX, LY, IOS, esc, ic, coverUrl, curTrack, audio, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const K = { el: null, raf: 0, idx: -2, rel: null, dur: 0 };
S.karaoke = false;          // never left on by a reload

function vocals(off) {
  S.karaoke = !!off;
  FX.apply();
  if (off) { FX.ensure(); FX.resume(); }
  if (K.el) {
    const b = K.el.querySelector('[data-kk="vocals"]');
    b.classList.toggle('on', !off);
    b.querySelector('span').textContent = off ? 'Vocals off' : 'Vocals on';
  }
}
function open() {
  const t = curTrack();
  if (!t) { toast('Play a song first, then sing along'); return; }
  if (K.el) return;
  const el = K.el = document.createElement('div');
  el.className = 'kk'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Sing along');
  el.innerHTML = `<div class="kk-bg"></div><div class="kk-shade"></div>`
    + `<header class="kk-top"><img class="kk-art" alt=""><span class="kk-meta"><b></b><small></small></span><button class="kk-x" data-kk="close" aria-label="Close">${ic('close')}</button></header>`
    + `<div class="kk-stage"><div class="kk-lines"></div></div>`
    + `<footer class="kk-bot"><div class="kk-prog"><i></i></div><div class="kk-btns">`
    + `<button class="kk-pill on" data-kk="vocals"${IOS ? ' disabled title="iPhone browsers can\'t change the sound itself"' : ''}>${ic('karaoke', 'sm')}<span>Vocals on</span></button>`
    + `<button class="kk-play" data-kk="toggle" aria-label="Play or pause">${ic('pause')}</button>`
    + `<button class="kk-pill" data-kk="restart">${ic('prev', 'sm')}<span>From the top</span></button></div></footer>`;
  document.body.appendChild(el);
  document.documentElement.classList.add('kk-open');
  requestAnimationFrame(() => el.classList.add('on'));
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-kk]'); if (!b) return;
    const a = b.dataset.kk;
    if (a === 'close') close();
    else if (a === 'vocals') vocals(!S.karaoke);
    else if (a === 'toggle') AX.togglePlay();
    else if (a === 'restart') { AX.seek(0); if (!AX.isPlaying()) AX.play(); }
  });
  document.addEventListener('keydown', onKey, true);
  K.idx = -2; K.rel = null;
  if (!IOS) vocals(true); else toast('On iPhone the vocals stay in, but the lyrics are all yours');
  loop();
}
function close() {
  if (!K.el) return;
  const el = K.el; K.el = null;
  cancelAnimationFrame(K.raf);
  document.removeEventListener('keydown', onKey, true);
  document.documentElement.classList.remove('kk-open');
  if (S.karaoke) vocals(false);
  el.classList.remove('on'); setTimeout(() => el.remove(), 250);
}
function onKey(e) {
  if (!K.el) return;
  if (e.key === 'Escape') close();
  else if (e.key === ' ') AX.togglePlay();
  else if (e.key === 'v') vocals(!S.karaoke);
  else return;
  e.preventDefault(); e.stopPropagation();
}
function line(l, cls) { return `<div class="kk-l ${cls}">${esc(l ? l.text : '') || '&nbsp;'}</div>`; }
function loop() {
  K.raf = requestAnimationFrame(loop);
  const el = K.el; if (!el) return;
  const t = curTrack(); if (!t) return;
  if (t.rel !== K.rel) {
    K.rel = t.rel; K.idx = -2;
    const cov = coverUrl(t.rel);
    el.querySelector('.kk-bg').style.backgroundImage = t.hc ? `url("${cov}")` : '';
    el.querySelector('.kk-art').src = cov;
    el.querySelector('.kk-meta b').textContent = t.title;
    el.querySelector('.kk-meta small').textContent = t.artist;
  }
  el.querySelector('.kk-play').innerHTML = ic(AX.isPlaying() ? 'pause' : 'play');
  const cur = (audio.currentTime || 0) + .15, dur = audio.duration || 0;
  el.querySelector('.kk-prog i').style.width = dur ? (cur / dur * 100).toFixed(2) + '%' : '0';
  const box = el.querySelector('.kk-lines');
  if (LY.state !== 'ok' || !LY.synced || !LY.lines.length) {
    const msg = LY.state === 'loading' ? 'Finding the lyrics…' : LY.state === 'ok' ? "These lyrics aren't timed, so here they are all at once." : "There aren't lyrics for this song, but the stage is yours.";
    if (K.idx !== -3 + (LY.state === 'ok' ? 10 : 0)) {
      K.idx = -3 + (LY.state === 'ok' ? 10 : 0);
      box.innerHTML = `<div class="kk-msg">${esc(msg)}</div>` + (LY.state === 'ok' ? `<div class="kk-plain">${LY.lines.map(l => `<p>${esc(l.text) || '&nbsp;'}</p>`).join('')}</div>` : '');
    }
    return;
  }
  const L2 = LY.lines;
  let i = -1;
  while (i + 1 < L2.length && L2[i + 1].t <= cur) i++;
  if (i !== K.idx) {
    K.idx = i;
    if (i < 0) {
      const wait = L2[0].t - cur;
      box.innerHTML = `<div class="kk-ready">${wait > 3 ? 'Get ready…' : 'Here we go'}</div>` + line(L2[0], 'next') + line(L2[1], 'later');
    } else box.innerHTML = line(L2[i - 1], 'prev') + line(L2[i], 'now') + line(L2[i + 1], 'next') + line(L2[i + 2], 'later');
  }
  if (i >= 0) {
    const a = L2[i].t, b = i + 1 < L2.length ? L2[i + 1].t : Math.min(a + 6, dur || a + 6);
    const p = Math.max(0, Math.min(1, (cur - a) / Math.max(.5, (b - a) * .92)));
    const now = box.querySelector('.kk-l.now'); if (now) now.style.setProperty('--p', (p * 100).toFixed(1) + '%');
  }
}

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
html.kk-open { overflow: hidden; }
.kk { position: fixed; inset: 0; z-index: 99965; color: #fff; background: #000; display: flex; flex-direction: column; opacity: 0; transition: opacity .25s; }
.kk.on { opacity: 1; }
.kk-bg { position: absolute; inset: -60px; background: #3b0764 center / cover; filter: blur(60px) saturate(1.5) brightness(.55); transform: scale(1.1); }
.kk-shade { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, rgba(0,0,0,.1), rgba(0,0,0,.65)); }
.kk-top, .kk-stage, .kk-bot { position: relative; z-index: 1; }
.kk-top { display: flex; align-items: center; gap: 12px; padding: calc(env(safe-area-inset-top, 0px) + 16px) 20px 0; }
.kk-art { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: rgba(255,255,255,.1); }
.kk-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.kk-meta b { font-size: 16px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kk-meta small { font-size: 13px; opacity: .75; }
.kk-x { width: 42px; height: 42px; border: 0; border-radius: 50%; background: rgba(255,255,255,.14); color: #fff; display: grid; place-items: center; cursor: pointer; }
.kk-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 20px clamp(20px, 6vw, 80px); overflow: hidden; }
.kk-lines { width: 100%; max-width: 1100px; display: flex; flex-direction: column; gap: clamp(10px, 2.2vh, 22px); text-align: center; }
.kk-l { font-weight: 900; letter-spacing: -.02em; line-height: 1.15; transition: all .35s cubic-bezier(.2,.8,.2,1); overflow-wrap: anywhere; }
.kk-l.prev { font-size: clamp(18px, 3vw, 30px); opacity: .35; }
.kk-l.now { font-size: clamp(34px, 6.4vw, 76px); --p: 0%;
  background: linear-gradient(90deg, #fff var(--p), rgba(255,255,255,.38) var(--p)); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 4px 24px rgba(0,0,0,.35)); animation: kk-in .35s cubic-bezier(.2,.8,.2,1); }
@keyframes kk-in { from { transform: translateY(18px) scale(.96); opacity: .4; } }
.kk-l.next { font-size: clamp(22px, 3.8vw, 40px); opacity: .6; }
.kk-l.later { font-size: clamp(18px, 3vw, 30px); opacity: .3; }
.kk-ready { font-size: 15px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; opacity: .75; animation: kk-pulse 1s ease-in-out infinite alternate; }
@keyframes kk-pulse { to { opacity: .35; } }
.kk-msg { font-size: 16px; opacity: .8; }
.kk-plain { max-height: 55vh; overflow-y: auto; margin-top: 16px; font-size: 20px; font-weight: 700; line-height: 1.5; opacity: .9; }
.kk-plain p { margin: 0; }
.kk-bot { padding: 0 20px calc(env(safe-area-inset-bottom, 0px) + 24px); }
.kk-prog { height: 4px; border-radius: 4px; background: rgba(255,255,255,.2); overflow: hidden; margin-bottom: 18px; }
.kk-prog i { display: block; height: 100%; width: 0; background: #fff; }
.kk-btns { display: flex; align-items: center; justify-content: center; gap: 16px; }
.kk-pill { display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 18px; border-radius: 99px; border: 0; background: rgba(255,255,255,.14); color: #fff; font: inherit; font-size: 14px; font-weight: 800; cursor: pointer; }
.kk-pill.on { background: #fff; color: #000; }
.kk-pill:disabled { opacity: .5; cursor: default; }
.kk-pill .i { width: 18px; height: 18px; }
.kk-play { width: 64px; height: 64px; border-radius: 50%; border: 0; background: #fff; color: #000; display: grid; place-items: center; cursor: pointer; }
.kk-play .i { width: 30px; height: 30px; }
@media (max-width: 520px) { .kk-pill span { display: none; } .kk-pill { width: 44px; padding: 0; justify-content: center; } }
@media (prefers-reduced-motion: reduce) { .kk-l, .kk-l.now, .kk-ready { animation: none; transition: none; } }
` }));

AX.Karaoke = { open, close, vocals };
})();
