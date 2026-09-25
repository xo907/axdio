/* Axdio — Daily: name today's song from a 1-second clip, then 2, 4, 7, 11 and 16 seconds (loaded after core.js).
   Everyone on the server gets the same song. The server hands out a clip only once enough tries are used, and says
   what the song was only when the game is over. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Daily) return;
const { UI, U, esc, ic, api, coverUrl, L, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const on = () => !!(U.token && feat('daily'));
const G = { v: null, el: null, clips: new Map(), audio: null, raf: 0, pick: null, sugg: [], wasPlaying: false, timer: 0, loading: null };
const MARK = { right: '🟩', wrong: '🟥', skip: '⬛' };

async function refresh() {
  if (!on()) return null;
  if (!G.loading) G.loading = api('/api/daily').then(v => { G.v = v; if (UI.dirty) UI.dirty(['home']); return v; }).catch(() => null).finally(() => { G.loading = null; });
  return G.loading;
}
function homeCard() {
  if (!on()) return '';
  if (!G.v && !G.loading) refresh();
  const v = G.v, st = v && v.stats;
  const sub = !v || v.empty ? 'Name today\'s song from one second of it'
    : v.done ? (v.solved ? `Solved in ${v.tries.length} · ` : 'Missed today · ') + `next song in ${hms(v.next_in, true)}`
    : v.tries.length ? `${6 - v.tries.length} tries left. Keep going!` : 'Can you name today\'s song in one second?';
  return `<div class="hcard dy-hc" data-dy="open" role="button" aria-label="Play Axdio Daily"><span class="dy-hc-ic">${wave(true)}</span>`
    + `<span class="hcard-t"><small>Axdio Daily${v && v.number ? ' #' + v.number : ''}${st && st.streak ? ` · ${st.streak}-day streak` : ''}</small><b>${v && v.done ? (v.solved ? 'Nailed it' : 'So close') : 'Guess the song'}</b><span>${esc(sub)}</span></span>`
    + `<span class="hcard-go">${ic(v && v.done ? 'chevron-right' : 'play')}</span></div>`;
}
function wave(small) { return `<svg viewBox="0 0 40 24" class="dy-wave${small ? ' sm' : ''}" aria-hidden="true">${[6, 14, 20, 10, 16, 8, 18, 12, 4].map((h, i) => `<rect x="${i * 4.5 + 0.5}" y="${12 - h / 2}" width="2.5" height="${h}" rx="1.2" style="--i:${i}"/>`).join('')}</svg>`; }
function hms(s, short) { s = Math.max(0, s | 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return short ? (h ? `${h}h ${m}m` : `${m}m`) : `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; }

/* ---- Audio ---- */
async function authBlob(url) {
  const r = await fetch(url, { headers: U.token ? { 'X-Auth-Token': U.token } : {}, cache: 'default' });
  if (!r.ok) { let d = null; try { d = await r.json(); } catch (e) { /* not JSON */ } throw new Error((d && d.error) || 'Couldn\'t load the clip'); }
  return URL.createObjectURL(await r.blob());
}
async function clip(stage) {
  const k = G.v.day + ':' + stage;
  if (!G.clips.has(k)) G.clips.set(k, authBlob(`/api/daily/clip?stage=${stage}&d=${G.v.day}`).catch(e => { G.clips.delete(k); throw e; }));
  return G.clips.get(k);
}
async function play() {
  const v = G.v; if (!v || !G.el) return;
  const stage = v.done ? v.stages.length - 1 : v.stage, secs = v.stages[stage];
  if (G.audio && !G.audio.paused) { stop(); return; }
  if (AX.isPlaying && AX.isPlaying()) { G.wasPlaying = true; AX.pause(); }
  const btn = G.el.querySelector('.dy-play'); btn.classList.add('busy');
  try {
    const url = await clip(stage);
    if (!G.el) return;
    stop();
    const a = G.audio = new Audio(url);
    a.addEventListener('ended', stop);
    await a.play();
    btn.classList.remove('busy'); btn.classList.add('on'); btn.innerHTML = ic('pause');
    const total = v.stages[v.stages.length - 1], head = G.el.querySelector('.dy-head');
    const step = () => { if (G.audio !== a || a.paused) return; head.style.width = Math.min(100, a.currentTime / total * 100).toFixed(2) + '%'; if (a.currentTime >= secs) { stop(); return; } G.raf = requestAnimationFrame(step); };
    G.raf = requestAnimationFrame(step);
  } catch (e) { btn.classList.remove('busy'); toast(e.message); }
}
function stop() {
  cancelAnimationFrame(G.raf);
  if (G.audio) { G.audio.pause(); G.audio = null; }
  if (!G.el) return;
  const btn = G.el.querySelector('.dy-play'); if (btn) { btn.classList.remove('on', 'busy'); btn.innerHTML = ic('play'); }
  const head = G.el.querySelector('.dy-head'); if (head) head.style.width = '0%';
}

/* ---- The game ---- */
function bar(v) {
  const total = v.stages[v.stages.length - 1], open = v.done ? total : v.stages[v.stage];
  return `<div class="dy-bar"><i class="dy-open" style="width:${open / total * 100}%"></i><i class="dy-head"></i>${v.stages.slice(0, -1).map(s => `<b style="left:${s / total * 100}%"></b>`).join('')}</div>`
    + `<div class="dy-times"><span>0:00</span><span>${v.done ? 'The whole clip' : `${v.stages[v.stage]} ${v.stages[v.stage] === 1 ? 'second' : 'seconds'}`}</span><span>0:${String(total).padStart(2, '0')}</span></div>`;
}
function triesHtml(v) {
  return `<ol class="dy-tries">${v.stages.map((s, i) => {
    const t = v.tries[i];
    if (!t) return `<li class="${i === v.tries.length && !v.done ? 'cur' : ''}"><span></span></li>`;
    if (t.r === 'skip') return `<li class="skip"><i>${ic('next', 'sm')}</i><span>Skipped</span></li>`;
    return `<li class="${t.r}"><i>${ic(t.r === 'right' ? 'check' : 'close', 'sm')}</i><span>${esc(t.t)}<small>${esc(t.a)}</small></span></li>`;
  }).join('')}</ol>`;
}
function statsHtml(st) {
  const max = Math.max(1, ...st.dist);
  return `<div class="dy-stats"><div><b>${st.played}</b><span>Played</span></div><div><b>${st.played ? Math.round(st.wins / st.played * 100) : 0}%</b><span>Won</span></div><div><b>${st.streak}</b><span>Streak</span></div><div><b>${st.best}</b><span>Best</span></div></div>`
    + `<div class="dy-dist">${st.dist.map((n, i) => `<div><span>${i + 1}</span><i style="width:${Math.max(6, n / max * 100)}%"${G.v && G.v.solved && G.v.tries.length === i + 1 ? ' class="me"' : ''}>${n}</i></div>`).join('')}</div>`;
}
function friendsHtml(v) {
  const f = (v.friends || []).sort((a, b) => (b.solved - a.solved) || (a.n - b.n));
  if (!f.length) return '';
  return `<div class="dy-sec">Friends today</div><div class="dy-friends">${f.map(p => `<div class="dy-fr">${AX.personAvatar ? AX.personAvatar(p) : ''}<span class="dy-fr-n">${esc(p.display_name || p.username)}</span>`
    + `<span class="dy-grid">${[0, 1, 2, 3, 4, 5].map(i => `<i class="${p.grid[i] || ''}"></i>`).join('')}</span><b>${!p.done ? '…' : p.solved ? p.n + '/6' : 'X/6'}</b></div>`).join('')}</div>`;
}
function shareText(v) {
  return `Axdio Daily #${v.number} 🎧 ${v.solved ? v.tries.length : 'X'}/6\n${v.stages.map((s, i) => v.tries[i] ? MARK[v.tries[i].r] : '⬜').join('')}${v.stats.streak > 1 ? `\n🔥 ${v.stats.streak}-day streak` : ''}`;
}
function render() {
  const v = G.v, box = G.el && G.el.querySelector('.dy-body');
  if (!box) return;
  G.el.querySelector('.dy-num').textContent = v && v.number ? '#' + v.number : '';
  G.el.querySelector('.dy-streak').innerHTML = v && v.stats && v.stats.streak ? `${ic('flame', 'sm')}${v.stats.streak}` : '';
  if (!v || v.empty) { box.innerHTML = `<p class="dy-note">There's no song to guess yet. Add some music to the library first.</p>`; return; }
  if (!v.ready) { box.innerHTML = `<div class="dy-prep"><span class="dy-spin"></span><p>Getting today's song ready…</p></div>`; setTimeout(() => G.el && refresh().then(render), 3000); return; }
  if (!v.done) {
    box.innerHTML = triesHtml(v) + bar(v) + `<button class="dy-play" aria-label="Play the clip">${ic('play')}</button>`
      + `<div class="dy-guess"><div class="dy-in">${ic('search', 'sm')}<input id="dy-q" autocomplete="off" spellcheck="false" placeholder="Know it? Type the title or artist"></div><div class="dy-sugg" hidden></div></div>`
      + `<div class="dy-btns"><button class="dy-skip" data-dy="skip">${v.stage < v.stages.length - 1 ? `Skip (+${v.stages[v.stage + 1] - v.stages[v.stage]}s)` : 'Give up'}</button><button class="dy-go" data-dy="guess" disabled>Submit</button></div>`;
    const q = box.querySelector('#dy-q');
    q.addEventListener('input', suggest);
    q.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); if (G.pick) guess(); else if (G.sugg[0]) choose(G.sugg[0]); }
      if (e.key === 'Escape') { e.stopPropagation(); if (q.value) { q.value = ''; suggest(); } else close(); }
    });
    return;
  }
  const a = v.answer, t = a && L.byRel.get(a.rel);
  box.innerHTML = `<div class="dy-reveal ${v.solved ? 'won' : 'lost'}"><div class="dy-cover">${t && t.hc ? `<img src="${esc(coverUrl(a.rel))}" alt="">` : wave()}</div>`
    + `<div class="dy-result">${v.solved ? (v.tries.length === 1 ? 'First try. Legendary.' : `You got it in ${v.tries.length}!`) : 'Not this time.'}</div>`
    + `<h2>${esc(a.title)}</h2><p>${esc(a.artist)}${a.album ? ' · ' + esc(a.album) : ''}</p>`
    + `<div class="dy-actions">${t ? `<button class="dy-btn" data-dy="full">${ic('play', 'sm')} Play the song</button>` : ''}<button class="dy-btn ghost" data-dy="share">${ic('share', 'sm')} Share</button></div></div>`
    + `<div class="dy-grid big">${v.stages.map((s, i) => `<i class="${v.tries[i] ? v.tries[i].r : ''}"></i>`).join('')}</div>`
    + statsHtml(v.stats) + friendsHtml(v)
    + `<p class="dy-next">Next song in <b data-left="${v.next_in}">${hms(v.next_in)}</b></p>`;
  if (v.solved && v.tries.length <= 2) confetti();
  clearInterval(G.timer);
  const t0 = Date.now();
  G.timer = setInterval(() => { const b = G.el && G.el.querySelector('[data-left]'); if (!b) { clearInterval(G.timer); return; } const left = v.next_in - (Date.now() - t0) / 1000; b.textContent = hms(left); if (left <= 0) { clearInterval(G.timer); refresh().then(render); } }, 1000);
}
function suggest() {
  const q = G.el.querySelector('#dy-q'), box = G.el.querySelector('.dy-sugg');
  G.pick = null; G.el.querySelector('.dy-go').disabled = true;
  const r = q.value.trim().length >= 2 ? AX.searchAll(q.value) : null;
  const seen = new Set();
  G.sugg = (r ? r.songs : []).map(id => L.tracks[id]).filter(t => { const k = (t.title + '|' + t.artist).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  box.hidden = !G.sugg.length;
  box.innerHTML = G.sugg.map((t, i) => `<button data-dy="pick" data-i="${i}"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></button>`).join('');
}
function choose(t) {
  const q = G.el.querySelector('#dy-q');
  q.value = `${t.title} — ${t.artist}`; G.pick = t.rel;
  G.el.querySelector('.dy-sugg').hidden = true;
  G.el.querySelector('.dy-go').disabled = false;
  G.el.querySelector('.dy-go').focus();
}
async function guess(skip) {
  if (!skip && !G.pick) return;
  stop();
  try {
    const before = G.v.tries.length;
    G.v = await api('/api/daily/guess', skip ? { skip: true } : { rel: G.pick });
    G.pick = null;
    render();
    const last = G.v.tries[before];
    if (G.el && last) {
      const row = G.el.querySelectorAll('.dy-tries li')[before];
      if (row) row.classList.add('pop');
      if (last.r === 'wrong' && G.el.querySelector('.dy-card')) { G.el.querySelector('.dy-card').classList.add('shake'); setTimeout(() => G.el && G.el.querySelector('.dy-card').classList.remove('shake'), 500); }
    }
    if (!G.v.done) setTimeout(play, 350);
    else if (AX.Achieve) setTimeout(() => AX.Achieve.refresh(), 1500);
    if (UI.dirty) UI.dirty(['home']);
  } catch (e) { toast(e.message); }
}
function confetti() {
  const box = G.el && G.el.querySelector('.dy-card'); if (!box || box.querySelector('.dy-conf')) return;
  const c = document.createElement('div'); c.className = 'dy-conf';
  c.innerHTML = Array.from({ length: 36 }, (_, i) => `<i style="--x:${(Math.random() * 100).toFixed(1)}%;--d:${(Math.random() * .6).toFixed(2)}s;--h:${Math.round(Math.random() * 360)};--r:${Math.round(Math.random() * 720 - 360)}deg"></i>`).join('');
  box.appendChild(c); setTimeout(() => c.remove(), 3200);
}
async function open() {
  if (!on()) { toast(U.token ? 'Axdio Daily is turned off on this server' : 'Log in to play Axdio Daily'); return; }
  if (!G.el) mount();
  G.el.querySelector('.dy-body').innerHTML = '<div class="dy-prep"><span class="dy-spin"></span></div>';
  G.wasPlaying = false;
  await refresh();
  render();
}
function mount() {
  const el = G.el = document.createElement('div');
  el.className = 'dy'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Axdio Daily');
  el.innerHTML = `<div class="dy-card"><header><span class="dy-logo">${wave(true)}</span><b>Axdio Daily</b><span class="dy-num"></span><span class="flex1"></span><span class="dy-streak"></span><button class="dy-x" data-dy="close" aria-label="Close">${ic('close')}</button></header><div class="dy-body"></div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  el.addEventListener('click', e => {
    if (e.target === el) { close(); return; }
    const b = e.target.closest('[data-dy], .dy-play'); if (!b) return;
    if (b.classList.contains('dy-play')) play();
    else if (b.dataset.dy === 'close') close();
    else if (b.dataset.dy === 'pick') choose(G.sugg[+b.dataset.i]);
    else if (b.dataset.dy === 'guess') guess(false);
    else if (b.dataset.dy === 'skip') guess(true);
    else if (b.dataset.dy === 'full') { const t = L.byRel.get(G.v.answer.rel); if (t) { stop(); G.wasPlaying = false; AX.playTrackAlone(t.id); toast(`Playing ${t.title}`); } }
    else if (b.dataset.dy === 'share') share();
  });
  document.addEventListener('keydown', onKey);
}
function onKey(e) {
  if (!G.el) return;
  const typing = e.target && e.target.closest && e.target.closest('input');
  if (e.key === 'Escape' && !typing) { e.preventDefault(); close(); }
  else if (e.key === ' ' && !typing) { e.preventDefault(); e.stopPropagation(); play(); }
}
async function share() {
  const text = shareText(G.v);
  try {
    if (navigator.share && /Mobi|Android|iPhone/.test(navigator.userAgent)) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Result copied. Paste it anywhere'); }
  } catch (e) { if (e.name !== 'AbortError') toast("Couldn't share that"); }
}
function close() {
  if (!G.el) return;
  stop(); clearInterval(G.timer);
  const el = G.el; G.el = null;
  document.removeEventListener('keydown', onKey);
  el.classList.remove('on'); setTimeout(() => el.remove(), 220);
  if (G.wasPlaying && AX.play) AX.play();
}

document.addEventListener('click', e => { const c = e.target.closest('[data-dy="open"]'); if (c && !c.closest('.dy')) { e.preventDefault(); open(); } });
if (AX.HOME_CARDS) AX.HOME_CARDS.unshift(homeCard);

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.dy { position: fixed; inset: 0; z-index: 99980; background: rgba(0,0,0,.72); backdrop-filter: blur(6px); display: grid; place-items: center; opacity: 0; transition: opacity .2s; color: #fff; }
.dy.on { opacity: 1; }
.dy-card { position: relative; width: min(440px, 100vw); max-height: min(100dvh, 860px); overflow-y: auto; border-radius: 20px; padding: 18px 20px 22px; background: linear-gradient(170deg, #1b2440 0%, #151a2c 45%, #111 100%); box-shadow: 0 30px 90px rgba(0,0,0,.6); overscroll-behavior: contain; }
@media (max-width: 520px) { .dy-card { width: 100vw; height: 100dvh; max-height: none; border-radius: 0; padding: calc(env(safe-area-inset-top, 0px) + 12px) 16px calc(env(safe-area-inset-bottom, 0px) + 20px); } }
.dy-card.shake { animation: dy-shake .4s; }
@keyframes dy-shake { 20%, 60% { transform: translateX(-7px); } 40%, 80% { transform: translateX(7px); } }
.dy header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.dy header b { font-size: 18px; font-weight: 900; letter-spacing: -.02em; }
.dy-num { font-size: 14px; font-weight: 700; opacity: .6; }
.dy-streak { display: inline-flex; align-items: center; gap: 2px; font-size: 15px; font-weight: 900; color: #fb923c; }
.dy-streak .i { width: 20px; height: 20px; }
.dy .flex1 { flex: 1; }
.dy-x { width: 38px; height: 38px; border: 0; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; display: grid; place-items: center; cursor: pointer; }
.dy-logo { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, #22d3ee, #6366f1); display: grid; place-items: center; }
.dy-wave { width: 40px; height: 24px; }
.dy-wave.sm { width: 20px; height: 14px; }
.dy-wave rect { fill: currentColor; }
.dy-hc .dy-wave rect, .dy-logo .dy-wave rect { animation: dy-eq 1.1s ease-in-out infinite alternate; animation-delay: calc(var(--i) * -.13s); transform-origin: center; transform-box: fill-box; }
@keyframes dy-eq { from { transform: scaleY(.45); } }
.dy-tries { list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dy-tries li { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 6px 12px; border-radius: 10px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.06); font-size: 14px; font-weight: 700; }
.dy-tries li.cur { border-color: rgba(255,255,255,.3); }
.dy-tries li i { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; font-style: normal; }
.dy-tries li.wrong i { background: #ef4444; } .dy-tries li.right i { background: #22c55e; color: #000; } .dy-tries li.skip i { background: rgba(255,255,255,.2); }
.dy-tries li.skip span { opacity: .6; }
.dy-tries li span { min-width: 0; display: flex; flex-direction: column; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dy-tries li small { font-size: 12px; font-weight: 600; opacity: .6; overflow: hidden; text-overflow: ellipsis; }
.dy-tries li.pop { animation: dy-pop .35s ease; }
@keyframes dy-pop { 50% { transform: scale(1.03); } }
.dy-bar { position: relative; height: 12px; border-radius: 6px; background: rgba(255,255,255,.1); overflow: hidden; }
.dy-bar .dy-open { position: absolute; inset: 0 auto 0 0; background: rgba(34,211,238,.28); transition: width .4s; }
.dy-bar .dy-head { position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg, #22d3ee, #818cf8); }
.dy-bar b { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(0,0,0,.45); }
.dy-times { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; opacity: .65; margin-top: 6px; font-variant-numeric: tabular-nums; }
.dy-play { display: grid; place-items: center; width: 72px; height: 72px; margin: 14px auto 16px; border-radius: 50%; border: 0; background: #fff; color: #000; cursor: pointer; box-shadow: 0 10px 30px rgba(99,102,241,.45); transition: transform .12s; }
.dy-play:active { transform: scale(.94); }
.dy-play .i { width: 34px; height: 34px; }
.dy-play.busy { opacity: .6; }
.dy-play.on { background: linear-gradient(135deg, #22d3ee, #818cf8); }
.dy-guess { position: relative; }
.dy-in { display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 48px; border-radius: 12px; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.12); }
.dy-in:focus-within { border-color: #22d3ee; }
.dy-in input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: #fff; font: inherit; font-size: 15px; }
.dy-sugg { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); background: #1f2433; border-radius: 12px; overflow: hidden; box-shadow: 0 -10px 30px rgba(0,0,0,.5); z-index: 2; }
.dy-sugg button { display: flex; flex-direction: column; width: 100%; text-align: left; padding: 10px 14px; border: 0; background: none; color: #fff; font: inherit; cursor: pointer; }
.dy-sugg button:hover, .dy-sugg button:focus { background: rgba(255,255,255,.08); }
.dy-sugg b { font-size: 14px; } .dy-sugg span { font-size: 12px; opacity: .65; }
.dy-btns { display: flex; gap: 10px; margin-top: 12px; }
.dy-btns button { flex: 1; height: 46px; border-radius: 12px; border: 0; font: inherit; font-size: 15px; font-weight: 800; cursor: pointer; }
.dy-skip { background: rgba(255,255,255,.1); color: #fff; }
.dy-go { background: #22c55e; color: #000; }
.dy-go:disabled { opacity: .4; cursor: default; }
.dy-prep { display: grid; place-items: center; gap: 12px; padding: 60px 0; text-align: center; opacity: .8; }
.dy-spin { width: 30px; height: 30px; border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; animation: dy-spin .8s linear infinite; }
@keyframes dy-spin { to { transform: rotate(360deg); } }
.dy-note { opacity: .75; text-align: center; padding: 40px 0; }
.dy-reveal { text-align: center; }
.dy-cover { width: 180px; height: 180px; margin: 4px auto 14px; border-radius: 14px; overflow: hidden; background: linear-gradient(135deg, #22d3ee, #6366f1); display: grid; place-items: center; box-shadow: 0 20px 50px rgba(0,0,0,.5); animation: dy-flip .7s cubic-bezier(.2,.8,.2,1); }
.dy-cover img { width: 100%; height: 100%; object-fit: cover; }
@keyframes dy-flip { from { transform: perspective(600px) rotateY(90deg) scale(.8); opacity: 0; } }
.dy-result { font-size: 13px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; color: #4ade80; }
.dy-reveal.lost .dy-result { color: #fca5a5; }
.dy-reveal h2 { font-size: 24px; font-weight: 900; letter-spacing: -.02em; margin: 4px 0 2px; }
.dy-reveal p { font-size: 14px; opacity: .75; margin: 0; }
.dy-actions { display: flex; justify-content: center; gap: 8px; margin: 14px 0 6px; flex-wrap: wrap; }
.dy-btn { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 16px; border-radius: 99px; border: 0; background: #fff; color: #000; font: inherit; font-size: 14px; font-weight: 800; cursor: pointer; }
.dy-btn.ghost { background: rgba(255,255,255,.12); color: #fff; }
.dy-btn .i { width: 16px; height: 16px; }
.dy-grid.big { justify-content: center; gap: 6px; margin: 12px 0 16px; }
.dy-grid.big i { width: 26px; height: 26px; border-radius: 6px; }
.dy-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; }
.dy-stats b { display: block; font-size: 24px; font-weight: 900; }
.dy-stats span { font-size: 11px; font-weight: 700; opacity: .6; text-transform: uppercase; letter-spacing: .06em; }
.dy-dist { display: flex; flex-direction: column; gap: 4px; margin: 14px 0 4px; }
.dy-dist div { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 800; }
.dy-dist i { font-style: normal; text-align: right; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,.14); min-width: 20px; }
.dy-dist i.me { background: #22c55e; color: #000; }
.dy-sec { font-size: 12px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; opacity: .6; margin: 18px 0 8px; }
.dy-fr { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.dy-fr .avatar { width: 32px; height: 32px; font-size: 13px; }
.dy-fr-n { flex: 1; min-width: 0; font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dy-grid { display: flex; gap: 3px; }
.dy-grid i { width: 12px; height: 12px; border-radius: 3px; background: rgba(255,255,255,.12); }
.dy-grid i.right { background: #22c55e; } .dy-grid i.wrong { background: #ef4444; } .dy-grid i.skip { background: rgba(255,255,255,.35); }
.dy-fr b { font-size: 13px; width: 32px; text-align: right; }
.dy-next { text-align: center; font-size: 13px; opacity: .75; margin: 18px 0 0; }
.dy-next b { font-variant-numeric: tabular-nums; }
.dy-conf { position: absolute; inset: 0; pointer-events: none; overflow: hidden; border-radius: inherit; }
.dy-conf i { position: absolute; top: -12px; left: var(--x); width: 8px; height: 14px; border-radius: 2px; background: hsl(var(--h), 90%, 60%); animation: dy-fall 2.6s cubic-bezier(.3,.6,.4,1) forwards; animation-delay: var(--d); }
@keyframes dy-fall { to { transform: translateY(110vh) rotate(var(--r)); } }
.dy-hc { background: linear-gradient(120deg, #0e7490, #4338ca 60%, #6d28d9); }
.dy-hc-ic { width: 56px; height: 56px; border-radius: 12px; background: rgba(255,255,255,.16); display: grid; place-items: center; flex-shrink: 0; }
.dy-hc-ic .dy-wave.sm { width: 30px; height: 22px; }
@media (prefers-reduced-motion: reduce) { .dy-wave rect, .dy-cover, .dy-conf { animation: none !important; } }
` }));

AX.Daily = { open, refresh, homeCard };
})();
