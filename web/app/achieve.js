/* Axdio — levels, streaks and achievements (loaded after core.js).
   The server works everything out from listening (GET /api/achievements); this shows it off: a level on Home, a trophy
   room, and a celebration whenever a badge or level is earned. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Achieve) return;
const { UI, U, esc, ic, api, LS, feat } = AX;
const on = () => !!(U.token && feat('achievements'));
const TIER = ['Locked', 'Bronze', 'Silver', 'Gold'];
const A = { d: null, loading: null, queue: [], showing: false, el: null, t: 0 };
const seenKey = () => 'axdio_ach_' + U.username;
const tz = () => new Date().getTimezoneOffset();

async function refresh() {
  if (!on()) return null;
  if (A.loading) return A.loading;
  A.loading = api('/api/achievements?tz=' + tz()).then(d => {
    const before = A.d; A.d = d; A.t = Date.now();
    celebrate(d);
    if (!before || before.level !== d.level || before.streak !== d.streak || before.played_today !== d.played_today) { if (UI.dirty) UI.dirty(['home']); }
    nudge(d);
    return d;
  }).catch(() => null).finally(() => { A.loading = null; });
  return A.loading;
}
// New badges and levels since this device last looked. The very first look just takes note, so nobody gets 15 pop-ups.
function celebrate(d) {
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(seenKey()) || 'null'); } catch (e) { /* storage off */ }
  const now = { level: d.level, tiers: Object.fromEntries(d.badges.map(b => [b.id, b.tier])) };
  try { localStorage.setItem(seenKey(), JSON.stringify(now)); } catch (e) { /* storage off */ }
  if (!seen) return;
  d.badges.forEach(b => { if (b.tier > (seen.tiers[b.id] || 0)) A.queue.push({ k: 'badge', b }); });
  if (d.level > seen.level) A.queue.push({ k: 'level', level: d.level });
  if (!A.showing) next();
}
function nudge(d) {
  if (!d.streak || d.played_today || new Date().getHours() < 18) return;
  const k = 'axdio_nudge_' + U.username, day = new Date().toDateString();
  try { if (localStorage.getItem(k) === day) return; localStorage.setItem(k, day); } catch (e) { return; }
  if (UI.toast) UI.toast(`Keep your ${d.streak}-day streak going: play something today`);
}

/* ---- Medals ---- */
function medal(b, size = '') {
  return `<span class="ach-medal t${b.tier}${size ? ' ' + size : ''}" aria-hidden="true"><span class="ach-ring"></span>${ic(b.icon)}${b.tier ? `<span class="ach-tier">${'★'.repeat(b.tier)}</span>` : ''}</span>`;
}
function ring(d, r = 54) {
  const c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, (d.xp - d.level_from) / Math.max(1, d.level_to - d.level_from)));
  return `<svg class="ach-lvl" viewBox="0 0 ${r * 2 + 16} ${r * 2 + 16}"><circle cx="${r + 8}" cy="${r + 8}" r="${r}" class="bg"/><circle cx="${r + 8}" cy="${r + 8}" r="${r}" class="fg" style="stroke-dasharray:${c};stroke-dashoffset:${c * (1 - p)}"/>`
    + `<text x="50%" y="46%" class="n">${d.level}</text><text x="50%" y="66%" class="l">LEVEL</text></svg>`;
}

/* ---- Home card ---- */
function homeCard() {
  if (!on()) return '';
  if (!A.d && !A.loading) refresh();
  const d = A.d;
  if (!d) return '';
  const toNext = d.level_to - d.xp;
  const sub = d.streak && !d.played_today ? `Play a song today to keep your ${d.streak}-day streak` : `${toNext.toLocaleString()} XP to level ${d.level + 1}`;
  const unlocked = d.badges.filter(b => b.tier).length;
  return `<div class="hcard ach-hc" data-ach="open" role="button" aria-label="Your level and achievements">${ring(d, 26)}`
    + `<span class="hcard-t"><small>${unlocked} of ${d.badges.length} badges${d.streak ? ` · ${d.streak}-day streak` : ''}</small><b>Level ${d.level}</b><span>${esc(sub)}</span></span>`
    + `${d.streak ? `<span class="ach-flame${d.played_today ? '' : ' cold'}">${ic('flame')}<b>${d.streak}</b></span>` : `<span class="hcard-go">${ic('trophy')}</span>`}</div>`;
}

/* ---- Trophy room ---- */
async function open() {
  if (!on()) { if (UI.toast) UI.toast(U.token ? 'Achievements are turned off on this server' : 'Log in to earn achievements'); return; }
  if (A.el) return;
  const el = A.el = document.createElement('div');
  el.className = 'ach'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Achievements');
  el.innerHTML = `<div class="ach-card"><header><b>${ic('trophy', 'sm')} Achievements</b><button class="ach-x" data-ach="close" aria-label="Close">${ic('close')}</button></header><div class="ach-body"><div class="ach-load"></div></div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-ach="close"]')) close(); });
  document.addEventListener('keydown', onKey);
  const d = (Date.now() - A.t < 30000 && A.d) || await refresh();
  if (!A.el) return;
  if (!d) { el.querySelector('.ach-body').innerHTML = '<p class="ach-empty">Couldn\'t load your achievements.</p>'; return; }
  const got = d.badges.filter(b => b.tier).sort((a, b) => b.tier - a.tier), locked = d.badges.filter(b => !b.tier);
  el.querySelector('.ach-body').innerHTML = `<div class="ach-top">${ring(d)}<div class="ach-facts"><div><b>${d.xp.toLocaleString()}</b><span>XP</span></div><div><b>${(d.level_to - d.xp).toLocaleString()}</b><span>to level ${d.level + 1}</span></div>`
    + `<div class="ach-st${d.played_today ? '' : ' cold'}">${ic('flame', 'sm')}<b>${d.streak}</b><span>day streak · best ${d.best_streak}</span></div><div><b>${(d.minutes < 120 ? d.minutes : Math.round(d.minutes / 60)).toLocaleString()}</b><span>${d.minutes < 120 ? 'minutes' : 'hours'} of music</span></div></div></div>`
    + `<p class="ach-how">1 XP for every minute you listen. Bonus XP for Axdio Daily wins, Discover finds and hosting parties.</p>`
    + `<div class="ach-sec">Earned · ${got.length}</div><div class="ach-grid">${got.map(badgeHtml).join('') || '<p class="ach-empty">Your first badge is a few songs away.</p>'}</div>`
    + (locked.length ? `<div class="ach-sec">To unlock · ${locked.length}</div><div class="ach-grid">${locked.map(badgeHtml).join('')}</div>` : '');
}
function badgeHtml(b) {
  const p = b.next ? Math.min(1, (b.value - b.prev) / Math.max(1, b.next - b.prev)) : 1;
  return `<div class="ach-b">${medal(b)}<b>${esc(b.name)}</b><small>${b.tier ? TIER[b.tier] : esc(b.what)}</small>`
    + `<div class="ach-bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div><span class="ach-v">${b.next ? `${b.value.toLocaleString()} / ${b.next.toLocaleString()}` : `${b.value.toLocaleString()} · maxed`}</span>`
    + (b.tier ? `<span class="ach-what">${esc(b.what)}</span>` : '') + `</div>`;
}
function close() {
  if (!A.el) return;
  const el = A.el; A.el = null;
  document.removeEventListener('keydown', onKey);
  el.classList.remove('on'); setTimeout(() => el.remove(), 200);
}
function onKey(e) { if (e.key === 'Escape') close(); }

/* ---- Celebrations ---- */
function next() {
  const it = A.queue.shift();
  if (!it) { A.showing = false; return; }
  A.showing = true;
  const el = document.createElement('div');
  el.className = 'ach-pop';
  el.innerHTML = it.k === 'badge'
    ? `<div class="ach-pop-card">${medal(it.b, 'big')}<small>Achievement unlocked</small><b>${esc(it.b.name)}</b><span>${TIER[it.b.tier]} · ${esc(it.b.what)}: ${it.b.value.toLocaleString()}</span></div>`
    : `<div class="ach-pop-card lvl"><span class="ach-up">${it.level}</span><small>Level up!</small><b>You reached level ${it.level}</b><span>Keep listening to climb higher</span></div>`;
  el.insertAdjacentHTML('beforeend', `<div class="ach-conf">${Array.from({ length: 40 }, () => `<i style="--x:${(Math.random() * 100).toFixed(1)}%;--d:${(Math.random() * .5).toFixed(2)}s;--h:${Math.round(Math.random() * 360)};--r:${Math.round(Math.random() * 900 - 450)}deg"></i>`).join('')}</div>`);
  document.body.appendChild(el);
  if (navigator.vibrate) try { navigator.vibrate([20, 40, 20]); } catch (e) { /* no vibration */ }
  requestAnimationFrame(() => el.classList.add('on'));
  const done = () => { el.classList.remove('on'); setTimeout(() => { el.remove(); next(); }, 300); };
  const t = setTimeout(done, 4200);
  el.addEventListener('click', () => { clearTimeout(t); done(); }, { once: true });
}

/* ---- On profiles (friends see level, streak and best badges) ---- */
function profileHtml(pr) {
  const a = pr && pr.achievements; if (!a) return '';
  return `<div class="ach-prof"><span class="ach-chip">${ic('trophy', 'sm')} Level ${a.level}</span>${a.streak ? `<span class="ach-chip fire">${ic('flame', 'sm')} ${a.streak}-day streak</span>` : ''}`
    + a.badges.map(b => `<span class="ach-mini" title="${esc(b.name)} · ${TIER[b.tier]}">${medal(b, 'sm')}<small>${esc(b.name)}</small></span>`).join('') + `</div>`;
}

document.addEventListener('click', e => { const c = e.target.closest('[data-ach="open"]'); if (c && !c.closest('.ach')) { e.preventDefault(); open(); } });
if (AX.HOME_CARDS) AX.HOME_CARDS.push(homeCard);
// Check in now and then: after listening for a while, a badge may be waiting.
setInterval(() => { if (on() && !document.hidden) refresh(); }, 4 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && on() && Date.now() - A.t > 60000) refresh(); });
setTimeout(() => { if (on()) refresh(); }, 4000);

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.ach-medal { position: relative; display: inline-grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; color: rgba(255,255,255,.35);
  background: radial-gradient(circle at 35% 30%, #3f3f46, #18181b); box-shadow: inset 0 0 0 2px rgba(255,255,255,.08); }
.ach-medal .i { width: 30px; height: 30px; position: relative; z-index: 1; }
.ach-medal.t1 { color: #fff7ed; background: radial-gradient(circle at 35% 30%, #f5b67a, #9a5418 70%); box-shadow: 0 6px 18px rgba(205,127,50,.45), inset 0 0 0 3px rgba(255,255,255,.25); }
.ach-medal.t2 { color: #fff; background: radial-gradient(circle at 35% 30%, #f1f5f9, #7c8796 70%); box-shadow: 0 6px 18px rgba(203,213,225,.45), inset 0 0 0 3px rgba(255,255,255,.4); }
.ach-medal.t3 { color: #fffbeb; background: radial-gradient(circle at 35% 30%, #fde68a, #b45309 72%); box-shadow: 0 6px 22px rgba(250,204,21,.6), inset 0 0 0 3px rgba(255,255,255,.35); }
.ach-medal.t3::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,255,255,.55), transparent 30%); animation: ach-spin 3s linear infinite; mask: radial-gradient(circle, transparent 60%, #000 62%); -webkit-mask: radial-gradient(circle, transparent 60%, #000 62%); }
@keyframes ach-spin { to { transform: rotate(360deg); } }
.ach-tier { position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); z-index: 2; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 99px; background: #111; color: #facc15; letter-spacing: 1px; white-space: nowrap; }
.ach-medal.big { width: 120px; height: 120px; } .ach-medal.big .i { width: 58px; height: 58px; } .ach-medal.big .ach-tier { font-size: 14px; bottom: -8px; }
.ach-medal.sm { width: 36px; height: 36px; } .ach-medal.sm .i { width: 18px; height: 18px; } .ach-medal.sm .ach-tier { display: none; }
.ach-lvl { width: 128px; height: 128px; flex-shrink: 0; }
.ach-lvl .bg { fill: none; stroke: rgba(255,255,255,.12); stroke-width: 9; }
.ach-lvl .fg { fill: none; stroke: #facc15; stroke-width: 9; stroke-linecap: round; transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1); }
.ach-lvl .n { fill: #fff; font-size: 38px; font-weight: 900; text-anchor: middle; dominant-baseline: middle; font-family: inherit; }
.ach-lvl .l { fill: rgba(255,255,255,.65); font-size: 12px; font-weight: 800; letter-spacing: .12em; text-anchor: middle; font-family: inherit; }
.ach-hc { background: linear-gradient(120deg, #92400e, #b45309 40%, #7c2d12); }
.ach-hc .ach-lvl { width: 60px; height: 60px; position: relative; z-index: 1; }
.ach-hc .ach-lvl .n { font-size: 24px; } .ach-hc .ach-lvl .l { font-size: 8px; }
.ach-hc .ach-lvl .bg, .ach-hc .ach-lvl .fg { stroke-width: 6; }
.ach-flame { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; color: #fb923c; filter: drop-shadow(0 2px 8px rgba(251,146,60,.6)); }
.ach-flame .i { width: 34px; height: 34px; animation: ach-flicker 1.6s ease-in-out infinite alternate; }
.ach-flame b { font-size: 14px; font-weight: 900; color: #fff; margin-top: -4px; }
.ach-flame.cold { color: #94a3b8; filter: none; } .ach-flame.cold .i { animation: none; }
@keyframes ach-flicker { 50% { transform: scale(1.08) rotate(-3deg); } }
.ach { position: fixed; inset: 0; z-index: 99975; background: rgba(0,0,0,.72); backdrop-filter: blur(6px); display: grid; place-items: center; opacity: 0; transition: opacity .2s; color: #fff; }
.ach.on { opacity: 1; }
.ach-card { width: min(640px, 100vw); max-height: min(92dvh, 900px); overflow-y: auto; border-radius: 20px; padding: 18px 20px 24px; background: linear-gradient(170deg, #2a1d0e, #16120d 40%, #111); box-shadow: 0 30px 90px rgba(0,0,0,.6); }
@media (max-width: 640px) { .ach-card { height: 100dvh; max-height: none; border-radius: 0; padding: calc(env(safe-area-inset-top, 0px) + 12px) 16px calc(env(safe-area-inset-bottom, 0px) + 24px); } }
.ach header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.ach header b { display: inline-flex; align-items: center; gap: 8px; font-size: 19px; font-weight: 900; }
.ach header b .i { color: #facc15; width: 22px; height: 22px; }
.ach-x { width: 38px; height: 38px; border: 0; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; display: grid; place-items: center; cursor: pointer; }
.ach-load { height: 200px; }
.ach-top { display: flex; align-items: center; gap: 18px; }
.ach-facts { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.ach-facts b { display: block; font-size: 22px; font-weight: 900; line-height: 1.1; }
.ach-facts span { font-size: 12px; font-weight: 700; opacity: .65; }
.ach-st { color: #fb923c; } .ach-st .i { width: 18px; height: 18px; float: left; margin: 3px 4px 0 0; }
.ach-st.cold { color: #94a3b8; }
.ach-st span { color: #fff; }
.ach-how { font-size: 12.5px; opacity: .6; margin: 14px 0 6px; line-height: 1.45; }
.ach-sec { font-size: 12px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; opacity: .6; margin: 18px 0 10px; }
.ach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; }
.ach-b { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 3px; padding: 14px 8px 12px; border-radius: 14px; background: rgba(255,255,255,.05); }
.ach-b > b { font-size: 14px; font-weight: 800; margin-top: 8px; }
.ach-b > small { font-size: 11px; font-weight: 700; opacity: .7; line-height: 1.3; }
.ach-bar { width: 80%; height: 5px; border-radius: 5px; background: rgba(255,255,255,.12); overflow: hidden; margin-top: 6px; }
.ach-bar i { display: block; height: 100%; background: linear-gradient(90deg, #f59e0b, #facc15); }
.ach-v { font-size: 11px; font-weight: 700; opacity: .6; font-variant-numeric: tabular-nums; }
.ach-what { font-size: 10.5px; opacity: .5; line-height: 1.3; }
.ach-empty { opacity: .6; font-size: 14px; grid-column: 1 / -1; }
.ach-pop { position: fixed; inset: 0; z-index: 100001; display: grid; place-items: center; background: rgba(0,0,0,.55); opacity: 0; transition: opacity .3s; cursor: pointer; }
.ach-pop.on { opacity: 1; }
.ach-pop-card { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 30px 34px; border-radius: 24px; background: linear-gradient(170deg, #2a1d0e, #111); color: #fff; box-shadow: 0 30px 90px rgba(0,0,0,.6); transform: scale(.7); transition: transform .5s cubic-bezier(.2,1.4,.3,1); max-width: 88vw; }
.ach-pop.on .ach-pop-card { transform: none; }
.ach-pop-card small { margin-top: 14px; font-size: 12px; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; color: #facc15; }
.ach-pop-card b { font-size: 26px; font-weight: 900; letter-spacing: -.02em; }
.ach-pop-card span { font-size: 14px; opacity: .75; }
.ach-up { display: grid; place-items: center; width: 120px; height: 120px; border-radius: 50%; font-size: 56px; font-weight: 900; background: radial-gradient(circle at 35% 30%, #fde68a, #b45309 72%); box-shadow: 0 10px 40px rgba(250,204,21,.6); }
.ach-conf { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.ach-conf i { position: absolute; top: -12px; left: var(--x); width: 8px; height: 14px; border-radius: 2px; background: hsl(var(--h), 90%, 60%); animation: ach-fall 3s cubic-bezier(.3,.6,.4,1) forwards; animation-delay: var(--d); }
@keyframes ach-fall { to { transform: translateY(110vh) rotate(var(--r)); } }
.ach-prof { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0 14px; }
.ach-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 800; padding: 7px 12px; border-radius: 99px; background: rgba(250,204,21,.16); color: #fde68a; }
.ach-chip.fire { background: rgba(251,146,60,.16); color: #fdba74; }
.ach-chip .i { width: 16px; height: 16px; }
.ach-mini { display: inline-flex; align-items: center; gap: 6px; padding: 3px 12px 3px 3px; border-radius: 99px; background: rgba(255,255,255,.07); }
.ach-mini small { font-size: 12px; font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .ach-medal.t3::after, .ach-flame .i, .ach-conf { animation: none !important; display: none; } }
` }));

AX.Achieve = { refresh, open, homeCard, profileHtml, medal };
})();
