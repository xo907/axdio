/* Axdio — Friends Chart (this week's top 20 among you and your friends) and the Time capsule (on this day in earlier
   years, and forgotten favourites). Loaded after core.js. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Chart) return;
const { UI, U, esc, ic, api, coverUrl, L, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const C = { chart: null, cap: null, busy: {}, el: null };
const cover = rel => { const t = L.byRel.get(rel); return t && t.hc ? `<img src="${esc(coverUrl(rel))}" alt="" loading="lazy">` : `<span class="ch-noart">${ic('note', 'sm')}</span>`; };

function load(k, url) {
  if (C.busy[k]) return C.busy[k];
  C.busy[k] = api(url).then(d => { C[k] = d; if (UI.dirty) UI.dirty(['home']); return d; }).catch(() => null).finally(() => { C.busy[k] = null; });
  return C.busy[k];
}
const chartOn = () => !!(U.token && feat('social') && feat('chart'));
const capOn = () => !!(U.token && feat('capsule'));

/* ---- Home cards ---- */
function chartCard() {
  if (!chartOn()) return '';
  if (!C.chart && !C.busy.chart) load('chart', '/api/social/chart');
  const d = C.chart;
  if (!d || !d.friends || !d.items.length) return '';
  const top = d.items[0];
  return `<div class="hcard ch-hc" data-ch="chart" role="button" aria-label="Friends Chart"><span class="ch-hc-n">#1</span>`
    + `<span class="hcard-t"><small>Friends Chart · this week</small><b>${esc(top.title)}</b><span>${esc(top.artist)} · ${top.n_listeners > 1 ? `${top.n_listeners} of you` : esc(top.listeners[0].display_name)}</span></span><span class="hcard-go">${ic('chart')}</span></div>`;
}
function capCard() {
  if (!capOn()) return '';
  if (!C.cap && !C.busy.cap) load('cap', '/api/timecapsule?tz=' + new Date().getTimezoneOffset());
  const d = C.cap;
  if (!d) return '';
  const y = d.years && d.years[0];
  if (y) return `<div class="hcard cap-hc" data-ch="capsule" role="button" aria-label="On this day">${cover(y.songs[0].rel)}`
    + `<span class="hcard-t"><small>On this day · ${y.ago} ${y.ago === 1 ? 'year' : 'years'} ago</small><b>${esc(y.songs[0].title)}</b><span>You were listening to ${y.songs.length > 1 ? `this and ${y.songs.length - 1} more` : 'this'}</span></span><span class="hcard-go">${ic('history')}</span></div>`;
  if (d.rediscover && d.rediscover.length >= 3) return `<div class="hcard cap-hc" data-ch="capsule" role="button" aria-label="Forgotten favourites">${cover(d.rediscover[0].rel)}`
    + `<span class="hcard-t"><small>Time capsule</small><b>Forgotten favourites</b><span>${d.rediscover.length} songs you loved and haven't played lately</span></span><span class="hcard-go">${ic('history')}</span></div>`;
  if (d.month && d.month.songs.length) return `<div class="hcard cap-hc" data-ch="capsule" role="button" aria-label="A month ago">${cover(d.month.songs[0].rel)}`
    + `<span class="hcard-t"><small>A month ago today</small><b>${esc(d.month.songs[0].title)}</b><span>What you were playing</span></span><span class="hcard-go">${ic('history')}</span></div>`;
  return '';
}

/* ---- The overlay ---- */
function sheet(title, iconName, body) {
  close();
  const el = C.el = document.createElement('div');
  el.className = 'ch'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="ch-card"><header><b>${ic(iconName, 'sm')} ${esc(title)}</b><button class="ch-x" data-ch="close" aria-label="Close">${ic('close')}</button></header><div class="ch-body">${body}</div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  el.addEventListener('click', e => {
    if (e.target === el) { close(); return; }
    const b = e.target.closest('[data-ch]'); if (!b) return;
    e.stopPropagation();
    if (b.dataset.ch === 'close') close();
    else if (b.dataset.ch === 'play') { const ids = b.dataset.rels.split('\n').map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id); const at = +(b.dataset.at || 0); if (ids.length) { AX.playCtx(AX.makeCtx('list', b.dataset.key, b.dataset.name, ids), at); close(); } }
  });
  document.addEventListener('keydown', onKey);
}
function onKey(e) { if (e.key === 'Escape') close(); }
function close() { if (!C.el) return; const el = C.el; C.el = null; document.removeEventListener('keydown', onKey); el.classList.remove('on'); setTimeout(() => el.remove(), 200); }
function playAll(songs, key, name, label = 'Play all') {
  return `<button class="ch-play" data-ch="play" data-key="${esc(key)}" data-name="${esc(name)}" data-rels="${esc(songs.map(s => s.rel).join('\n'))}">${ic('play', 'sm')} ${label}</button>`;
}
function rows(songs, key, name, extra) {
  const rels = esc(songs.map(s => s.rel).join('\n'));
  return `<ol class="ch-list">${songs.map((s, i) => `<li data-ch="play" data-key="${esc(key)}" data-name="${esc(name)}" data-rels="${rels}" data-at="${i}">${extra ? extra(s, i) : ''}${cover(s.rel)}<span class="ch-t"><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span>${s._right || ''}</li>`).join('')}</ol>`;
}
function move(s) {
  if (s.prev == null) return '<span class="ch-mv new">NEW</span>';
  if (s.prev === s.rank) return '<span class="ch-mv same">=</span>';
  return s.prev > s.rank ? `<span class="ch-mv up">▲${s.prev - s.rank}</span>` : `<span class="ch-mv down">▼${s.rank - s.prev}</span>`;
}
async function openChart() {
  sheet('Friends Chart', 'chart', '<div class="ch-load"></div>');
  const d = await load('chart', '/api/social/chart');
  if (!C.el) return;
  const box = C.el.querySelector('.ch-body');
  if (!d || !d.items.length) { box.innerHTML = `<p class="ch-empty">${d && !d.friends ? 'Add friends to see what you all play most each week.' : 'No plays yet this week. Press play and check back!'}</p>`; return; }
  d.items.forEach(s => { s._right = `<span class="ch-who">${s.listeners.map(p => AX.personAvatar ? AX.personAvatar(p, 'ch-av') : '').join('')}<small>${s.plays} ${s.plays === 1 ? 'play' : 'plays'}</small></span>`; });
  box.innerHTML = `<p class="ch-sub">The week's most played among you and ${d.friends} ${d.friends === 1 ? 'friend' : 'friends'}. Songs more of you play rank higher.</p>`
    + playAll(d.items, 'friends-chart', 'Friends Chart') + rows(d.items, 'friends-chart', 'Friends Chart', (s) => `<span class="ch-rank">${s.rank}</span>${move(s)}`);
}
async function openCapsule() {
  sheet('Time capsule', 'history', '<div class="ch-load"></div>');
  const d = await load('cap', '/api/timecapsule?tz=' + new Date().getTimezoneOffset());
  if (!C.el) return;
  const box = C.el.querySelector('.ch-body');
  if (!d) { box.innerHTML = '<p class="ch-empty">Couldn\'t open the time capsule.</p>'; return; }
  let h = '';
  const when = new Date(d.today + 'T12:00:00').toLocaleDateString([], { month: 'long', day: 'numeric' });
  d.years.forEach(y => { h += `<div class="ch-sec"><b>${when}, ${y.year}</b><span>${y.ago} ${y.ago === 1 ? 'year' : 'years'} ago</span></div>${playAll(y.songs, 'otd:' + y.year, `On this day in ${y.year}`)}${rows(y.songs, 'otd:' + y.year, `On this day in ${y.year}`)}`; });
  if (d.month) h += `<div class="ch-sec"><b>A month ago today</b><span>${new Date(d.month.date + 'T12:00:00').toLocaleDateString([], { month: 'long', day: 'numeric' })}</span></div>${playAll(d.month.songs, 'month-ago', 'A month ago')}${rows(d.month.songs, 'month-ago', 'A month ago')}`;
  if (d.rediscover.length) {
    d.rediscover.forEach(s => { s._right = `<small class="ch-plays">${s.plays} plays</small>`; });
    h += `<div class="ch-sec"><b>Forgotten favourites</b><span>Songs you loved and haven't played in over six weeks</span></div>${playAll(d.rediscover, 'rediscover', 'Forgotten favourites', 'Rediscover them')}${rows(d.rediscover, 'rediscover', 'Forgotten favourites')}`;
  }
  box.innerHTML = h || '<p class="ch-empty">Nothing in the capsule yet. Keep listening: next year, today will be here.</p>';
}

document.addEventListener('click', e => {
  const c = e.target.closest('[data-ch="chart"], [data-ch="capsule"]');
  if (!c || c.closest('.ch')) return;
  e.preventDefault();
  if (c.dataset.ch === 'chart') openChart(); else openCapsule();
});
if (AX.HOME_CARDS) AX.HOME_CARDS.push(chartCard, capCard);
setInterval(() => { if (!document.hidden) { if (chartOn()) load('chart', '/api/social/chart'); } }, 10 * 60 * 1000);

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.ch { position: fixed; inset: 0; z-index: 99975; background: rgba(0,0,0,.7); backdrop-filter: blur(6px); display: grid; place-items: center; opacity: 0; transition: opacity .2s; color: #fff; }
.ch.on { opacity: 1; }
.ch-card { width: min(560px, 100vw); max-height: min(92dvh, 900px); overflow-y: auto; border-radius: 20px; padding: 18px 18px 22px; background: linear-gradient(170deg, #10233a, #121212 45%); box-shadow: 0 30px 90px rgba(0,0,0,.6); }
@media (max-width: 560px) { .ch-card { height: 100dvh; max-height: none; border-radius: 0; padding: calc(env(safe-area-inset-top, 0px) + 12px) 14px calc(env(safe-area-inset-bottom, 0px) + 24px); } }
.ch header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.ch header b { display: inline-flex; align-items: center; gap: 8px; font-size: 19px; font-weight: 900; }
.ch header b .i { width: 22px; height: 22px; color: #38bdf8; }
.ch-x { width: 38px; height: 38px; border: 0; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; display: grid; place-items: center; cursor: pointer; }
.ch-sub { font-size: 13px; opacity: .65; margin: 0 0 12px; }
.ch-load { height: 160px; }
.ch-empty { opacity: .7; padding: 30px 6px; text-align: center; }
.ch-play { display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 16px; border-radius: 99px; border: 0; background: var(--accent, #22c55e); color: #000; font: inherit; font-size: 14px; font-weight: 800; cursor: pointer; margin: 2px 0 10px; }
.ch-play .i { width: 16px; height: 16px; }
.ch-list { list-style: none; margin: 0; padding: 0; }
.ch-list li { display: flex; align-items: center; gap: 12px; padding: 7px 8px; border-radius: 10px; cursor: pointer; }
.ch-list li:hover { background: rgba(255,255,255,.06); }
.ch-list img, .ch-noart { width: 46px; height: 46px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
.ch-noart { display: grid; place-items: center; background: rgba(255,255,255,.08); }
.ch-t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ch-t b { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ch-t small { font-size: 12.5px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ch-rank { width: 26px; text-align: center; font-size: 18px; font-weight: 900; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.ch-mv { width: 34px; font-size: 11px; font-weight: 900; flex-shrink: 0; text-align: center; }
.ch-mv.up { color: #4ade80; } .ch-mv.down { color: #f87171; } .ch-mv.same { opacity: .5; }
.ch-mv.new { color: #000; background: #facc15; border-radius: 4px; padding: 2px 0; font-size: 9.5px; letter-spacing: .04em; }
.ch-who { display: flex; align-items: center; flex-shrink: 0; }
.ch-who .avatar.ch-av { width: 24px; height: 24px; font-size: 10px; margin-left: -7px; box-shadow: 0 0 0 2px #121212; }
.ch-who small { font-size: 11.5px; opacity: .6; margin-left: 8px; white-space: nowrap; }
.ch-plays { font-size: 12px; opacity: .6; flex-shrink: 0; }
.ch-sec { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 18px 0 8px; }
.ch-sec b { font-size: 16px; font-weight: 900; } .ch-sec span { font-size: 12px; opacity: .6; text-align: right; }
.ch-hc { background: linear-gradient(120deg, #0369a1, #0f766e 60%, #115e59); }
.ch-hc-n { width: 56px; height: 56px; border-radius: 12px; background: rgba(255,255,255,.16); display: grid; place-items: center; font-size: 22px; font-weight: 900; flex-shrink: 0; position: relative; z-index: 1; }
.cap-hc { background: linear-gradient(120deg, #4c1d95, #7e22ce 50%, #a21caf); }
.cap-hc > img, .cap-hc > .ch-noart { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex-shrink: 0; position: relative; z-index: 1; box-shadow: 0 6px 16px rgba(0,0,0,.35); transform: rotate(-4deg); }
` }));

AX.Chart = { open: openChart, card: chartCard };
AX.Capsule = { open: openCapsule, card: capCard };
})();
