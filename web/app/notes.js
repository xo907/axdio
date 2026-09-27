/* Axdio — Music notes: a short line and a song for your friends, shown above their chats for 24 hours
   (loaded after social.js). Replies and reactions go to an end-to-end encrypted chat. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || !AX.Social || AX.Notes) return;
const { UI, U, esc, ic, api, coverUrl, L, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const on = () => !!(U.token && feat('social') && feat('notes'));
const N = { d: null, loading: null, t: 0, el: null };
const REACT = ['🔥', '😍', '😂', '👏', '🎧'];

async function refresh() {
  if (!on()) return null;
  if (!N.loading) N.loading = api('/api/social/notes').then(d => { N.d = d; N.t = Date.now(); paint(); return d; }).catch(() => null).finally(() => { N.loading = null; });
  return N.loading;
}
function strip() {
  if (!on()) return '';
  if (!N.d || Date.now() - N.t > 60000) refresh();
  return `<div class="nt-strip">${inner()}</div>`;
}
function paint() { document.querySelectorAll('.nt-strip').forEach(el => { el.innerHTML = inner(); }); }
function bubble(n) {
  const song = n && n.title ? `<em>${ic('note', 'sm')}${esc(n.title)}</em>` : '';
  return `<span class="nt-bub">${n && n.text ? esc(n.text) : ''}${song}</span>`;
}
function inner() {
  const d = N.d || { mine: null, friends: [] }, me = { username: U.username, display_name: U.name || U.username, avatar: U.avatar || '' };
  const mine = `<button class="nt mine" data-nt="mine" aria-label="${d.mine ? 'Your note' : 'Leave a note'}">${d.mine ? bubble(d.mine) : `<span class="nt-bub add">${ic('plus', 'sm')} Note</span>`}${AX.personAvatar ? AX.personAvatar(me, 'nt-av') : ''}<small>Your note</small></button>`;
  return mine + d.friends.map((f, i) => `<button class="nt" data-nt="friend" data-i="${i}" aria-label="${esc(f.display_name)}'s note">${bubble(f.note)}${AX.personAvatar ? AX.personAvatar(f, 'nt-av') : ''}<small>${esc(String(f.display_name || f.username).split(' ')[0])}</small></button>`).join('');
}

/* ---- Sheets ---- */
function sheet(html, wire) {
  close();
  const el = N.el = document.createElement('div');
  el.className = 'nt-wrap';
  el.innerHTML = `<div class="nt-sheet" role="dialog">${html}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-ntx="close"]')) close(); });
  wire(el);
  const first = el.querySelector('input, textarea'); if (first) setTimeout(() => first.focus(), 60);
}
function close() { if (!N.el) return; const el = N.el; N.el = null; el.classList.remove('on'); setTimeout(() => el.remove(), 200); }
function editor() {
  const d = N.d || {}, cur = AX.curTrack && AX.curTrack(), mine = d.mine;
  const song = mine && mine.rel ? L.byRel.get(mine.rel) : cur;
  sheet(`<div class="nt-h"><b>Your note</b><button data-ntx="close" aria-label="Close">${ic('close', 'sm')}</button></div>`
    + `<p class="nt-sub">Friends see it above their chats for 24 hours.</p>`
    + `<div class="nt-field"><textarea id="nt-text" maxlength="60" rows="2" placeholder="What's on your mind? 🎶">${esc(mine ? mine.text : '')}</textarea><span class="nt-count"></span></div>`
    + (song ? `<label class="nt-song"><input type="checkbox" id="nt-song"${!mine || mine.rel ? ' checked' : ''}><img src="${esc(coverUrl(song.rel))}" alt=""><span><b>${esc(song.title)}</b><small>${esc(song.artist)}</small></span></label>` : '')
    + `<div class="nt-btns">${mine ? '<button class="nt-btn ghost" data-ntx="clear">Remove note</button>' : ''}<button class="nt-btn" data-ntx="save">Share</button></div>`, el => {
    const ta = el.querySelector('#nt-text'), cnt = el.querySelector('.nt-count');
    const upd = () => { cnt.textContent = `${ta.value.length}/60`; };
    ta.addEventListener('input', upd); upd();
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.querySelector('[data-ntx="save"]').click(); } });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-ntx]'); if (!b || b.dataset.ntx === 'close') return;
      const withSong = el.querySelector('#nt-song') && el.querySelector('#nt-song').checked;
      const body = b.dataset.ntx === 'clear' ? { clear: true } : { text: ta.value, rel: withSong && song ? song.rel : null };
      if (!body.clear && !body.text.trim() && !body.rel) { toast('Write something or add a song'); return; }
      try { await api('/api/social/note', body); close(); await refresh(); toast(body.clear ? 'Note removed' : 'Your note is up for 24 hours'); } catch (er) { toast(er.message); }
    });
  });
}
function viewer(f) {
  const n = f.note, t = n.rel && L.byRel.get(n.rel), ago = AX.agoText ? AX.agoText(n.ts * 1000) : '';
  sheet(`<div class="nt-h"><span class="nt-who">${AX.personAvatar ? AX.personAvatar(f, 'nt-av') : ''}<span><b>${esc(f.display_name || f.username)}</b><small>${esc(ago)}</small></span></span><button data-ntx="close" aria-label="Close">${ic('close', 'sm')}</button></div>`
    + (n.text ? `<p class="nt-big">${esc(n.text)}</p>` : '')
    + (t ? `<div class="nt-card"><img src="${esc(coverUrl(t.rel))}" alt=""><span><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><button class="nt-play" data-ntx="play" aria-label="Play">${ic('play')}</button></div>` : '')
    + `<div class="nt-react">${REACT.map(r => `<button data-ntx="react" data-r="${r}">${r}</button>`).join('')}</div>`
    + `<form class="nt-reply"><input id="nt-reply" maxlength="500" placeholder="Reply to ${esc(String(f.display_name || f.username).split(' ')[0])}…" autocomplete="off"><button aria-label="Send">${ic('send', 'sm')}</button></form>`, el => {
    const send = async text => {
      if (!AX.Chat || !AX.E2EE || AX.E2EE.state !== 'ready') { toast('Turn on private messages (in Messages) to reply'); return; }
      try {
        const c = await AX.Chat.dm(f.username);
        const quote = `↪ Your note${n.text ? `: “${n.text}”` : ''}${t ? ` (${t.title})` : ''}\n${text}`;
        await AX.Chat.send(c.id, quote, t && AX.attachTrack ? { a: AX.attachTrack(t) } : {});
        close(); toast(`Sent to ${f.display_name || f.username}, end-to-end encrypted`);
      } catch (er) { toast(er.message); }
    };
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-ntx]'); if (!b) return;
      if (b.dataset.ntx === 'play' && t) { AX.playTrackAlone(t.id); close(); }
      else if (b.dataset.ntx === 'react') send(b.dataset.r);
    });
    el.querySelector('.nt-reply').addEventListener('submit', e => { e.preventDefault(); const v = el.querySelector('#nt-reply').value.trim(); if (v) send(v); });
  });
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-nt]'); if (!b || b.closest('.nt-wrap')) return;
  e.preventDefault(); e.stopPropagation();
  if (b.dataset.nt === 'mine') editor();
  else { const f = N.d && N.d.friends[+b.dataset.i]; if (f) viewer(f); }
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && N.el) close(); });
setInterval(() => { if (on() && !document.hidden && document.querySelector('.nt-strip')) refresh(); }, 90000);

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.nt-strip { display: flex; gap: 6px; overflow-x: auto; padding: 54px 12px 10px; scrollbar-width: none; }
.nt-strip::-webkit-scrollbar { display: none; }
.nt { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 0 0 auto; width: 78px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; padding: 0; }
.nt .avatar.nt-av { width: 58px; height: 58px; font-size: 22px; }
.nt small { font-size: 11.5px; font-weight: 600; opacity: .75; max-width: 76px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nt-bub { position: absolute; bottom: calc(100% - 22px); left: 50%; transform: translate(-50%, -8px); z-index: 1; width: max-content; max-width: 112px; min-width: 44px; padding: 6px 9px; border-radius: 14px; background: #2a2a2e; color: #fff; font-size: 11.5px; font-weight: 600; line-height: 1.25; box-shadow: 0 4px 14px rgba(0,0,0,.4);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-align: center; word-break: break-word; }
.nt-bub::after { content: ''; position: absolute; bottom: -5px; left: 50%; width: 9px; height: 9px; margin-left: -4px; border-radius: 50%; background: #2a2a2e; }
.nt-bub em { display: flex; align-items: center; justify-content: center; gap: 3px; font-style: normal; font-size: 10.5px; opacity: .75; margin-top: 2px; white-space: nowrap; overflow: hidden; }
.nt-bub em .i { width: 11px; height: 11px; flex-shrink: 0; }
.nt-bub.add { display: inline-flex; align-items: center; gap: 3px; opacity: .8; white-space: nowrap; }
.nt-bub.add .i { width: 13px; height: 13px; }
.nt:hover .nt-bub { background: #36363b; } .nt:hover .nt-bub::after { background: #36363b; }
.nt-wrap { position: fixed; inset: 0; z-index: 99985; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .2s; }
.nt-wrap.on { opacity: 1; }
.nt-sheet { width: min(420px, 100vw); background: #1d1d20; color: #fff; border-radius: 18px; padding: 16px 18px 18px; box-shadow: 0 20px 60px rgba(0,0,0,.6); transform: translateY(20px); transition: transform .25s cubic-bezier(.2,.8,.2,1); }
.nt-wrap.on .nt-sheet { transform: none; }
@media (max-width: 520px) { .nt-wrap { align-items: flex-end; } .nt-sheet { border-radius: 18px 18px 0 0; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 18px); } }
.nt-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nt-h b { font-size: 17px; font-weight: 800; }
.nt-h button { width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }
.nt-who { display: flex; align-items: center; gap: 10px; }
.nt-who .avatar { width: 40px; height: 40px; }
.nt-who span { display: flex; flex-direction: column; } .nt-who small { font-size: 12px; opacity: .6; }
.nt-sub { font-size: 13px; opacity: .65; margin: 4px 0 12px; }
.nt-field { position: relative; }
.nt-field textarea { width: 100%; box-sizing: border-box; resize: none; border-radius: 12px; border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.06); color: #fff; font: inherit; font-size: 16px; padding: 12px 14px 22px; outline: 0; }
.nt-field textarea:focus { border-color: rgba(255,255,255,.4); }
.nt-count { position: absolute; right: 12px; bottom: 8px; font-size: 11px; opacity: .5; }
.nt-song { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 8px; border-radius: 12px; background: rgba(255,255,255,.05); cursor: pointer; }
.nt-song input { width: 18px; height: 18px; accent-color: var(--accent, #22c55e); }
.nt-song img, .nt-card img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; background: rgba(255,255,255,.1); }
.nt-song span, .nt-card span { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nt-song b, .nt-card b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nt-song small, .nt-card small { font-size: 12px; opacity: .65; }
.nt-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.nt-btn { height: 40px; padding: 0 18px; border-radius: 99px; border: 0; background: #fff; color: #000; font: inherit; font-weight: 800; cursor: pointer; }
.nt-btn.ghost { background: rgba(255,255,255,.1); color: #fff; }
.nt-big { font-size: 22px; font-weight: 800; letter-spacing: -.01em; line-height: 1.3; margin: 16px 2px 12px; word-break: break-word; }
.nt-card { display: flex; align-items: center; gap: 12px; padding: 10px; border-radius: 12px; background: rgba(255,255,255,.07); margin-bottom: 12px; }
.nt-play { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--accent, #22c55e); color: #000; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }
.nt-react { display: flex; justify-content: space-between; margin: 6px 0 12px; }
.nt-react button { width: 52px; height: 52px; border-radius: 50%; border: 0; background: rgba(255,255,255,.07); font-size: 24px; cursor: pointer; transition: transform .15s; }
.nt-react button:hover { transform: scale(1.12); }
.nt-reply { display: flex; gap: 8px; }
.nt-reply input { flex: 1; min-width: 0; height: 44px; border-radius: 99px; border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.06); color: #fff; font: inherit; font-size: 15px; padding: 0 16px; outline: 0; }
.nt-reply button { width: 44px; height: 44px; border-radius: 50%; border: 0; background: var(--accent, #22c55e); color: #000; display: grid; place-items: center; cursor: pointer; }
` }));

AX.Notes = { refresh, strip };
})();
