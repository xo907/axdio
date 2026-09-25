/* Axdio — Rewind: your month or year in music, told as full-screen story cards (loaded after core.js).
   The numbers come from GET /api/rewind and are only ever shown to the listener they belong to. The last card can be
   saved as an image, shared, or sent to a friend as an end-to-end encrypted photo. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Rewind) return;
const { UI, U, SITE, esc, ic, api, coverUrl, L, feat } = AX;
const toast = m => UI.toast && UI.toast(m);
const nf = n => Number(n || 0).toLocaleString();
const on = () => !!(U.token && feat('rewind'));
const SLIDE_MS = 6500;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const R = { d: null, slides: [], i: 0, el: null, t0: 0, left: 0, raf: 0, paused: false, pal: null, busy: false, req: null };

/* ---- Where to open it from ---- */
function totalPlays() { return (U.history || []).reduce((n, h) => n + (h.count || 1), 0); }
function homeCard() {
  if (!on() || totalPlays() < 10) return '';
  const now = new Date(), top = [...(U.history || [])].sort((a, b) => (b.count || 1) - (a.count || 1)).map(h => L.byRel.get(h.rel_path)).filter(t => t && t.hc);
  const covers = [...new Set(top.map(t => coverUrl(t.rel)))].slice(0, 3).reverse();   // the most played ends up on top
  return `<div class="rw-card" data-rw="open" role="button" aria-label="Open your Rewind"><div class="rw-card-art">${covers.map((c, k) => `<img src="${esc(c)}" alt="" style="--k:${k}" loading="lazy">`).join('')}</div>`
    + `<div class="rw-card-t"><small>Rewind</small><b>Your ${MONTHS[now.getMonth()]} so far</b><span>Top songs, artists and listening habits, and a card to share</span></div><span class="rw-card-go">${ic('play')}</span></div>`;
}

/* ---- Numbers and colours ---- */
async function load(period, y, m) {
  const q = new URLSearchParams({ period, tz: String(new Date().getTimezoneOffset()) });
  if (y) q.set('y', y); if (m) q.set('m', m);
  return api('/api/rewind?' + q);
}
const DEFAULT_PAL = [[124, 58, 237], [236, 72, 153], [34, 197, 94], [14, 165, 233]];
async function palette(d) {
  const rel = (d.top_songs[0] || {}).rel;
  if (rel && AX.Vis && AX.Vis.palette) { const p = await AX.Vis.palette(coverUrl(rel)).catch(() => null); if (p) return p; }
  return DEFAULT_PAL;
}
const rgb = (c, a = 1) => `rgba(${c.map(v => Math.round(v)).join(',')},${a})`;
const dark = (c, k) => c.map(v => v * k);

/* ---- The cards ---- */
function artistOf(name) { return L.artistByKey && L.artistByKey.get(String(name || '').toLowerCase()); }
function cover(rel) { return rel ? coverUrl(rel) : ''; }
function artistCover(a) { const ar = artistOf(a.name); return ar && ar.cover ? coverUrl(ar.cover) : cover(a.rel); }
function hoursText(min) {
  if (min >= 2880) return `That's ${nf(Math.round(min / 1440))} whole days of music.`;
  if (min >= 120) return `That's ${nf(Math.round(min / 60))} hours of music.`;
  return min >= 1 ? 'A great start. The more you play, the better this gets.' : '';
}
const fmtHour = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toLocaleTimeString([], { hour: 'numeric' }); };
const fmtDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
function whenWord(d) { return d.period === 'month' ? 'this month' : d.period === 'year' ? `in ${d.label}` : 'of all time'; }
function songOf(d) { return d.period === 'month' ? 'month' : d.period === 'year' ? 'year' : 'all time'; }
function clockSvg(hours) {
  const max = Math.max(1, ...hours), R0 = 76, R1 = 142;
  const bars = hours.map((v, h) => {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2, len = R0 + (R1 - R0) * (v / max);
    return `<line x1="${(150 + Math.cos(a) * R0).toFixed(1)}" y1="${(150 + Math.sin(a) * R0).toFixed(1)}" x2="${(150 + Math.cos(a) * len).toFixed(1)}" y2="${(150 + Math.sin(a) * len).toFixed(1)}" style="--d:${h * 25}ms"/>`;
  }).join('');
  const lab = [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']].map(([h, t]) => { const a = (h / 24) * Math.PI * 2 - Math.PI / 2; return `<text x="${(150 + Math.cos(a) * 50).toFixed(1)}" y="${(154 + Math.sin(a) * 50).toFixed(1)}">${t}</text>`; }).join('');
  return `<svg class="rw-clock" viewBox="0 0 300 300" aria-hidden="true">${bars}${lab}</svg>`;
}
function build(d) {
  const s = [], name = esc(String(d.name || U.name || '').split(' ')[0] || 'you');
  const title = d.period === 'month' ? MONTHS[d.month - 1] : d.period === 'year' ? String(d.year) : 'All time';
  const periods = [['month', 'This month'], ['year', 'This year'], ['all', 'All time']];
  const now = new Date();
  s.push({ k: 'intro', html: `<div class="rw-kick">Axdio Rewind</div><h1 class="rw-huge">${esc(title)}</h1><p class="rw-lead">${d.plays ? `Here's how ${d.period === 'all' ? 'your listening has gone' : 'it sounded'}, ${name}.` : `Not much to rewind yet, ${name}.`}</p>`
    + `<div class="rw-periods">${periods.map(([p, l]) => `<button data-rwp="${p}" class="${d.period === p && (p !== 'year' || d.year === now.getFullYear()) ? 'on' : ''}">${l}</button>`).join('')}${(d.years || []).filter(y => y !== now.getFullYear()).slice(0, 3).map(y => `<button data-rwp="year" data-y="${y}" class="${d.period === 'year' && d.year === y ? 'on' : ''}">${y}</button>`).join('')}</div>`
    + (d.plays ? '<p class="rw-hint">Tap to continue</p>' : '<p class="rw-hint">Play some music and come back: Rewind fills up as you listen.</p>') });
  if (!d.plays) return s;
  s.push({ k: 'minutes', html: `<div class="rw-kick">${d.period === 'all' ? 'All together' : 'Time well spent'}</div><p class="rw-lead">You listened for</p><div class="rw-big" data-count="${d.minutes}">0</div><p class="rw-unit">minutes</p><p class="rw-lead">${esc(hoursText(d.minutes))}</p>`
    + `<div class="rw-chips"><span>${nf(d.plays)} plays</span><span>${nf(d.songs)} songs</span><span>${nf(d.artists)} artists</span></div>` });
  const ta = d.top_artists[0];
  if (ta) s.push({ k: 'artist', html: `<div class="rw-kick">Your top artist</div><div class="rw-photo round"><img src="${esc(artistCover(ta))}" alt=""></div><h2 class="rw-name">${esc(ta.name)}</h2><p class="rw-lead">${nf(ta.minutes)} minutes · ${nf(ta.plays)} plays</p>`
    + (artistOf(ta.name) ? `<button class="rw-btn" data-rwa="artist" data-n="${esc(ta.name)}">${ic('play', 'sm')} Play ${esc(ta.name)}</button>` : '') });
  if (d.top_artists.length > 2) s.push({ k: 'artists', html: `<div class="rw-kick">Your top artists</div><ol class="rw-list">${d.top_artists.slice(0, 5).map((a, i) => `<li style="--d:${i * 90}ms"><span class="rw-n">${i + 1}</span><img class="round" src="${esc(artistCover(a))}" alt=""><span class="rw-li"><b>${esc(a.name)}</b><small>${nf(a.minutes)} min</small></span></li>`).join('')}</ol>` });
  const ts = d.top_songs[0];
  if (ts) s.push({ k: 'song', html: `<div class="rw-kick">Your song of the ${songOf(d)}</div><div class="rw-photo"><img src="${esc(cover(ts.rel))}" alt=""></div><h2 class="rw-name">${esc(ts.title)}</h2><p class="rw-lead">${esc(ts.artist)}</p><p class="rw-lead strong">Played ${nf(ts.plays)} ${ts.plays === 1 ? 'time' : 'times'}</p>`
    + `<button class="rw-btn" data-rwa="song" data-rel="${esc(ts.rel)}">${ic('play', 'sm')} Play it again</button>` });
  if (d.top_songs.length > 2) s.push({ k: 'songs', html: `<div class="rw-kick">Your top songs</div><ol class="rw-list">${d.top_songs.slice(0, 5).map((t, i) => `<li style="--d:${i * 90}ms"><span class="rw-n">${i + 1}</span><img src="${esc(cover(t.rel))}" alt=""><span class="rw-li"><b>${esc(t.title)}</b><small>${esc(t.artist)} · ${nf(t.plays)} plays</small></span></li>`).join('')}</ol>`
    + `<button class="rw-btn" data-rwa="songs">${ic('play', 'sm')} Play your top ${Math.min(10, d.top_songs.length)}</button>` });
  if (d.persona) s.push({ k: 'clock', html: `<div class="rw-kick">Your listening clock</div>${clockSvg(d.hours)}<h2 class="rw-name">${esc(d.persona.name)}</h2><p class="rw-lead">${esc(d.persona.line)} Your busiest hour: ${esc(fmtHour(d.persona.peak))}.</p>` });
  const habits = [];
  if (d.streak > 1) habits.push(`<div class="rw-stat"><b data-count="${d.streak}">0</b><span>days in a row: your longest listening streak</span></div>`);
  if (d.busiest && d.busiest.minutes >= 30) habits.push(`<div class="rw-stat"><b>${esc(fmtDay(d.busiest.date))}</b><span>your biggest day, with ${nf(d.busiest.minutes)} minutes</span></div>`);
  if (d.on_repeat) habits.push(`<div class="rw-stat"><b>${esc(d.on_repeat.title)}</b><span>on repeat: ${nf(d.on_repeat.plays)} plays on ${esc(fmtDay(d.on_repeat.date))}</span></div>`);
  if (habits.length) s.push({ k: 'habits', html: `<div class="rw-kick">Your habits</div>${habits.join('')}` });
  if (d.discoveries > 0 && d.period !== 'all') s.push({ k: 'finds', html: `<div class="rw-kick">New to you</div><div class="rw-big" data-count="${d.discoveries}">0</div><p class="rw-unit">${d.discoveries === 1 ? 'song' : 'songs'} you played for the first time ${esc(whenWord(d))}</p>`
    + (d.top_find ? `<div class="rw-find"><img src="${esc(cover(d.top_find.rel))}" alt=""><span><small>Best find</small><b>${esc(d.top_find.title)}</b><em>${esc(d.top_find.artist)}</em></span></div>` : '') });
  s.push({ k: 'summary', hold: true, html: summaryHtml(d, title) });
  return s;
}
function summaryHtml(d, title) {
  const share = !!navigator.share, chat = !!(AX.ChatMedia && AX.ChatMedia.allowed('image') && AX.E2EE && AX.E2EE.state === 'ready' && AX.Social && AX.Social.friends && AX.Social.friends().length);
  return `<div class="rw-poster"><div class="rw-poster-h"><small>Axdio Rewind</small><b>${esc(title)}</b><span>${esc(d.name || U.name || '')}</span></div>`
    + `<div class="rw-poster-min"><b>${nf(d.minutes)}</b><span>minutes</span></div>`
    + `<div class="rw-poster-cols"><div><small>Top artists</small><ol>${d.top_artists.slice(0, 5).map(a => `<li>${esc(a.name)}</li>`).join('')}</ol></div><div><small>Top songs</small><ol>${d.top_songs.slice(0, 5).map(t => `<li>${esc(t.title)}</li>`).join('')}</ol></div></div>`
    + (d.persona ? `<div class="rw-poster-p">${esc(d.persona.name)}</div>` : '') + `</div>`
    + `<div class="rw-actions"><button class="rw-btn" data-rwa="save">${ic('dl', 'sm')} Save image</button>${share ? `<button class="rw-btn" data-rwa="share">${ic('share', 'sm')} Share</button>` : ''}${chat ? `<button class="rw-btn" data-rwa="friend">${ic('chat', 'sm')} Send to a friend</button>` : ''}<button class="rw-btn ghost" data-rwa="replay">Watch again</button></div>`;
}

/* ---- The player ---- */
function paintBg(k) {
  const p = R.pal || DEFAULT_PAL, a = p[k % p.length], b = p[(k + 1) % p.length], c = p[(k + 2) % p.length];
  R.el.style.setProperty('--rw-a', rgb(dark(a, .55)));
  R.el.style.setProperty('--rw-b', rgb(dark(b, .45)));
  R.el.style.setProperty('--rw-c', rgb(dark(c, .7), .8));
}
function show(i) {
  R.i = Math.max(0, Math.min(R.slides.length - 1, i));
  const sl = R.slides[R.i], box = R.el.querySelector('.rw-slide');
  box.className = 'rw-slide rw-s-' + sl.k;
  box.innerHTML = sl.html;
  void box.offsetWidth; box.classList.add('in');
  paintBg(R.i);
  R.el.querySelectorAll('.rw-bars i').forEach((b, k) => { b.className = k < R.i ? 'done' : ''; b.firstElementChild.style.width = k < R.i ? '100%' : '0%'; });
  R.t0 = performance.now(); R.left = sl.hold ? 0 : SLIDE_MS;
  box.querySelectorAll('[data-count]').forEach(countUp);
}
function countUp(el) {
  const to = +el.dataset.count || 0, t0 = performance.now(), dur = 1400;
  const step = t => { const p = Math.min(1, (t - t0) / dur); el.textContent = nf(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1 && el.isConnected) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function tick(t) {
  R.raf = requestAnimationFrame(tick);
  if (!R.el || R.paused || !R.left) return;
  const p = Math.min(1, (t - R.t0) / R.left), bar = R.el.querySelectorAll('.rw-bars i b')[R.i];
  if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
  if (p >= 1) { if (R.i < R.slides.length - 1) show(R.i + 1); else R.left = 0; }
}
function pause(on) {
  if (!R.el) return;
  if (on && !R.paused) { R.paused = true; R.pausedAt = performance.now(); }
  else if (!on && R.paused) { R.paused = false; R.t0 += performance.now() - R.pausedAt; }
  R.el.classList.toggle('paused', R.paused);
}
async function open(period = 'year', y, m) {
  if (!on()) { toast(U.token ? 'Rewind is turned off on this server' : 'Log in to see your Rewind'); return; }
  if (!R.el) mount();
  R.el.querySelector('.rw-slide').innerHTML = '<div class="rw-loading"><span></span></div>';
  R.el.querySelector('.rw-bars').innerHTML = '';
  const req = R.req = {};
  try {
    const d = await load(period, y, m);
    if (req !== R.req || !R.el) return;
    R.d = d; R.pal = await palette(d);
    if (req !== R.req || !R.el) return;
    R.slides = build(d);
    R.el.querySelector('.rw-bars').innerHTML = R.slides.map(() => '<i><b></b></i>').join('');
    show(0);
  } catch (e) { if (R.el) { toast(e.message); close(); } }
}
function mount() {
  const el = R.el = document.createElement('div');
  el.className = 'rw'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Rewind');
  el.innerHTML = `<div class="rw-bg"><i></i><i></i><i></i></div><div class="rw-frame"><div class="rw-bars"></div><button class="rw-x" data-rwa="close" aria-label="Close">${ic('close')}</button><div class="rw-slide"></div><div class="rw-sheet" hidden></div></div>`;
  document.body.appendChild(el);
  document.documentElement.classList.add('rw-open');
  requestAnimationFrame(() => el.classList.add('on'));
  R.raf = requestAnimationFrame(tick);
  let down = 0, held = false;
  el.addEventListener('pointerdown', e => { if (e.target.closest('button, .rw-sheet')) return; down = performance.now(); held = false; setTimeout(() => { if (down && performance.now() - down >= 240) { held = true; pause(true); } }, 250); });
  el.addEventListener('pointerup', e => {
    const was = down; down = 0;
    if (held) { pause(false); held = false; return; }
    if (!was || e.target.closest('button, .rw-sheet, a')) return;
    const r = el.querySelector('.rw-frame').getBoundingClientRect();
    if (e.clientX < r.left + r.width * .3) show(R.i - 1); else if (R.i < R.slides.length - 1) show(R.i + 1);
  });
  el.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
}
function close() {
  if (!R.el) return;
  const el = R.el; R.el = null; R.req = null;
  cancelAnimationFrame(R.raf);
  document.removeEventListener('keydown', onKey);
  document.documentElement.classList.remove('rw-open');
  el.classList.remove('on'); setTimeout(() => el.remove(), 250);
}
function onKey(e) {
  const tg = e.target;
  if (!R.el || (tg && tg.closest && tg.closest('input, textarea'))) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); show(R.i + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); show(R.i - 1); }
  else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); pause(!R.paused); }
}
function playList(rels, name) {
  const ids = rels.map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  if (ids.length) AX.playCtx(AX.makeCtx('list', 'rewind:' + name, name, ids), 0);
}
async function onClick(e) {
  const p = e.target.closest('[data-rwp]');
  if (p) { e.stopPropagation(); open(p.dataset.rwp, p.dataset.y ? +p.dataset.y : undefined); return; }
  const b = e.target.closest('[data-rwa]'); if (!b) return;
  e.stopPropagation();
  const a = b.dataset.rwa, d = R.d;
  if (a === 'close') close();
  else if (a === 'song') { const t = L.byRel.get(b.dataset.rel); if (t) AX.playTrackAlone(t.id); }
  else if (a === 'songs') playList(d.top_songs.map(t => t.rel), `Your top songs · ${d.label}`);
  else if (a === 'artist') { const ar = artistOf(b.dataset.n); if (ar) AX.playCtx(AX.makeCtx('artist', ar.key, ar.name, ar.trackIds), -1, { shuffle: true }); }
  else if (a === 'replay') show(0);
  else if (a === 'save' || a === 'share' || a === 'friend') {
    if (R.busy) return;
    R.busy = true; pause(true);
    try {
      const file = await poster(d);
      if (a === 'save') { const u = URL.createObjectURL(file), l = document.createElement('a'); l.href = u; l.download = file.name; l.click(); setTimeout(() => URL.revokeObjectURL(u), 4000); toast('Saved your Rewind card'); }
      else if (a === 'share') { if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: `My ${d.label} on Axdio` }); else await navigator.share({ title: `My ${d.label} on Axdio`, text: `${nf(d.minutes)} minutes of music. Top artist: ${(d.top_artists[0] || {}).name || '—'}` }); }
      else friendSheet(file);
    } catch (er) { if (er && er.name !== 'AbortError') toast(er.message || "Couldn't make the image"); }
    finally { R.busy = false; }
  }
  else if (a === 'send') {
    const file = R.file, u = b.dataset.u; if (!file || !u) return;
    const sheet = R.el.querySelector('.rw-sheet'); sheet.hidden = true;
    try { const c = await AX.Chat.dm(u); await AX.ChatMedia.send(c.id, file, { caption: `My ${d.label} Rewind 🎧` }); toast('Sent, end-to-end encrypted'); }
    catch (er) { toast(er.message); }
  }
  else if (a === 'sheet-x') R.el.querySelector('.rw-sheet').hidden = true;
}
function friendSheet(file) {
  R.file = file;
  const sheet = R.el.querySelector('.rw-sheet'), fr = AX.Social.friends();
  sheet.innerHTML = `<div class="rw-sheet-h"><b>Send to a friend</b><button data-rwa="sheet-x" aria-label="Close">${ic('close', 'sm')}</button></div><p>It goes as an end-to-end encrypted photo in your chat.</p>`
    + fr.map(f => `<button class="rw-friend" data-rwa="send" data-u="${esc(f.username)}">${AX.personAvatar ? AX.personAvatar(f) : ''}<span><b>${esc(f.display_name || f.username)}</b><small>@${esc(f.username)}</small></span></button>`).join('');
  sheet.hidden = false;
}

/* ---- The shareable card, drawn at 1080 × 1920 ---- */
function img(src) { return new Promise(res => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; }); }
function fit(x, text, max) { let t = String(text || ''); if (x.measureText(t).width <= max) return t; while (t.length > 1 && x.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; }
async function poster(d) {
  const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d'), p = R.pal || DEFAULT_PAL, font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  try { await document.fonts.ready; } catch (e) { /* fonts optional */ }
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, rgb(dark(p[0], .75))); g.addColorStop(.55, rgb(dark(p[1], .45))); g.addColorStop(1, rgb(dark(p[2], .25)));
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  [[p[2], 900, 260, 520], [p[3], 120, 1500, 600]].forEach(([c, cx, cy, r]) => { const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, rgb(c, .45)); rg.addColorStop(1, rgb(c, 0)); x.fillStyle = rg; x.fillRect(0, 0, W, H); });
  // Four different covers: songs with artwork first, then artists', then whatever is left.
  const withArt = d.top_songs.filter(t => (L.byRel.get(t.rel) || {}).hc).map(t => coverUrl(t.rel));
  const urls = [...new Set([...withArt, ...d.top_artists.map(artistCover), ...d.top_songs.map(t => coverUrl(t.rel))])].slice(0, 4);
  const covers = await Promise.all(urls.map(img));
  const S = 250, gx = (W - S * 2 - 20) / 2;
  covers.forEach((im, k) => {
    const cx = gx + (k % 2) * (S + 20), cy = 150 + Math.floor(k / 2) * (S + 20);
    x.save(); x.beginPath(); x.roundRect ? x.roundRect(cx, cy, S, S, 18) : x.rect(cx, cy, S, S); x.clip();
    if (im) x.drawImage(im, cx, cy, S, S); else { x.fillStyle = 'rgba(255,255,255,.1)'; x.fillRect(cx, cy, S, S); }
    x.restore();
  });
  x.fillStyle = '#fff'; x.textAlign = 'center';
  x.font = `700 34px ${font}`; x.globalAlpha = .75; x.fillText('AXDIO REWIND', W / 2, 740); x.globalAlpha = 1;
  const title = d.period === 'month' ? `${MONTHS[d.month - 1]} ${d.year}` : d.period === 'year' ? String(d.year) : 'All time';
  x.font = `900 120px ${font}`; x.fillText(fit(x, title, W - 120), W / 2, 870);
  x.font = `600 40px ${font}`; x.globalAlpha = .85; x.fillText(fit(x, d.name || U.name || '', W - 160), W / 2, 935); x.globalAlpha = 1;
  x.font = `900 150px ${font}`; x.fillText(nf(d.minutes), W / 2, 1110);
  x.font = `700 38px ${font}`; x.globalAlpha = .8; x.fillText('minutes listened', W / 2, 1165); x.globalAlpha = 1;
  x.textAlign = 'left';
  const col = (label, rows, cx) => {
    x.font = `800 30px ${font}`; x.globalAlpha = .7; x.fillText(label.toUpperCase(), cx, 1280); x.globalAlpha = 1;
    rows.slice(0, 5).forEach((r, k) => { x.font = `800 40px ${font}`; x.fillText(`${k + 1}`, cx, 1350 + k * 66); x.font = `700 40px ${font}`; x.fillText(fit(x, r, 400), cx + 46, 1350 + k * 66); });
  };
  col('Top artists', d.top_artists.map(a => a.name), 70);
  col('Top songs', d.top_songs.map(t => t.title), 570);
  if (d.persona) { x.textAlign = 'center'; x.font = `800 44px ${font}`; x.fillText(d.persona.name, W / 2, 1745); }
  x.textAlign = 'center'; x.font = `600 30px ${font}`; x.globalAlpha = .6; x.fillText(SITE.site_title || 'Axdio', W / 2, 1840); x.globalAlpha = 1;
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error("Couldn't make the image");
  return new File([blob], `axdio-rewind-${String(title).toLowerCase().replace(/\s+/g, '-')}.png`, { type: 'image/png' });
}

document.addEventListener('click', e => { const c = e.target.closest('[data-rw="open"]'); if (c) { e.preventDefault(); open(); } });

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
html.rw-open { overflow: hidden; }
.rw { position: fixed; inset: 0; z-index: 99990; background: #000; color: #fff; display: grid; place-items: center; opacity: 0; transition: opacity .25s; user-select: none; -webkit-user-select: none; touch-action: manipulation;
  --rw-a: #3b1d6e; --rw-b: #6b1740; --rw-c: rgba(20,120,90,.8); }
.rw.on { opacity: 1; }
.rw-bg { position: absolute; inset: 0; background: linear-gradient(160deg, var(--rw-a), var(--rw-b)); transition: background .8s; overflow: hidden; }
.rw-bg i { position: absolute; width: 70vmax; height: 70vmax; border-radius: 50%; filter: blur(60px); opacity: .55; background: var(--rw-c); animation: rw-drift 18s ease-in-out infinite alternate; }
.rw-bg i:nth-child(1) { left: -20vmax; top: -25vmax; }
.rw-bg i:nth-child(2) { right: -25vmax; bottom: -30vmax; background: var(--rw-a); animation-duration: 23s; }
.rw-bg i:nth-child(3) { left: 30%; top: 40%; width: 40vmax; height: 40vmax; background: var(--rw-b); animation-duration: 15s; }
@keyframes rw-drift { to { transform: translate(8vmax, 6vmax) scale(1.15); } }
.rw-frame { position: relative; width: min(100vw, calc(100dvh * 9 / 16)); height: min(100dvh, calc(100vw * 16 / 9)); max-height: 100dvh; display: flex; flex-direction: column; }
@media (max-width: 699px) { .rw-frame { width: 100vw; height: 100dvh; } }
@media (min-width: 700px) { .rw-frame { height: min(92dvh, 900px); width: calc(min(92dvh, 900px) * 9 / 16); border-radius: 18px; overflow: hidden; background: rgba(0,0,0,.18); box-shadow: 0 30px 90px rgba(0,0,0,.5); } }
.rw-bars { display: flex; gap: 4px; padding: calc(env(safe-area-inset-top, 0px) + 12px) 12px 0; position: relative; z-index: 3; }
.rw-bars i { flex: 1; height: 3px; border-radius: 3px; background: rgba(255,255,255,.3); overflow: hidden; }
.rw-bars i b { display: block; height: 100%; width: 0; background: #fff; }
.rw-x { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 24px); right: 10px; z-index: 4; width: 42px; height: 42px; border: 0; border-radius: 50%; background: rgba(0,0,0,.25); color: #fff; display: grid; place-items: center; cursor: pointer; }
.rw-slide { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 56px 28px 40px; gap: 10px; min-height: 0; overflow: hidden; position: relative; z-index: 2; }
.rw-slide > * { opacity: 0; transform: translateY(18px); }
.rw-slide.in > * { animation: rw-in .7s cubic-bezier(.2,.8,.2,1) forwards; }
.rw-slide.in > :nth-child(2) { animation-delay: .12s; } .rw-slide.in > :nth-child(3) { animation-delay: .24s; } .rw-slide.in > :nth-child(4) { animation-delay: .36s; }
.rw-slide.in > :nth-child(5) { animation-delay: .48s; } .rw-slide.in > :nth-child(n+6) { animation-delay: .6s; }
@keyframes rw-in { to { opacity: 1; transform: none; } }
.rw-kick { font-size: 13px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; opacity: .8; }
.rw-huge { font-size: clamp(64px, 22vw, 120px); font-weight: 900; letter-spacing: -.05em; line-height: .95; margin: 6px 0; }
.rw-lead { font-size: 17px; font-weight: 600; line-height: 1.4; opacity: .9; max-width: 320px; }
.rw-lead.strong { font-weight: 800; opacity: 1; }
.rw-big { font-size: clamp(64px, 20vw, 108px); font-weight: 900; letter-spacing: -.04em; line-height: 1; font-variant-numeric: tabular-nums; }
.rw-unit { font-size: 20px; font-weight: 800; opacity: .9; margin-top: -4px; max-width: 300px; }
.rw-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 10px; }
.rw-chips span { font-size: 13px; font-weight: 700; padding: 7px 12px; border-radius: 99px; background: rgba(255,255,255,.14); }
.rw-photo { width: min(62vw, 260px); aspect-ratio: 1; border-radius: 12px; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,.45); background: rgba(255,255,255,.08); margin: 8px 0; }
.rw-photo.round { border-radius: 50%; }
.rw-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rw-slide.in .rw-photo { animation: rw-in .7s cubic-bezier(.2,.8,.2,1) .12s forwards, rw-float 6s ease-in-out 1s infinite alternate; }
@keyframes rw-float { to { transform: translateY(-6px) scale(1.02); } }
.rw-name { font-size: clamp(26px, 8vw, 38px); font-weight: 900; letter-spacing: -.03em; line-height: 1.05; max-width: 100%; overflow-wrap: anywhere; }
.rw-list { list-style: none; width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 10px; margin: 8px 0 4px; padding: 0; }
.rw-list li { display: flex; align-items: center; gap: 12px; text-align: left; opacity: 0; transform: translateX(-12px); animation: rw-in .6s cubic-bezier(.2,.8,.2,1) forwards; animation-delay: calc(.2s + var(--d)); }
.rw-n { width: 22px; font-size: 20px; font-weight: 900; opacity: .85; flex-shrink: 0; }
.rw-list img { width: 52px; height: 52px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: rgba(255,255,255,.1); }
.rw-list img.round { border-radius: 50%; }
.rw-li { min-width: 0; display: flex; flex-direction: column; }
.rw-li b { font-size: 16px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-li small { font-size: 13px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 12px; padding: 12px 20px; border-radius: 99px; border: 0; background: #fff; color: #000; font: inherit; font-size: 15px; font-weight: 800; cursor: pointer; }
.rw-btn.ghost { background: rgba(255,255,255,.14); color: #fff; }
.rw-btn .i { width: 18px; height: 18px; }
.rw-clock { width: min(70vw, 280px); height: auto; margin: 4px 0; }
.rw-clock line { stroke: #fff; stroke-width: 8; stroke-linecap: round; opacity: 0; animation: rw-fade .5s ease forwards; animation-delay: calc(.3s + var(--d)); }
.rw-clock text { fill: rgba(255,255,255,.7); font-size: 13px; font-weight: 700; text-anchor: middle; font-family: inherit; }
@keyframes rw-fade { to { opacity: .9; } }
.rw-stat { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; max-width: 340px; }
.rw-stat b { font-size: clamp(28px, 9vw, 44px); font-weight: 900; letter-spacing: -.03em; line-height: 1.05; overflow-wrap: anywhere; }
.rw-stat span { font-size: 15px; font-weight: 600; opacity: .85; }
.rw-find { display: flex; align-items: center; gap: 14px; margin-top: 16px; padding: 10px 16px 10px 10px; border-radius: 14px; background: rgba(0,0,0,.22); text-align: left; max-width: 340px; }
.rw-find img { width: 64px; height: 64px; border-radius: 8px; object-fit: cover; }
.rw-find span { display: flex; flex-direction: column; min-width: 0; }
.rw-find small { font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; opacity: .75; }
.rw-find b { font-size: 17px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-find em { font-style: normal; font-size: 13px; opacity: .8; }
.rw-periods { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 18px; }
.rw-periods button { border: 0; font: inherit; font-size: 13px; font-weight: 800; padding: 8px 14px; border-radius: 99px; background: rgba(255,255,255,.14); color: #fff; cursor: pointer; }
.rw-periods button.on { background: #fff; color: #000; }
.rw-hint { font-size: 13px; opacity: .65; margin-top: 18px; max-width: 280px; }
.rw-poster { width: 100%; max-width: 340px; border-radius: 16px; padding: 20px; background: rgba(0,0,0,.28); text-align: left; display: flex; flex-direction: column; gap: 14px; }
.rw-poster-h { display: flex; flex-direction: column; }
.rw-poster-h small { font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; opacity: .75; }
.rw-poster-h b { font-size: 34px; font-weight: 900; letter-spacing: -.03em; line-height: 1.05; }
.rw-poster-h span { font-size: 14px; font-weight: 600; opacity: .8; }
.rw-poster-min b { font-size: 44px; font-weight: 900; letter-spacing: -.03em; line-height: 1; font-variant-numeric: tabular-nums; }
.rw-poster-min span { margin-left: 8px; font-size: 14px; font-weight: 700; opacity: .8; }
.rw-poster-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.rw-poster-cols small { font-size: 10.5px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; opacity: .7; }
.rw-poster-cols ol { list-style: decimal inside; margin: 6px 0 0; padding: 0; font-size: 13.5px; font-weight: 700; line-height: 1.5; }
.rw-poster-cols li { list-style: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-poster-p { font-size: 15px; font-weight: 800; }
.rw-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 0 8px; }
.rw-actions .rw-btn { padding: 10px 16px; font-size: 14px; }
.rw-loading { display: grid; place-items: center; opacity: 1 !important; transform: none !important; }
.rw-loading span { width: 34px; height: 34px; border-radius: 50%; border: 3px solid rgba(255,255,255,.3); border-top-color: #fff; animation: rw-spin .8s linear infinite; }
@keyframes rw-spin { to { transform: rotate(360deg); } }
.rw-sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5; max-height: 70%; overflow: auto; background: #181818; border-radius: 18px 18px 0 0; padding: 16px 16px calc(env(safe-area-inset-bottom, 0px) + 16px); }
.rw-sheet-h { display: flex; align-items: center; justify-content: space-between; }
.rw-sheet-h b { font-size: 17px; }
.rw-sheet-h button { width: 36px; height: 36px; border: 0; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; display: grid; place-items: center; cursor: pointer; }
.rw-sheet p { font-size: 13px; opacity: .7; margin: 6px 0 10px; }
.rw-friend { display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px; border: 0; border-radius: 10px; background: none; color: #fff; font: inherit; text-align: left; cursor: pointer; }
.rw-friend:hover { background: rgba(255,255,255,.08); }
.rw-friend .avatar { width: 40px; height: 40px; }
.rw-friend span { display: flex; flex-direction: column; }
.rw-friend small { opacity: .7; }
.rw.paused .rw-bg i { animation-play-state: paused; }
.rw-card { display: flex; align-items: center; gap: 16px; padding: 14px 16px; margin: 16px 0 8px; border-radius: 14px; cursor: pointer; color: #fff; position: relative; overflow: hidden;
  background: linear-gradient(115deg, #5b21b6, #be185d 55%, #0e7490); }
.rw-card::after { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 85% 20%, rgba(255,255,255,.25), transparent 45%); pointer-events: none; }
.rw-card-art { position: relative; width: 84px; height: 64px; flex-shrink: 0; }
.rw-card-art img { position: absolute; top: 0; left: calc(var(--k) * 12px); width: 60px; height: 60px; border-radius: 6px; object-fit: cover; box-shadow: 0 6px 16px rgba(0,0,0,.4); transform: rotate(calc((var(--k) - 1) * 6deg)); }
.rw-card-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rw-card-t small { font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; opacity: .85; }
.rw-card-t b { font-size: 19px; font-weight: 900; letter-spacing: -.02em; }
.rw-card-t span { font-size: 13px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-card-go { width: 44px; height: 44px; border-radius: 50%; background: #fff; color: #000; display: grid; place-items: center; flex-shrink: 0; position: relative; z-index: 1; }
@media (prefers-reduced-motion: reduce) { .rw-bg i, .rw-slide.in > *, .rw-list li, .rw-clock line, .rw-slide.in .rw-photo { animation: none !important; opacity: 1 !important; transform: none !important; } }
` }));

AX.Rewind = { open, close, homeCard };
})();
