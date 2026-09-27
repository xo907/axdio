/* Axdio — Moments: share a song from an exact second ("listen from 1:13"), as a link or in a private chat
   (loaded after social.js). Links open the share page, and the app, right at that second. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Moments) return;
const { UI, esc, ic, coverUrl, curTrack, audio, trackLink, SITE, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const link = (t, at) => (SITE.public_url || location.origin) + trackLink(t) + (at >= 1 ? '?t=' + Math.floor(at) : '');
const M = { el: null };

function open(t, at) {
  t = t || (curTrack && curTrack());
  if (!t) { toast('Play something first'); return; }
  if (at == null) at = Math.floor(audio.currentTime || 0);
  const dur = Math.floor(audio.duration || t.dur || 0) || Math.max(at, 1);
  close();
  const chat = !!(AX.Chat && AX.E2EE && AX.E2EE.state === 'ready' && AX.Social && AX.Social.friends && AX.Social.friends().length && feat('chat'));
  const el = M.el = document.createElement('div');
  el.className = 'mo-wrap';
  el.innerHTML = `<div class="mo" role="dialog" aria-label="Share this moment"><div class="mo-h"><img src="${esc(coverUrl(t.rel))}" alt=""><span><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><button data-mo="close" aria-label="Close">${ic('close', 'sm')}</button></div>`
    + `<div class="mo-at"><small>Share from</small><b id="mo-t">${fmt(at)}</b></div>`
    + `<input type="range" class="mo-range" id="mo-r" min="0" max="${dur}" value="${Math.min(at, dur)}" aria-label="Moment">`
    + `<div class="mo-btns"><button class="mo-btn" data-mo="copy">${ic('share', 'sm')} ${navigator.share && /Mobi|Android|iPhone/.test(navigator.userAgent) ? 'Share link' : 'Copy link'}</button>`
    + (chat ? `<button class="mo-btn ghost" data-mo="friends">${ic('chat', 'sm')} Send to a friend</button>` : '') + `</div><div class="mo-fr" hidden></div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  const r = el.querySelector('#mo-r'), lab = el.querySelector('#mo-t');
  const val = () => +r.value;
  r.addEventListener('input', () => { lab.textContent = fmt(val()); r.style.setProperty('--pct', (val() / dur * 100) + '%'); });
  r.dispatchEvent(new Event('input'));
  el.addEventListener('click', async e => {
    if (e.target === el) { close(); return; }
    const b = e.target.closest('[data-mo]'); if (!b) return;
    const a = b.dataset.mo;
    if (a === 'close') close();
    else if (a === 'copy') {
      if (!feat('sharing')) { toast('Sharing is turned off on this server'); return; }
      const url = link(t, val()), text = `${t.title} by ${t.artist}, from ${fmt(val())}`;
      try {
        if (navigator.share && /Mobi|Android|iPhone/.test(navigator.userAgent)) await navigator.share({ title: t.title, text, url });
        else { await navigator.clipboard.writeText(url); toast(`Link copied: it starts at ${fmt(val())}`); }
        close();
      } catch (er) { if (er.name !== 'AbortError') toast("Couldn't share that"); }
    }
    else if (a === 'friends') {
      const box = el.querySelector('.mo-fr');
      box.hidden = !box.hidden;
      box.innerHTML = AX.Social.friends().map(f => `<button class="mo-f" data-mo="send" data-u="${esc(f.username)}">${AX.personAvatar ? AX.personAvatar(f, 'mo-av') : ''}<span>${esc(f.display_name || f.username)}</span>${ic('send', 'sm')}</button>`).join('');
    }
    else if (a === 'send') {
      try {
        const c = await AX.Chat.dm(b.dataset.u);
        await AX.Chat.send(c.id, '', { a: { k: 'track', rel: t.rel, title: t.title, sub: t.artist, at: val() } });
        toast(`Sent the moment at ${fmt(val())}, end-to-end encrypted`);
        close();
      } catch (er) { toast(er.message); }
    }
  });
  document.addEventListener('keydown', onKey);
}
function onKey(e) { if (e.key === 'Escape') close(); }
function close() { if (!M.el) return; const el = M.el; M.el = null; document.removeEventListener('keydown', onKey); el.classList.remove('on'); setTimeout(() => el.remove(), 200); }
// Playing a moment someone sent: the song from that second.
function play(t, at) {
  if (!t) return;
  AX.stageTrack(t, Math.max(0, +at || 0), true);
}

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.mo-wrap { position: fixed; inset: 0; z-index: 99985; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .2s; }
.mo-wrap.on { opacity: 1; }
.mo { width: min(400px, 100vw); background: #1d1d20; color: #fff; border-radius: 18px; padding: 16px 18px 18px; box-shadow: 0 20px 60px rgba(0,0,0,.6); transform: translateY(16px); transition: transform .25s cubic-bezier(.2,.8,.2,1); max-height: 90dvh; overflow-y: auto; }
.mo-wrap.on .mo { transform: none; }
@media (max-width: 520px) { .mo-wrap { align-items: flex-end; } .mo { border-radius: 18px 18px 0 0; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 18px); } }
.mo-h { display: flex; align-items: center; gap: 12px; }
.mo-h img { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: rgba(255,255,255,.1); }
.mo-h span { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.mo-h b { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .mo-h small { font-size: 12.5px; opacity: .65; }
.mo-h button { width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; display: grid; place-items: center; cursor: pointer; }
.mo-at { text-align: center; margin: 18px 0 8px; }
.mo-at small { display: block; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
.mo-at b { font-size: 46px; font-weight: 900; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.mo-range { width: 100%; accent-color: var(--accent, #22c55e); }
.mo-btns { display: flex; gap: 8px; margin-top: 14px; }
.mo-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 44px; border-radius: 99px; border: 0; background: #fff; color: #000; font: inherit; font-weight: 800; cursor: pointer; }
.mo-btn.ghost { background: rgba(255,255,255,.1); color: #fff; }
.mo-btn .i { width: 16px; height: 16px; }
.mo-fr { margin-top: 10px; }
.mo-f { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; border: 0; border-radius: 10px; background: none; color: #fff; font: inherit; font-weight: 700; cursor: pointer; text-align: left; }
.mo-f:hover { background: rgba(255,255,255,.07); }
.mo-f span { flex: 1; }
.mo-f .avatar.mo-av { width: 34px; height: 34px; }
.att-at { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 1px 7px; border-radius: 99px; background: rgba(34,197,94,.18); color: #86efac; font-size: 11px; font-weight: 800; }
` }));

AX.Moments = { open, close, play, link };
})();
