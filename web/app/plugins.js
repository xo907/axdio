/* ==========================================================================
   Axdio plugins in the player (PLUGINS.md is the full guide)

   The server adds each installed plugin's scripts to the player's pages. A
   script calls Axdio.plugin(id, setup); setup(plugin) runs once the player is
   ready, and `plugin` adds pages (/x/<plugin id>/<page>), menu items, song
   actions, home cards and settings sections, listens for what the player does,
   and talks to the plugin's own server routes. The desktop and mobile UIs draw
   what plugins add through AX.Plugins (attach, pages, menuItems, trackActions,
   settingsHtml, mount).
   ========================================================================== */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Plugins) return;
const { esc, ic, UI, U, L, SITE } = AX;
const request = AX.api;

const INFO = (() => { try { return JSON.parse(document.getElementById('axdio-plugins').textContent); } catch (e) { return null; } })() || { plugins: {} };
const R = { pages: new Map(), menu: [], actions: [], settings: [], cards: [], on: {}, ui: null, pending: [], apis: new Map(), last: {} };
const meta = id => (INFO.plugins || {})[id] || (SITE.plugins || {})[id] || { name: id, version: '', config: {} };
const warn = (id, what, e) => console.warn(`[Axdio plugin ${id}] ${what}:`, e);

function emit(event, data) {
  (R.on[event] || []).forEach(([id, fn]) => { try { fn(data); } catch (e) { warn(id, `"${event}" listener`, e); } });
}
const refresh = what => { if (R.ui && R.ui.refresh) { try { R.ui.refresh(what); } catch (e) { /* the UI redraws later anyway */ } } };

function songInfo(t) {
  if (!t) return null;
  const al = L.albums[t.albumId];
  return { id: t.id, rel: t.rel, title: t.title, artist: t.artist, album: al ? al.title : '', cover: AX.coverUrl(t.rel) };
}
const idsOf = rels => (rels || []).map(r => typeof r === 'number' ? r : (L.byRel.get(r) || {}).id).filter(id => id != null && L.tracks[id]);

function localStore(id) {
  const k = key => `axdio_px_${id}_${key}`;
  return {
    get(key) { try { const v = localStorage.getItem(k(key)); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(k(key), JSON.stringify(value)); } catch (e) { /* storage full or off */ } },
    remove(key) { try { localStorage.removeItem(k(key)); } catch (e) { /* ignore */ } },
    all() { const out = {}; try { for (let i = 0; i < localStorage.length; i++) { const n = localStorage.key(i); if (n.startsWith(`axdio_px_${id}_`)) out[n.slice(`axdio_px_${id}_`.length)] = JSON.parse(localStorage.getItem(n)); } } catch (e) { /* ignore */ } return out; },
  };
}

// The object a plugin's setup function gets.
function makeApi(id) {
  const m = meta(id), local = localStore(id);
  const storeUrl = key => `/api/plugin-store/${encodeURIComponent(id)}` + (key == null ? '' : `/${encodeURIComponent(key)}`);
  const api = {
    id, name: m.name || id, version: m.version || '', config: m.config || {},
    get platform() { return R.ui ? R.ui.platform : ''; },
    AX,                                            // the whole player engine; it changes between versions

    // Pages, menus, song actions, home cards and settings
    page(pageId, spec) {
      if (!spec || typeof spec.render !== 'function') throw new Error('page(id, { title, render(el, params) }) needs a render function');
      R.pages.set(`${id}/${pageId}`, { plugin: id, id: String(pageId), title: String(spec.title || api.name), icon: spec.icon || 'spark', render: spec.render });
      refresh('page');
    },
    go(pageId = 'main', params = {}) { if (R.ui) R.ui.go(id, String(pageId), params || {}); },
    link(pageId = 'main', params = {}) { const q = new URLSearchParams(params).toString(); return `/x/${encodeURIComponent(id)}/${encodeURIComponent(pageId)}${q ? '?' + q : ''}`; },
    menu(item) {
      if (!item || typeof item.run !== 'function') throw new Error('menu({ label, icon, run }) needs a run function');
      R.menu.push({ plugin: id, label: String(item.label || api.name), icon: item.icon || 'spark', run: item.run, when: item.when });
      refresh('menu');
    },
    trackAction(a) {
      if (!a || typeof a.run !== 'function') throw new Error('trackAction({ label, icon, run(songs) }) needs a run function');
      R.actions.push({ plugin: id, label: String(a.label || api.name), icon: a.icon || 'spark', run: a.run, when: a.when });
    },
    homeCard(spec) {
      const i = R.cards.length;
      const fn = typeof spec === 'function' ? spec : () => cardHtml(i, spec);
      const safe = () => { try { if (spec && typeof spec.when === 'function' && !spec.when()) return ''; return fn() || ''; } catch (e) { warn(id, 'home card', e); return ''; } };
      R.cards.push({ plugin: id, spec: typeof spec === 'function' ? {} : spec, fn: safe });
      if (AX.HOME_CARDS) AX.HOME_CARDS.push(safe);
      refresh('home');
    },
    settings(spec) {
      if (!spec || typeof spec.render !== 'function') throw new Error('settings({ title, render(el) }) needs a render function');
      R.settings.push({ plugin: id, title: String(spec.title || api.name), render: spec.render });
      refresh('settings');
    },
    row(o = {}) { return rowEl(o); },

    // What the player does
    on(event, fn) { (R.on[event] = R.on[event] || []).push([id, fn]); return () => { R.on[event] = (R.on[event] || []).filter(x => x[1] !== fn); }; },
    track() { return songInfo(AX.curTrack()); },
    playing() { return AX.isPlaying(); },
    play(songs, start = 0) {
      const ids = idsOf(songs);
      if (!ids.length) return;
      AX.playCtx(AX.makeCtx('plugin', id + ':' + Date.now(), api.name, ids), Math.max(0, Math.min(start, ids.length - 1)));
    },
    queue(songs, next = false) { AX.addToQueue(idsOf(songs), next); },
    songs() { return L.tracks.map(songInfo); },
    song(rel) { return songInfo(L.byRel.get(rel)); },
    user() { return U.token ? { username: U.username, name: U.name || U.username, avatar: U.avatar || '' } : null; },

    // Talking to the plugin's server side, and keeping things
    api(path, opts = {}) {
      const url = `/api/plugins/${encodeURIComponent(id)}/${String(path).replace(/^\/+/, '')}`;
      return request(url, opts.body, opts.method);
    },
    store: {
      async get(key) { if (!U.token) return local.get(key); return (await request(storeUrl(key))).value; },
      async set(key, value) { if (!U.token) { local.set(key, value); return; } await request(storeUrl(key), { value }, 'PUT'); },
      async remove(key) { if (!U.token) { local.remove(key); return; } await request(storeUrl(key), undefined, 'DELETE'); },
      async all() { return U.token ? request(storeUrl(null)) : local.all(); },
    },
    url(file) { return `/plugins/${encodeURIComponent(id)}/${String(file).replace(/^\/+/, '')}`; },

    // Small helpers
    toast(text) { UI.toast(String(text)); },
    confirm(title, text = '', o = {}) { return Promise.resolve(UI.confirm({ title, text, ok: o.ok, danger: o.danger })).then(Boolean); },
    icon(name, cls) { return name && String(name).trim().startsWith('<svg') ? String(name) : ic(name || 'spark', cls); },
    esc,
    css(text) { const s = document.createElement('style'); s.dataset.plugin = id; s.textContent = String(text); document.head.appendChild(s); return s; },
  };
  return api;
}

function cardHtml(i, s) {
  s = s || {};
  const bg = s.color ? ` style="background:${esc(s.color)}"` : '';
  return `<div class="hcard px-hc" data-px-card="${i}" role="button"${bg}><span class="px-hc-ic">${s.image ? `<img src="${esc(s.image)}" alt="">` : ic(s.icon || 'spark')}</span>`
    + `<span class="hcard-t">${s.label ? `<small>${esc(s.label)}</small>` : ''}<b>${esc(s.title || '')}</b>${s.sub ? `<span>${esc(s.sub)}</span>` : ''}</span>`
    + `<span class="hcard-go">${ic('chevron-right')}</span></div>`;
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-px-card]'); if (!c) return;
  const card = R.cards[+c.dataset.pxCard];
  if (card && card.spec && typeof card.spec.run === 'function') { e.preventDefault(); try { card.spec.run(); } catch (err) { warn(card.plugin, 'home card', err); } }
});

// A settings row that looks like the player's own: a switch, a button, or a value.
function rowEl(o) {
  const row = document.createElement('div');
  row.className = 'set-row px-row';
  row.innerHTML = `<div class="meta"><div class="t">${esc(o.title || '')}</div>${o.sub ? `<div class="s">${esc(o.sub)}</div>` : ''}</div>`;
  if (o.toggle != null) {
    const t = document.createElement('span');
    let on = !!o.toggle;
    t.className = 'tog' + (on ? ' on' : ''); t.setAttribute('role', 'switch'); t.setAttribute('aria-checked', on); t.tabIndex = 0;
    const flip = () => { on = !on; t.classList.toggle('on', on); t.setAttribute('aria-checked', on); if (o.onChange) o.onChange(on); };
    row.style.cursor = 'pointer';
    row.addEventListener('click', flip);
    t.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    row.appendChild(t);
  } else if (o.button) {
    const b = document.createElement('button');
    b.className = (R.ui && R.ui.buttonClass) || 'btn';
    b.textContent = o.button;
    b.addEventListener('click', e => { e.stopPropagation(); if (o.onClick) o.onClick(b); });
    row.appendChild(b);
  } else if (o.value != null) {
    const v = document.createElement('span'); v.className = 'val px-val'; v.textContent = o.value; row.appendChild(v);
  }
  return row;
}

function start(id, setup) {
  let api = R.apis.get(id);
  if (!api) { api = makeApi(id); R.apis.set(id, api); }
  try { const r = setup(api); if (r && typeof r.catch === 'function') r.catch(e => warn(id, 'setup', e)); }
  catch (e) { warn(id, 'setup', e); }
}
function plugin(id, setup) {
  id = String(id || '');
  if (!id || typeof setup !== 'function') return;
  if (!R.ui) R.pending.push([id, setup]); else start(id, setup);
}

// Wrap the UI's hooks (set by desktop.js or mobile.js) to tell plugins what happens.
function listen() {
  const wrap = (name, after) => {
    const orig = UI[name];
    UI[name] = function (...a) { const r = orig ? orig.apply(this, a) : undefined; try { after(...a); } catch (e) { /* never break the player */ } return r; };
  };
  wrap('track', t => { const id = t ? t.id : null; if (id !== R.last.track) { R.last.track = id; emit('track', songInfo(t)); } });
  wrap('playState', playing => { if (playing !== R.last.playing) { R.last.playing = playing; emit(playing ? 'play' : 'pause', songInfo(AX.curTrack())); } });
  wrap('like', (id, on) => emit('like', { song: songInfo(L.tracks[id]), liked: !!on }));
  wrap('queue', () => emit('queue', { next: [...AX.P.queue.slice(0, 50).map(i => L.tracks[i]), ...AX.upcoming(50).map(x => L.tracks[x.id])].map(songInfo).filter(Boolean).slice(0, 50) }));
  wrap('progress', () => { const now = Date.now(); if (now - (R.last.progress || 0) < 1000) return; R.last.progress = now; emit('progress', { time: AX.audio.currentTime || 0, duration: AX.audio.duration || 0 }); });
  wrap('dirty', views => { if ((views || []).includes('library')) emit('library', { songs: L.tracks.length }); });
  wrap('refresh', () => { const who = U.token ? U.username : ''; if (who !== R.last.user) { R.last.user = who; emit(who ? 'signin' : 'signout', who ? { username: who } : null); } });
  R.last.user = U.token ? U.username : '';
  if (AX.SIGNOUT) AX.SIGNOUT.push(() => { if (R.last.user) { R.last.user = ''; emit('signout', null); } });
}

// The UI (desktop or mobile) calls attach() once it has booted. Plugins set up then.
function attach(ui) {
  if (R.ui) return;
  R.ui = ui;
  listen();
  const q = R.pending.splice(0);
  const early = window.AxdioPlugins;
  if (Array.isArray(early)) q.push(...early.splice(0));
  window.AxdioPlugins = { push: ([id, fn]) => plugin(id, fn) };
  q.forEach(([id, fn]) => start(id, fn));
  emit('ready', { platform: ui.platform });
  refresh('all');
}

function renderPage(el, pluginId, pageId, params) {
  const pg = R.pages.get(`${pluginId}/${pageId || 'main'}`);
  if (!pg) return null;
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'px-page';
  box.dataset.plugin = pluginId;
  el.appendChild(box);
  let cleanup = null;
  try {
    const r = pg.render(box, params || {});
    if (typeof r === 'function') cleanup = r;
    else if (r && typeof r.then === 'function') r.then(x => { if (typeof x === 'function') cleanup = x; }).catch(e => { warn(pluginId, 'page', e); box.innerHTML = errorHtml(e); });
  } catch (e) { warn(pluginId, 'page', e); box.innerHTML = errorHtml(e); }
  return { title: pg.title, icon: pg.icon, cleanup: () => { if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } } } };
}
const errorHtml = e => `<div class="px-error"><b>This page ran into a problem.</b><p>${esc(e && e.message || e)}</p></div>`;

function menuItems() {
  return R.menu.filter(m => { try { return !m.when || m.when(); } catch (e) { return false; } })
    .map(m => ({ label: m.label, icon: m.icon, plugin: m.plugin, run: () => { try { m.run(); } catch (e) { warn(m.plugin, 'menu item', e); } } }));
}
function trackActions(tracks) {
  const songs = (tracks || []).map(t => songInfo(typeof t === 'number' ? L.tracks[t] : t)).filter(Boolean);
  if (!songs.length) return [];
  return R.actions.filter(a => { try { return !a.when || a.when(songs); } catch (e) { return false; } })
    .map(a => ({ label: a.label, icon: a.icon, plugin: a.plugin, run: () => { try { a.run(songs); } catch (e) { warn(a.plugin, 'song action', e); } } }));
}
// Settings sections: the UI puts settingsHtml() into its Settings page, then calls mount() on it.
function settingsHtml() {
  return R.settings.map((s, i) => `<div class="set-sec">${esc(s.title)}</div><div class="px-set" data-px-set="${i}"></div>`).join('');
}
function mount(root) {
  (root || document).querySelectorAll('[data-px-set]').forEach(el => {
    if (el.dataset.pxDone) return;
    el.dataset.pxDone = '1';
    const s = R.settings[+el.dataset.pxSet];
    if (!s) return;
    try { const r = s.render(el); if (r && typeof r.catch === 'function') r.catch(e => warn(s.plugin, 'settings', e)); } catch (e) { warn(s.plugin, 'settings', e); }
  });
}

AX.Plugins = {
  attach, plugin, emit, renderPage, menuItems, trackActions, settingsHtml, mount,
  has: (pluginId, pageId) => R.pages.has(`${pluginId}/${pageId || 'main'}`),
  route: r => emit('route', r),
  info: () => INFO,
};
AX.plugin = plugin;                          // window.Axdio is window.AX (core.js), so this is Axdio.plugin
if (!window.Axdio) window.Axdio = AX;

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.px-page { min-height: 40vh; }
.px-error { margin: 24px 0; padding: 16px 18px; border-radius: 12px; background: rgba(243,114,127,.12); color: var(--text, #fff); }
.px-error p { margin: 6px 0 0; color: var(--text-2, #b3b3b3); font-size: 13px; }
.px-hc { background: linear-gradient(120deg, #334155, #1e293b 60%, #0f172a); }
.px-hc-ic { width: 56px; height: 56px; border-radius: 12px; background: rgba(255,255,255,.16); display: grid; place-items: center; flex-shrink: 0; position: relative; z-index: 1; overflow: hidden; }
.px-hc-ic img { width: 100%; height: 100%; object-fit: cover; }
.px-hc-ic .i { width: 28px; height: 28px; }
.px-spin { display: inline-block; width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(255,255,255,.15); border-top-color: var(--accent, #1ed760); animation: px-spin .8s linear infinite; }
@keyframes px-spin { to { transform: rotate(360deg); } }
` }));
})();
