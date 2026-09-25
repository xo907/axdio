/* ==========================================================================
   Axdio Desktop — mouse & keyboard UI (loaded by web/app.html after core.js)

   The engine (library, player, queue, likes, downloads, EQ, Connect) is
   web/app/core.js; this file renders the desktop layout and plugs into AX.UI.

   1. Setup & helpers     5. Sidebar & right panel
   2. Router              6. Player bar, fullscreen & miniplayer
   3. Views               7. Menus, dialogs, drag & drop
   4. Track tables        8. Actions, shortcuts & boot
   ========================================================================== */
function axdioDesktop() {
'use strict';
const {
  UI, byId, $$, esc, norm, clamp, fmt, nf, count, ic, EQB, debounce, uniq, now, setUse, collator, rng, shuffled, pick, dayKey, monthYear,
  LS, S, saveS, saveSSoon, META_CACHE, QUALITIES, setQuality, SITE, feat, featOn, CREDIT, minPassword, pendingInvite, coverUrl, img, tone, hexRgb, dominant, ACCENTS, setAccent, setThemeColor,
  L, sortName, fileExt, albumArtist, albumSource, albumOf, artistOf, creditParts, relatedArtists, topArtists, popular, PALETTE, buildMixes, getMix, searchAll,
  U, signIn, signOut, takeDiscordNote, discordLink, discordUnlink, discordFinish, discordButton, presenceInfo, presenceSetup, presenceOff, updateProfile, pickImage, squarePhoto, uploadAvatar, removeAvatar, changePassword, listSessions, revokeSession, exportMyData, deleteAccount, subsonicInfo, subsonicPassword, scrobbleInfo, connectListenBrainz, disconnectScrobbler, toggleLike, setLikedMany, toggleFollow, toggleSaveAlbum,
  addToPlaylist, removeFromPlaylist, reorderPlaylist, plCreate, plRename, plDelete,
  RECENTS, touchRecent, SEARCHES, rememberSearch, forgetSearch, clearSearches,
  Off, dlBadge, updateDlButton, toggleCtxDownload, EQ_BANDS, EQ_PRESETS, eqLabel, setBoost, toggleNormalize, toggleEq, setEqPreset, setEqBand,
  audio, D, P, CTX, makeCtx, regCtx, curTrack, ctxPlaying, isPlaying, playCtx, playTrackAlone, play, togglePlay, shuffleAll, next, prev,
  setShuffle, cycleRepeat, addToQueue, upcoming, queueJump, ctxJump, queueRemove, queueMove, queueClear, seek, setVolume, toggleMute, stageTrack,
  SL, setSleep, sleepLabel, trackChanged, LY, lyMsg, syncLyrics, Connect, share, trackLink, albumLink, artistLink,
  avatarHtml, libItems, itAlbum, itArtist, itPlaylist, itSearchPl, itLiked, itDownloads, itMix, itFromKey, searchItem, itemIds, itemCtx, plCover, mixCover, emptyHtml, COMP_RE, chunkRender, dragSort,
} = window.AX;

/* ======================================================================
   1. Setup & helpers
   ====================================================================== */
Object.assign(S, Object.assign({ sideW: 320, rightW: 340, sideMin: false, panel: '', sideView: 'list', sideFilter: '', notify: false, homeFilter: 'all' }, S));
const shell = byId('shell'), view = byId('view');
const V = { route: null, ctxs: [], cleanup: [], heroEnd: 300, stickAt: 1e9 };
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const vctx = (type, ref, name, ids, recent) => { const c = regCtx(makeCtx(type, ref, name, ids, recent)); V.ctxs.push(c.rid); return c; };
// encodeURIComponent leaves ' ( ) unescaped; any of them would end a CSS url() early.
const cssUrl = u => `url('${String(u).replace(/['"()\\\s]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))}')`;
const chunked = (container, n, render, step = 60) => { const d = chunkRender(view, container, n, render, step); V.cleanup.push(d); return d; };
function paint(rel, el = view) {
  if (!S.dynColor || !rel) return;
  dominant(coverUrl(rel)).then(c => { if (c) el.style.setProperty('--c', tone(c, .32, .25)); });
}
const titleSize = t => t.length > 42 ? 's' : t.length > 26 ? 'm' : t.length > 14 ? 'l' : '';
const credits = t => creditParts(t).map(p => p.sep || !p.artist ? esc(p.text) : `<a class="lnk" data-act="go" data-view="artist" data-id="${p.artist.id}">${esc(p.text.trim())}</a>`).join('');
const playIcon = on => ic(on ? 'pause' : 'play');

/* ======================================================================
   2. Router — real URLs so back/forward, reload and bookmarks work
   ====================================================================== */
const ROUTES = {
  home: () => '/', search: p => '/?search=' + encodeURIComponent(p.q || ''),
  album: p => '/?album=' + encodeURIComponent(p.key), artist: p => '/?artist=' + encodeURIComponent(p.name || p.key),
  playlist: p => '/playlist?playlist=' + encodeURIComponent(p.name), liked: () => '/liked', downloads: () => '/offline', recent: () => '/history',
  mix: p => '/?mix=' + encodeURIComponent(p.id), discog: p => '/?discography=' + encodeURIComponent(p.key),
  list: p => p.kind === 'artists' ? '/artists' : p.kind === 'albums' ? '/albums' : '/?browse=' + encodeURIComponent(p.kind),
  settings: () => '/settings', profile: () => '/profile', lyrics: () => '/?view=lyrics',
  messages: p => '/messages' + (p.c ? '?c=' + encodeURIComponent(p.c) : ''), friends: p => '/friends' + (p.tab ? '?tab=' + p.tab : ''),
  user: p => '/user?u=' + encodeURIComponent(p.u), cpl: p => '/playlist?c=' + encodeURIComponent(p.id),
};
function parseRoute() {
  const path = location.pathname, q = new URLSearchParams(location.search);
  const simple = { '/liked': 'liked', '/offline': 'downloads', '/history': 'recent', '/settings': 'settings', '/profile': 'profile' };
  if (simple[path]) return { view: simple[path], params: {} };
  if (path === '/artists' || path === '/albums') return { view: 'list', params: { kind: path.slice(1) } };
  if (path === '/playlist' && q.get('c')) return { view: 'cpl', params: { id: q.get('c') } };
  if (path === '/playlist') return { view: 'playlist', params: { name: q.get('playlist') || '' } };
  if (path === '/messages') return { view: 'messages', params: { c: q.get('c') || '' } };
  if (path === '/friends') return { view: 'friends', params: { tab: q.get('tab') || '' } };
  if (path === '/user') return { view: 'user', params: { u: q.get('u') || '' } };
  if (q.has('search')) return { view: 'search', params: { q: q.get('search') || '' } };
  if (q.get('album')) return { view: 'album', params: { key: q.get('album') } };
  if (q.get('artist')) return { view: 'artist', params: { key: q.get('artist').toLowerCase() } };
  if (q.get('mix')) return { view: 'mix', params: { id: q.get('mix') } };
  if (q.get('discography')) return { view: 'discog', params: { key: q.get('discography') } };
  if (q.get('browse')) return { view: 'list', params: { kind: q.get('browse') } };
  if (q.get('view') === 'lyrics') return { view: 'lyrics', params: {} };
  return { view: 'home', params: {} };
}
const NAV = { idx: 0, max: +sessionStorage.getItem('axdio_nav_max') || 0 };
function go(viewName, params = {}, opts = {}) {
  const url = ROUTES[viewName] ? ROUTES[viewName](params) : '/';
  if (viewName === 'album' && params.key) touchRecent('album:' + params.key);
  if (viewName === 'artist' && params.key) touchRecent('artist:' + params.key.toLowerCase());
  if (viewName === 'playlist') touchRecent('playlist:' + params.name);
  if (viewName === 'mix') touchRecent('mix:' + params.id);
  if (viewName === 'liked') touchRecent('liked');
  if (url === location.pathname + location.search && !opts.force) { view.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  try { history.replaceState(Object.assign({}, history.state, { scroll: view.scrollTop }), ''); } catch (e) { /* ignore */ }
  if (opts.replace) history.replaceState({ idx: NAV.idx, scroll: 0 }, '', url);
  else { NAV.idx++; NAV.max = NAV.idx; sessionStorage.setItem('axdio_nav_max', NAV.max); history.pushState({ idx: NAV.idx, scroll: 0 }, '', url); }
  render(0);
}
const goAlbum = id => { const al = L.albums[+id]; if (al) go('album', { key: al.key }); };
const goArtist = id => { const ar = L.artists[+id]; if (ar) go('artist', { key: ar.key, name: ar.name }); };
function openItem(k, id) {
  if (k === 'album') goAlbum(id);
  else if (k === 'artist') goArtist(id);
  else if (k === 'playlist') go('playlist', { name: id });
  else if (k === 'cpl') go('cpl', { id });
  else if (k === 'mix') go('mix', { id });
  else if (k === 'liked') go('liked');
  else if (k === 'downloads') go('downloads');
  else if (k === 'list') go('list', { kind: id });
  else if (k === 'track') { const t = L.tracks[+id]; if (t) playTrackAlone(t.id); }
}
window.addEventListener('popstate', e => {
  NAV.idx = (e.state && e.state.idx) || 0;
  render((e.state && e.state.scroll) || 0);
});
function updateNavButtons() {
  byId('nav-back').disabled = NAV.idx <= 0;
  byId('nav-fwd').disabled = NAV.idx >= NAV.max;
}
function render(scroll = 0) {
  const r = parseRoute();
  V.route = r;
  V.ctxs.forEach(id => CTX.delete(id)); V.ctxs = [];
  V.cleanup.forEach(f => f()); V.cleanup = [];
  SEL.reset();
  view.style.removeProperty('--c'); view.style.removeProperty('--lc');
  view.classList.remove('stuck');
  (VIEWS[r.view] || VIEWS.missing)(view, r.params || {});
  view.scrollTop = scroll;
  requestAnimationFrame(() => { measure(); if (scroll) view.scrollTop = scroll; });
  updateNavButtons();
  byId('home-btn').classList.toggle('on', r.view === 'home');
  const qi = byId('q');
  if (r.view === 'search') { if (document.activeElement !== qi) qi.value = r.params.q || ''; }
  else if (document.activeElement !== qi) qi.value = '';
  byId('q-clear').hidden = !qi.value;
  markSideActive();
  byId('btn-lyrics').classList.toggle('on', r.view === 'lyrics');
  renderSocialButtons();
}
// Re-render what changed. The visible view only refreshes immediately when asked (e.g. after a like).
function markDirty(views, nowVisible) {
  if (views.some(v => ['library', 'playlist', 'liked', 'downloads', 'home'].includes(v))) renderSideSoon();
  const v = V.route && V.route.view;
  if (v && views.includes(v) && nowVisible) render(view.scrollTop);
  if (views.includes('settings') && v === 'settings') render(view.scrollTop);
}
function refreshAll() { renderSide(); if (V.route) render(view.scrollTop); renderPanel(); trackChanged(); }
function measure() {
  const act = view.querySelector('.actions'), hero = view.querySelector('.hero-title, .art-name, .page-title, .prof-hero h1');
  V.stickAt = act ? act.offsetTop + act.offsetHeight - 64 : 1e9;
  V.heroEnd = hero ? hero.offsetTop + hero.offsetHeight : 300;
  onScroll();
}
function onScroll() {
  const y = view.scrollTop;
  view.style.setProperty('--p', clamp((y - (V.stickAt - 90)) / 60, 0, 1).toFixed(3));
  view.classList.toggle('stuck', y > V.stickAt);
  hideTip();
}
let scrollRaf = 0;
view.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; onScroll(); }); closeMenus(); }, { passive: true });

/* ======================================================================
   3. Views
   ====================================================================== */
const VIEWS = {};
const vhead = (title, ctx) => `<div class="vhead">${ctx ? `<button class="big-play" style="width:48px;height:48px" data-act="play-ctx" data-pc="${ctx.rid}" aria-label="Play">${playIcon(ctxPlaying(ctx) && isPlaying())}</button>` : ''}<div class="vh-t">${esc(title)}</div></div>`;
const playBtn = ctx => `<button class="big-play" data-act="play-ctx" data-pc="${ctx.rid}" data-tip="Play" aria-label="Play">${playIcon(ctxPlaying(ctx) && isPlaying())}</button>`;
const shufBtn = () => `<button class="act-btn${P.shuffle ? ' on' : ''}" data-shuf data-act="shuffle" data-tip="Shuffle">${ic('shuffle')}</button>`;
const dlBtn = ctx => `<button class="act-btn" data-act="dl-ctx" data-dlc="${ctx.rid}" data-tip="Download"></button>`;
const moreBtn = (k, id) => `<button class="act-btn" data-act="item-more" data-k="${k}" data-id="${esc(id)}" data-tip="More options">${ic('more-h')}</button>`;
const hoverPlay = it => `<button class="hover-play" data-act="item-play" data-k="${it.k}" data-id="${esc(it.id)}"${it.ck ? ` data-hp="${esc(it.ck)}"` : ''} aria-label="Play">${playIcon(P.ctx && it.ck === P.ctx.recent && isPlaying())}</button>`;
const openAttrs = it => `data-act="open" data-k="${it.k}" data-id="${esc(it.id)}"${it.ck ? ` data-ck="${esc(it.ck)}"` : ''}`;
const cardHtml = it => `<div class="card${it.circle ? ' circle' : ''}${P.ctx && it.ck === P.ctx.recent ? ' ctx-playing' : ''}" ${openAttrs(it)} draggable="true"><div class="card-img">${it.cover}${it.k !== 'list' ? hoverPlay(it) : ''}</div><div class="card-t">${esc(it.title)}</div><div class="card-s clamp2">${esc(it.sub)}</div></div>`;
const quickHtml = it => `<div class="qt${P.ctx && it.ck === P.ctx.recent ? ' ctx-playing' : ''}" ${openAttrs(it)} draggable="true"><div class="qt-art">${it.cover}</div><div class="qt-t clamp2">${esc(it.title)}</div>${EQB}${hoverPlay(it)}</div>`;
function shelf(title, items, o = {}) {
  if (!items.length) return '';
  const more = o.more ? `data-act="go" data-view="list" data-kind="${o.more}"` : o.moreAttr || '';
  return `<section class="sec"><div class="sec-h"><div>${o.kicker ? `<div class="kicker">${esc(o.kicker)}</div>` : ''}<h2>${more ? `<a class="lnk" ${more}>${esc(title)}</a>` : esc(title)}</h2></div>${more ? `<button class="more" ${more}>Show all</button>` : ''}</div><div class="shelf">${items.map(cardHtml).join('')}</div></section>`;
}
const loading = () => `<div class="content" style="padding-top:88px"><div class="sk" style="height:36px;width:40%"></div><div class="quick" style="margin-top:24px">${'<div class="sk" style="height:64px"></div>'.repeat(8)}</div></div>`;

VIEWS.missing = el => { el.innerHTML = `<div class="content" style="padding-top:100px">${emptyHtml('album', "This isn't available", 'It may have been removed from the library.', '<button class="btn light" data-act="go" data-view="home">Go home</button>')}</div>`; };

VIEWS.home = el => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const f = S.homeFilter || 'all';
  const rand = rng(dayKey() + U.username);
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const seen = new Set(), quick = [];
  const addQ = it => { if (it && !seen.has(it.ck) && quick.length < 8) { seen.add(it.ck); quick.push(it); } };
  if (U.liked.length) addQ(itLiked());
  RECENTS.forEach(r => addQ(itFromKey(r.k)));
  U.history.forEach(h => { const t = L.byRel.get(h.rel_path); if (t) addQ(itAlbum(albumOf(t))); });
  const bigAlbums = L.albums.filter(a => a.type === 'Album');
  shuffled(bigAlbums.length > 8 ? bigAlbums : L.albums, rand).slice(0, 12).forEach(a => addQ(itAlbum(a)));
  const chips = [['all', 'All'], ['mixes', 'Made for you'], ['albums', 'Albums'], ['artists', 'Artists']]
    .map(([k, l]) => `<button class="chip${f === k ? ' on' : ''}" data-act="home-filter" data-f="${k}">${l}</button>`).join('');
  let h = `<div class="vbg soft" id="home-bg"></div><div class="content home-top"><div class="chips">${chips}</div>`;
  if (f === 'all') h += `<h1 class="page-title" style="padding-top:28px;font-size:28px">${greet}</h1><div class="quick">${quick.map(quickHtml).join('')}</div>${window.AX.Rewind ? window.AX.Rewind.homeCard() : ''}`;
  const tops = topArtists(12);
  const jump = RECENTS.map(r => itFromKey(r.k)).filter(it => it && !quick.some(q => q.ck === it.ck)).slice(0, 12);
  if (f === 'all' && jump.length >= 3) h += shelf('Jump back in', jump);
  if (f === 'all' || f === 'mixes') h += shelf(U.name || 'Made for you', buildMixes().map(itMix), { kicker: U.name ? 'Made for' : '', more: 'mixes' });
  if (f === 'all' || f === 'albums') h += shelf('Recently added', L.newestAlbums.slice(0, 14).map(id => itAlbum(L.albums[id])), { more: 'recent-albums' });
  if (f === 'all' || f === 'artists') {
    if (tops.length >= 3) h += shelf('Your top artists', tops.map(itArtist));
    else h += shelf('Artists to explore', shuffled(L.artists.filter(a => a.trackIds.length >= 5), rand).slice(0, 12).map(itArtist), { more: 'artists' });
  }
  const anchor = tops[0] || pick(L.artists.filter(a => a.rel.size), rand);
  if (anchor && (f === 'all' || f === 'albums')) {
    const albs = uniq(relatedArtists(anchor, 12).flatMap(r => r.albumIds.slice(0, 2))).map(id => itAlbum(L.albums[id]));
    if (albs.length >= 3) h += shelf(`More like ${anchor.name}`, shuffled(albs, rand).slice(0, 12), { kicker: tops[0] ? 'Because you listen to' : 'Artists you might like' });
  }
  const followed = U.follows.map(k => L.artistByKey.get(k)).filter(a => a && a.trackIds.length);
  if (followed.length && (f === 'all' || f === 'albums')) h += shelf('New from artists you follow', uniq(followed.flatMap(a => a.albumIds.slice(0, 2))).sort((a, b) => L.albums[b].mtime - L.albums[a].mtime).slice(0, 12).map(id => itAlbum(L.albums[id])));
  if (f === 'all' || f === 'albums') {
    const played = new Set(U.history.map(x => { const t = L.byRel.get(x.rel_path); return t ? t.albumId : -1; }));
    const unplayed = L.albums.filter(a => a.trackIds.length >= 5 && !played.has(a.id));
    h += shelf('Something different', shuffled(unplayed.length > 12 ? unplayed : L.albums, rand).slice(0, 12).map(itAlbum), { kicker: 'Picked for today' });
    h += shelf('Fresh singles', L.newestAlbums.map(id => L.albums[id]).filter(a => a.type === 'Single' || a.type === 'EP').slice(0, 14).map(itAlbum), { more: 'singles' });
  }
  if (f === 'artists') h += shelf('All artists', L.azArtists.slice(0, 14).map(id => itArtist(L.artists[id])), { more: 'artists' });
  if (f === 'all') h += `<div class="stats-foot"><div class="flex1"><b>Your library</b><div class="muted" style="font-size:13px;margin-top:2px">${count(L.tracks.length, 'song')} • ${count(L.azArtists.length, 'artist')} • ${count(L.albums.length, 'release')}</div></div><button class="btn primary" data-act="shuffle-all">${ic('shuffle', 'md')}Shuffle everything</button></div>`;
  el.innerHTML = h + '</div>';
  const first = quick.find(q => q.k === 'album');
  if (first) paint(L.albums[first.id].cover, el);
};

const BROWSE = [
  ['Liked Songs', '#8d67ab', 'data-act="go" data-view="liked"', 'heart-f'],
  ['Recently added', '#e8115b', 'data-act="go" data-view="list" data-kind="recent-albums"', 'new'],
  ['Made for you', '#1e3264', 'data-act="go" data-view="list" data-kind="mixes"', 'spark'],
  ['Discover Weekly', '#477d95', 'data-act="open" data-k="mix" data-id="discover"', 'radio'],
  ['Singles & EPs', '#148a08', 'data-act="go" data-view="list" data-kind="singles"', 'note'],
  ['Compilations & DJ mixes', '#ba5d07', 'data-act="go" data-view="list" data-kind="comps"', 'album'],
  ['All artists', '#509bf5', 'data-act="go" data-view="list" data-kind="artists"', 'person'],
  ['All albums', '#af2896', 'data-act="go" data-view="list" data-kind="albums"', 'album'],
  ['Downloaded', '#27856a', 'data-act="go" data-view="downloads"', 'dl-f'],
  ['Recently played', '#503750', 'data-act="go" data-view="recent"', 'history'],
  ['Shuffle everything', '#e91429', 'data-act="shuffle-all"', 'shuffle'],
];
const SR = { f: 'all' };
VIEWS.search = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const q = (p.q || '').trim();
  if (!q) {
    const rand = rng(dayKey());
    const tops = topArtists(8);
    const arts = (tops.length >= 4 ? tops : shuffled(L.artists.filter(a => a.trackIds.length >= 8), rand)).slice(0, 10);
    const recents = SEARCHES.map(s => [s, searchItem(s)]).filter(x => x[1]).slice(0, 10);
    const tile = ([label, color, act, icon]) => `<div class="tile" style="background:${color}" ${act}><span>${esc(label)}</span><div class="tile-ic">${ic(icon)}</div></div>`;
    el.innerHTML = `<div class="content" style="padding-top:88px">`
      + (recents.length ? `<section class="recent-searches" style="margin-bottom:32px"><div class="sec-h"><h2>Recent searches</h2><button class="more" data-act="clear-searches">Clear all</button></div><div class="shelf">${recents.map(([s, it]) => `<div class="card${it.circle ? ' circle' : ''}" ${it.k === 'track' ? `data-act="open" data-k="track" data-id="${it.id}"` : openAttrs(it)}><button class="x" data-act="forget-search" data-sk="${esc(s.k)}" data-skey="${esc(s.key)}" aria-label="Remove">${ic('close', 'sm')}</button><div class="card-img">${it.cover}</div><div class="card-t">${esc(it.title)}</div><div class="card-s clamp2">${esc(it.sub)}</div></div>`).join('')}</div></section>` : '')
      + `<div class="sec-h"><h2>Browse all</h2></div><div class="browse">${BROWSE.map(tile).join('')}${arts.map((a, i) => `<div class="tile" style="background:${PALETTE[(i * 3 + 1) % PALETTE.length]}" data-act="open" data-k="artist" data-id="${a.id}"><span>${esc(a.name)}</span>${img(coverUrl(a.cover))}</div>`).join('')}</div></div>`;
    return;
  }
  const res = searchAll(q);
  const chips = [['all', 'All'], ['songs', 'Songs'], ['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists']]
    .map(([k, l]) => `<button class="chip${SR.f === k ? ' on' : ''}" data-act="search-filter" data-f="${k}">${l}</button>`).join('');
  let h = `<div class="content" style="padding-top:76px"><div class="chips" style="position:sticky;top:0;z-index:5;background:var(--panel);padding:12px 0">${chips}</div>`;
  const songs = vctx('search', q, `Search: ${q}`, res.songs);
  const artists = res.artists.map(id => itArtist(L.artists[id])), albums = res.albums.map(id => itAlbum(L.albums[id]));
  const pls = res.playlists.map(itSearchPl).filter(Boolean);
  const none = emptyHtml('search', `No results found for “${q}”`, 'Please make sure your words are spelled correctly, or use fewer or different keywords.');
  if (SR.f === 'songs') h += res.songs.length ? tableShell(songs, {}) : none;
  else if (SR.f === 'artists') h += artists.length ? `<div class="grid">${artists.map(cardHtml).join('')}</div>` : none;
  else if (SR.f === 'albums') h += albums.length ? `<div class="grid">${albums.map(cardHtml).join('')}</div>` : none;
  else if (SR.f === 'playlists') h += pls.length ? `<div class="grid">${pls.map(cardHtml).join('')}</div>` : none;
  else if (!res.top) h += none;
  else {
    const top = res.top;
    let tc = '';
    if (top.k === 'artist') { const ar = L.artists[top.id]; tc = `<div class="top-card circle" data-act="open" data-k="artist" data-id="${ar.id}" draggable="true"><div class="tc-art">${img(coverUrl(ar.cover))}</div><div class="tc-t">${esc(ar.name)}</div><div class="tc-s"><b>Artist</b>${count(ar.trackIds.length, 'song')}</div>${hoverPlay(itArtist(ar))}</div>`; }
    else if (top.k === 'album') { const al = L.albums[top.id]; tc = `<div class="top-card" data-act="open" data-k="album" data-id="${al.id}" draggable="true"><div class="tc-art">${img(coverUrl(al.cover))}</div><div class="tc-t">${esc(al.title)}</div><div class="tc-s"><b>${al.type}</b>${esc(albumArtist(al))}</div>${hoverPlay(itAlbum(al))}</div>`; }
    else { const t = L.tracks[top.id]; tc = `<div class="top-card" data-act="open" data-k="track" data-id="${t.id}"><div class="tc-art">${img(coverUrl(t.rel))}</div><div class="tc-t">${esc(t.title)}</div><div class="tc-s"><b>Song</b>${esc(t.artist)}</div><button class="hover-play" data-act="open" data-k="track" data-id="${t.id}" aria-label="Play">${ic('play')}</button></div>`; }
    h += `<div class="res-top"><section><div class="sec-h"><h2>Top result</h2></div>${tc}</section><section><div class="sec-h"><h2>Songs</h2>${res.songs.length > 4 ? '<button class="more" data-act="search-filter" data-f="songs">Show all</button>' : ''}</div>${res.songs.length ? tableShell(songs, { limit: 4, noHead: true, noAlbum: true }) : '<p class="muted">No songs match.</p>'}</section></div>`;
    h += shelf('Artists', artists.slice(0, 12), { moreAttr: artists.length > 6 ? 'data-act="search-filter" data-f="artists"' : '' });
    h += shelf('Albums', albums.slice(0, 12), { moreAttr: albums.length > 6 ? 'data-act="search-filter" data-f="albums"' : '' });
    h += shelf('Playlists', pls.slice(0, 12));
  }
  el.innerHTML = h + '</div>';
  fillTables(el);
};

function heroHtml({ kind, cover, circle, title, desc, line, editable }) {
  return `<div class="hero"><div class="hero-cover${circle ? ' circle' : ''}">${cover}</div><div class="hero-meta"><div class="hero-kind">${esc(kind)}</div><h1 class="hero-title ${titleSize(title)}${editable ? ' editable' : ''}"${editable ? ` data-act="${editable}" data-tip="Rename"` : ''}>${esc(title)}</h1>${desc ? `<div class="hero-desc">${esc(desc)}</div>` : ''}<div class="hero-line">${line || ''}</div></div></div>`;
}
VIEWS.album = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const al = L.albumByKey.get(p.key);
  if (!al) { VIEWS.missing(el); return; }
  const ar = al.artistId >= 0 ? L.artists[al.artistId] : null;
  const ctx = vctx('album', al.key, al.title, al.trackIds, 'album:' + al.key);
  const saved = U.saved.includes(al.key);
  const line = (ar ? `<img class="av" src="${esc(coverUrl(ar.cover))}" alt=""><b><a class="lnk" data-act="go" data-view="artist" data-id="${ar.id}">${esc(ar.name)}</a></b>` : '<b>Various Artists</b>')
    + (al.mtime ? `<span class="dot"></span><span class="muted">Added ${esc(monthYear(al.mtime))}</span>` : '')
    + `<span class="dot"></span><span class="muted">${count(al.trackIds.length, 'song')}</span>`;
  let h = '<div class="vbg"></div>' + vhead(al.title, ctx) + heroHtml({ kind: al.type + (albumSource(al) ? ` · Shared by ${albumSource(al)}` : ''), cover: img(coverUrl(al.cover)), title: al.title, line })
    + `<div class="actions">${playBtn(ctx)}${shufBtn()}<button class="act-btn${saved ? ' lit' : ''}" data-act="save-album" data-id="${al.id}" data-save="${al.id}" data-tip="${saved ? 'Remove from' : 'Save to'} Your Library">${ic(saved ? 'check-c' : 'add')}</button>${dlBtn(ctx)}${moreBtn('album', al.id)}</div>`
    + `<div class="content">${tableShell(ctx, { noAlbum: !al.comp, noArt: !al.comp, trackNo: !al.comp && realTrackNos(al) })}`
    + `<p class="list-foot">${al.mtime ? esc(new Date(al.mtime * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })) + '<br>' : ''}${count(al.trackIds.length, 'song')}${al.comp ? ` • ${count(uniq(al.trackIds.map(id => L.tracks[id].artistId)).length, 'artist')}` : ''} • ${esc(fileExt(al.cover))}</p>`;
  if (ar) h += shelf(`More by ${ar.name}`, ar.albumIds.filter(id => id !== al.id).slice(0, 12).map(id => itAlbum(L.albums[id])), { moreAttr: ar.albumIds.length > 6 ? `data-act="go" data-view="discog" data-id="${ar.id}"` : '' });
  el.innerHTML = h + '</div>';
  fillTables(el);
  paint(al.cover);
};
// Show tag track numbers only when they're sane (unique and ascending); many files are all tagged "1".
const realTrackNos = al => al.trackIds.every((id, i) => { const n = L.tracks[id].no; return n > 0 && (i === 0 || n > L.tracks[al.trackIds[i - 1]].no); });
VIEWS.artist = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const ar = L.artistByKey.get(p.key);
  if (!ar || !ar.trackIds.length) { VIEWS.missing(el); return; }
  const st = V.artist && V.artist.key === ar.key ? V.artist : (V.artist = { key: ar.key, more: false, disc: 'popular' });
  const pop = popular(ar, 10);
  const ctx = vctx('artist', ar.key, ar.name, uniq(pop.concat(ar.albumIds.flatMap(id => L.albums[id].trackIds), ar.trackIds)), 'artist:' + ar.key);
  const popCtx = vctx('artist', ar.key, ar.name, ctx.ids, 'artist:' + ar.key);
  const following = U.follows.includes(ar.key);
  const plays = ar.trackIds.reduce((s, id) => s + (U.plays.get(L.tracks[id].rel) || 0), 0);
  let h = vhead(ar.name, ctx) + `<div class="art-banner"><div class="bimg" style="background-image:${esc(cssUrl(coverUrl(ar.cover)))}"></div><div><div class="verified">${ic('check-c')}In your library</div><h1 class="art-name">${esc(ar.name)}</h1><div>${count(ar.trackIds.length, 'song')} • ${count(ar.albumIds.length, 'release')}${plays ? ` • ${count(plays, 'play')} by you` : ''}</div></div></div>`
    + `<div class="actions">${playBtn(ctx)}${shufBtn()}<button class="pill-btn${following ? ' on' : ''}" data-act="follow" data-id="${ar.id}" data-follow="${ar.id}">${following ? 'Following' : 'Follow'}</button>${moreBtn('artist', ar.id)}</div><div class="content">`;
  const likedN = ar.trackIds.filter(id => U.likedSet.has(L.tracks[id].rel)).length;
  h += `<div class="art-cols"><section><div class="sec-h"><h2>Popular</h2></div>${tableShell(popCtx, { limit: st.more ? 10 : 5, noHead: true, noAlbum: true, plays: true })}${pop.length > 5 ? `<button class="see-more" data-act="artist-more">${st.more ? 'Show less' : 'See more'}</button>` : ''}</section>`
    + (likedN ? `<section><div class="sec-h"><h2>Liked songs</h2></div><div class="liked-card" data-act="go" data-view="liked"><div class="la">${img(coverUrl(ar.cover))}<span class="hd">${ic('heart-f')}</span></div><div><b>You've liked ${count(likedN, 'song')}</b><div class="muted" style="font-size:13px;margin-top:4px">By ${esc(ar.name)}</div></div></div></section>` : '<div></div>') + '</div>';
  const groups = { popular: ar.albumIds.slice().sort((a, b) => albumScore(b) - albumScore(a)), albums: ar.albumIds.filter(id => L.albums[id].type === 'Album'), singles: ar.albumIds.filter(id => ['Single', 'EP'].includes(L.albums[id].type)), comps: [...ar.compIds] };
  const discChips = [['popular', 'Popular releases'], ['albums', 'Albums'], ['singles', 'Singles and EPs'], ['comps', 'Compilations']].filter(([k]) => groups[k].length)
    .map(([k, l]) => `<button class="chip${st.disc === k ? ' on' : ''}" data-act="disc-chip" data-f="${k}">${l}</button>`).join('');
  h += `<section class="sec"><div class="sec-h"><h2><a class="lnk" data-act="go" data-view="discog" data-id="${ar.id}">Discography</a></h2><button class="more" data-act="go" data-view="discog" data-id="${ar.id}">Show all</button></div><div class="chips" style="margin-bottom:12px">${discChips}</div><div class="shelf">${(groups[st.disc] || groups.popular).slice(0, 12).map(id => cardHtml({ ...itAlbum(L.albums[id]), sub: `${L.albums[id].type}${L.albums[id].mtime ? ' • ' + monthYear(L.albums[id].mtime) : ''}` })).join('')}</div></section>`;
  const extras = [getMix('feat:' + ar.key), getMix('artist-radio:' + ar.key)].filter(Boolean).map(itMix);
  h += shelf(`Featuring ${ar.name}`, extras);
  h += shelf('Fans also like', relatedArtists(ar, 12).map(itArtist));
  h += shelf('Appears on', [...ar.compIds].map(id => itAlbum(L.albums[id])));
  el.innerHTML = h + '</div>';
  fillTables(el);
  paint(ar.cover);
  function albumScore(id) { const al = L.albums[id]; return al.trackIds.reduce((s, t) => s + (U.plays.get(L.tracks[t].rel) || 0), 0) * 10 + al.trackIds.length / 4 + al.mtime / (ar.mtime || 1); }
};
VIEWS.discog = (el, p) => {
  const ar = L.artistByKey.get(p.key);
  if (!ar) { VIEWS.missing(el); return; }
  const st = V.discog && V.discog.key === ar.key ? V.discog : (V.discog = { key: ar.key, f: 'all' });
  const groups = { all: ar.albumIds, albums: ar.albumIds.filter(id => L.albums[id].type === 'Album'), singles: ar.albumIds.filter(id => ['Single', 'EP'].includes(L.albums[id].type)), comps: [...ar.compIds] };
  const ids = groups[st.f] || groups.all;
  el.innerHTML = `<div class="content"><h1 class="page-title"><a class="lnk" data-act="go" data-view="artist" data-id="${ar.id}">${esc(ar.name)}</a></h1><div class="page-sub">Discography</div><div class="chips" style="margin:20px 0">${[['all', 'All'], ['albums', 'Albums'], ['singles', 'Singles and EPs'], ['comps', 'Compilations']].filter(([k]) => groups[k].length).map(([k, l]) => `<button class="chip${st.f === k ? ' on' : ''}" data-act="discog-filter" data-f="${k}">${l}</button>`).join('')}</div><div class="grid"></div></div>`;
  chunked(el.querySelector('.grid'), ids.length, i => { const al = L.albums[ids[i]]; return cardHtml({ ...itAlbum(al), sub: `${al.type} • ${count(al.trackIds.length, 'song')}${al.mtime ? ' • ' + monthYear(al.mtime) : ''}` }); }, 48);
};
VIEWS.playlist = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const name = p.name, rels = U.playlists[name];
  if (!rels) { VIEWS.missing(el); return; }
  const ids = rels.map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  const ctx = vctx('playlist', name, name, ids, 'playlist:' + name);
  ctx.plName = name;
  const line = `${avatarHtml()}<b>${esc(U.name || 'You')}</b><span class="dot"></span><span class="muted">${count(ids.length, 'song')}</span>`;
  let h = '<div class="vbg"></div>' + vhead(name, ctx) + heroHtml({ kind: 'Playlist', cover: plCover(rels), title: name, line, editable: 'pl-rename' })
    + `<div class="actions">${ids.length ? playBtn(ctx) + shufBtn() : ''}${dlBtn(ctx)}${moreBtn('playlist', name)}<span class="flex1"></span>${ids.length > 8 ? `<label class="filter-box">${ic('search')}<input id="pl-filter" placeholder="Search in playlist" autocomplete="off"></label>` : ''}</div><div class="content">`;
  if (ids.length) h += tableShell(ctx, { pl: name });
  h += `<section class="sec"><div class="sec-h"><div><h2>${ids.length ? 'Recommended' : "Let's find something for your playlist"}</h2>${ids.length ? '<div class="kicker" style="margin-top:4px">Based on what\'s in this playlist</div>' : ''}</div></div><label class="filter-box" style="width:min(420px,100%);height:40px;margin-bottom:12px">${ic('search')}<input id="pl-find" placeholder="Search for songs to add" autocomplete="off" style="width:100%"></label><div id="pl-rec"></div></section>`;
  el.innerHTML = h + '</div>';
  fillTables(el);
  if (ids.length) paint(L.tracks[ids[0]].rel);
  const recBox = el.querySelector('#pl-rec'), find = el.querySelector('#pl-find');
  const drawRec = () => {
    const q = find.value.trim();
    let recIds;
    if (q) recIds = (searchAll(q) || { songs: [] }).songs.slice(0, 20);
    else {
      const seeds = ids.slice(-6);
      recIds = seeds.length ? uniq(seeds.flatMap(id => AXradio(id))).filter(id => !rels.includes(L.tracks[id].rel)).slice(0, 10) : shuffled(L.tracks.map(t => t.id), rng(dayKey())).slice(0, 10);
    }
    const rc = vctx('list', 'rec:' + name, 'Recommended', recIds);
    recBox.innerHTML = recIds.length ? tableShell(rc, { noHead: true, add: true }) : '<p class="muted">No matches.</p>';
    fillTables(recBox);
  };
  find.addEventListener('input', debounce(drawRec, 150));
  drawRec();
  const filter = el.querySelector('#pl-filter');
  if (filter) filter.addEventListener('input', debounce(() => filterTable(el.querySelector('.tt'), filter.value), 120));
};
const AXradio = id => window.AX.radioIds(id, 10).slice(1);
const LIKED = { sort: 'recent' };
VIEWS.liked = el => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const all = U.liked.slice().reverse().map(r => L.byRel.get(r)).filter(Boolean);
  if (LIKED.sort === 'title') all.sort((a, b) => collator.compare(a.title, b.title));
  if (LIKED.sort === 'artist') all.sort((a, b) => collator.compare(a.artist, b.artist));
  if (LIKED.sort === 'album') all.sort((a, b) => collator.compare(albumOf(a).title, albumOf(b).title));
  const ctx = vctx('liked', '', 'Liked Songs', all.map(t => t.id), 'liked');
  view.style.setProperty('--c', '80, 56, 160');
  const line = `${avatarHtml()}<b>${esc(U.name || 'You')}</b><span class="dot"></span><span class="muted">${count(all.length, 'song')}</span>`;
  let h = '<div class="vbg"></div>' + vhead('Liked Songs', ctx) + heroHtml({ kind: 'Playlist', cover: `<div class="cover-glyph liked-art">${ic('heart-f')}</div>`, title: 'Liked Songs', line })
    + `<div class="actions">${all.length ? playBtn(ctx) + shufBtn() : ''}${dlBtn(ctx)}<span class="flex1"></span>${all.length > 8 ? `<label class="filter-box">${ic('search')}<input id="liked-filter" placeholder="Search in Liked Songs" autocomplete="off"></label>` : ''}<button class="sort-btn" data-act="liked-sort">${{ recent: 'Recently added', title: 'Title', artist: 'Artist', album: 'Album' }[LIKED.sort]}${ic('down', 'sm')}</button></div><div class="content">`;
  h += all.length ? tableShell(ctx, {}) : emptyHtml('heart', 'Songs you like will appear here', 'Save songs by tapping the heart icon.', '<button class="btn light" data-act="go" data-view="search">Find songs</button>');
  el.innerHTML = h + '</div>';
  fillTables(el);
  const input = el.querySelector('#liked-filter');
  if (input) input.addEventListener('input', debounce(() => filterTable(el.querySelector('.tt'), input.value), 120));
};
VIEWS.mix = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const m = getMix(p.id);
  if (!m) { VIEWS.missing(el); return; }
  const ctx = vctx('mix', m.id, m.name, m.ids.filter(id => L.tracks[id]), 'mix:' + m.id);
  let h = '<div class="vbg"></div>' + vhead(m.name, ctx) + heroHtml({ kind: 'Mix', cover: mixCover(m), title: m.name, desc: m.desc, line: `<span class="brand-mark" style="width:24px;height:24px">${ic('note', 'sm')}</span><b>Made for ${esc(U.name || 'you')}</b><span class="dot"></span><span class="muted">${count(ctx.ids.length, 'song')}</span>` })
    + `<div class="actions">${playBtn(ctx)}${shufBtn()}<button class="act-btn" data-act="mix-save" data-id="${esc(m.id)}" data-tip="Save as playlist">${ic('add')}</button>${dlBtn(ctx)}${moreBtn('mix', m.id)}</div><div class="content">${tableShell(ctx, {})}`;
  el.innerHTML = h + '</div>';
  fillTables(el);
  if (S.dynColor) view.style.setProperty('--c', tone(hexRgb(m.cover.m1), .32, .25));
};
VIEWS.downloads = el => {
  const ts = [...Off.set].map(r => L.byRel.get(r)).filter(Boolean).sort((a, b) => collator.compare(a.artist, b.artist) || a.albumId - b.albumId || a.no - b.no);
  const ctx = vctx('list', 'downloads', 'Downloads', ts.map(t => t.id), 'downloads');
  const busy = Off.queue.length + Off.active.size;
  view.style.setProperty('--c', '13, 107, 59');
  let h = '<div class="vbg"></div>' + vhead('Downloads', ctx) + heroHtml({ kind: 'On this device', cover: `<div class="cover-glyph dl-art">${ic('dl-f')}</div>`, title: 'Downloads', line: `<span class="muted">${count(ts.length, 'song')} available offline${busy ? ` • ${busy} downloading` : ''}</span>` })
    + `<div class="actions">${ts.length ? playBtn(ctx) + shufBtn() : ''}${busy ? '<button class="pill-btn" data-act="dl-cancel-all">Cancel downloads</button>' : ''}${ts.length ? '<button class="pill-btn" data-act="dl-remove-all">Remove all</button>' : ''}</div>`
    + `<div class="content"><div class="storage-bar"><i id="st-used" style="width:0"></i></div><div class="muted" id="st-txt" style="font-size:13px;margin-bottom:20px">Checking storage…</div>`;
  h += ts.length ? tableShell(ctx, {}) : emptyHtml('dl', 'No downloads yet', 'Use the download button on any album or playlist to listen without a connection.');
  el.innerHTML = h + '</div>';
  fillTables(el);
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => {
    const u = e.usage || 0, q = e.quota || 1, bar = el.querySelector('#st-used'), txt = el.querySelector('#st-txt');
    if (bar) bar.style.width = clamp(u / q * 100, 1, 100) + '%';
    if (txt) txt.textContent = `${(u / 1e9).toFixed(2)} GB used of ${(q / 1e9).toFixed(0)} GB available to this browser`;
  }).catch(() => {});
};
VIEWS.recent = el => {
  const hist = U.history.filter(x => L.byRel.has(x.rel_path)).slice(0, 400);
  const ids = uniq(hist.map(x => L.byRel.get(x.rel_path).id));
  const ctx = vctx('list', 'history', 'Recently played', ids);
  let h = `<div class="content"><h1 class="page-title">Recently played</h1><div class="page-sub">${U.token ? 'Synced across your devices' : 'On this device'}</div>`;
  if (!ids.length) { el.innerHTML = h + emptyHtml('history', 'Nothing here yet', 'Songs you play will show up here.') + '</div>'; return; }
  const today = new Date().toDateString(), yest = new Date(now() - 864e5).toDateString();
  const groups = [];
  hist.forEach(x => {
    const d = x.last_played ? new Date(x.last_played) : null;
    const label = !d || isNaN(d) ? 'Earlier' : d.toDateString() === today ? 'Today' : d.toDateString() === yest ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, ids: [] });
    const id = L.byRel.get(x.rel_path).id;
    if (!groups[groups.length - 1].ids.includes(id)) groups[groups.length - 1].ids.push(id);
  });
  h += `<div class="tt" data-ctx="${ctx.rid}" style="margin-top:24px"><div class="tt-h"><div>#</div><div>Title</div><div>Album</div><div>Plays</div></div><div class="tt-rows">${groups.map(g => `<div class="day-h">${esc(g.label)}</div>${g.ids.map(id => trRow(L.tracks[id], ctx.ids.indexOf(id), { plays: true })).join('')}`).join('')}</div></div>`;
  el.innerHTML = h + '</div>';
};
VIEWS.list = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const defs = {
    'recent-albums': ['Recently added', () => L.newestAlbums.map(id => itAlbum(L.albums[id]))],
    singles: ['Singles & EPs', () => L.newestAlbums.filter(id => ['Single', 'EP'].includes(L.albums[id].type)).map(id => itAlbum(L.albums[id]))],
    comps: ['Compilations & DJ mixes', () => L.newestAlbums.filter(id => L.albums[id].comp || COMP_RE.test(L.albums[id].name)).map(id => itAlbum(L.albums[id]))],
    artists: ['All artists', () => L.azArtists.map(id => itArtist(L.artists[id]))],
    albums: ['All albums', () => L.azAlbums.map(id => itAlbum(L.albums[id]))],
    mixes: ['Made for you', () => buildMixes().map(itMix)],
  };
  const d = defs[p.kind];
  if (!d) { VIEWS.missing(el); return; }
  const items = d[1]();
  el.innerHTML = `<div class="content"><h1 class="page-title">${esc(d[0])}</h1><div class="page-sub">${nf(items.length)} items</div><div class="grid" style="margin-top:24px"></div></div>`;
  chunked(el.querySelector('.grid'), items.length, i => cardHtml(items[i]), 48);
};

/* Settings, EQ, profile */
const setRow = ({ act, title, sub, ctl, attrs = '' }) => `<div class="set-row"${act ? ` data-act="${act}" style="cursor:pointer"` : ''} ${attrs}><div class="meta"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>${ctl || ''}</div>`;
const tog = on => `<span class="tog${on ? ' on' : ''}" role="switch" aria-checked="${!!on}"></span>`;
VIEWS.settings = el => {
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim().toLowerCase();
  let h = `<div class="content set"><h1 class="page-title">Settings</h1>`;
  h += `<div class="set-sec">Account</div>` + (U.token
    ? setRow({ title: U.name || U.username, sub: `Logged in as @${U.username}`, ctl: `<button class="btn ghost sm" data-act="go" data-view="profile">View profile</button><button class="btn ghost sm" data-act="logout">Log out</button>` })
      + setRow({ title: 'Signed-in devices', sub: 'See where you are logged in and sign out devices you don\'t use', ctl: '<button class="btn ghost sm" data-act="devices-signed">Manage</button>' })
      + (U.passwordLogin ? '' : setRow({ title: 'Password', sub: 'You sign in with Discord. Set a password to sign in without it too.', ctl: '<button class="btn ghost sm" data-act="change-pw">Set password</button>' }))
      + setRow({ title: 'Download your data', sub: 'A copy of your profile, likes, playlists and listening history', ctl: '<button class="btn ghost sm" data-act="export-data">Download</button>' })
      + setRow({ title: 'Delete account', sub: 'Permanently remove your account and everything saved in it', ctl: '<button class="btn danger sm" data-act="delete-account">Delete</button>' })
    : setRow({ title: 'Not logged in', sub: 'Log in to sync likes, playlists and history across devices.', ctl: '<button class="btn primary sm" data-act="go" data-view="profile">Log in</button>' }));
  const F = U.token && SITE.features ? SITE.features : {};
  if (U.token && (featOn('discord_login') || featOn('discord_presence'))) {
    h += `<div class="set-sec">Discord</div>`
      + (featOn('discord_login') ? setRow({ title: 'Discord account', sub: U.discord ? `Connected as @${U.discord.username}. You can sign in with Discord.` : 'Connect it to sign in with Discord.',
          ctl: U.discord ? '<button class="btn ghost sm" data-act="discord-unlink">Disconnect</button>' : `<button class="btn ghost sm" data-act="discord-link">${ic('discord', 'sm')}Connect</button>` }) : '')
      + (featOn('discord_presence') ? setRow({ title: 'Show what I play on Discord', sub: U.presence ? 'On. Keep the helper running on the computer where Discord is open.' : 'Your Discord status shows the song, artist, album and artwork while you listen.',
          ctl: `<div style="display:flex;gap:8px"><button class="btn ghost sm" data-act="presence-setup">${U.presence ? 'Set up again' : 'Set up'}</button>${U.presence ? '<button class="btn ghost sm" data-act="presence-off">Turn off</button>' : ''}</div>` }) : '');
  }
  if (socialOn()) {
    const st = Social.me.settings || {};
    h += `<div class="set-sec">Friends</div>`
      + setRow({ act: 'set-share-activity', title: 'Share what I listen to', sub: 'Friends see what you are playing and what you played recently', ctl: tog(st.share_activity !== false) })
      + setRow({ act: 'set-discoverable', title: 'Let people find me by name', sub: 'When off, people can only find you by your exact username', ctl: tog(st.discoverable !== false) })
      + setRow({ title: 'Blocked people', sub: `${count((Social.me.blocked || []).length, 'person', 'people')} blocked`, ctl: '<button class="btn ghost sm" data-act="blocked-list">Manage</button>' });
  }
  if (chatOn()) {
    const labels = { ready: 'On for this device', none: 'Not turned on yet', locked: 'Set up, but locked on this device', unsupported: 'Needs an HTTPS connection', off: '…' };
    h += `<div class="set-sec">Private messages</div>`
      + setRow({ title: 'End-to-end encryption', sub: labels[E2EE.state] || '', ctl: E2EE.state === 'ready' ? `<span class="val">${ic('shield', 'sm')} On</span>` : E2EE.state === 'unsupported' ? '' : `<button class="btn primary sm" data-act="go" data-view="messages">${E2EE.state === 'locked' ? 'Unlock' : 'Turn on'}</button>` })
      + (E2EE.state === 'ready' ? setRow({ title: 'Recovery key', sub: 'Unlocks your messages on a new device when your other devices aren\'t around', ctl: '<button class="btn ghost sm" data-act="rk-show">Show</button><button class="btn ghost sm" data-act="rk-new">Make a new one</button>' }) : '')
      + (E2EE.state === 'ready' || E2EE.state === 'locked' ? setRow({ title: 'Reset private messages', sub: 'Makes new keys. Messages sent before can no longer be read on any of your devices.', ctl: '<button class="btn danger sm" data-act="e2ee-reset">Reset</button>' }) : '');
  }
  if (F.scrobbling || F.subsonic) h += `<div class="set-sec">Other apps</div>`
    + (F.scrobbling ? setRow({ title: 'Scrobbling', sub: 'Keep track of what you play on ListenBrainz or Last.fm', ctl: '<button class="btn ghost sm" data-act="scrobbling">Connect</button>' }) : '')
    + (F.subsonic ? setRow({ title: 'Subsonic-compatible apps', sub: 'Symfonium (Android), Substreamer and play:Sub (iPhone), Feishin and Sonixd (computer), DSub, Tempo and more can play from this server', ctl: '<button class="btn ghost sm" data-act="subsonic">Set up</button>' }) : '');
  h += `<div class="set-sec">Playback</div>`
    + setRow({ act: 'set-autoplay', title: 'Autoplay', sub: 'Keep listening to similar songs when your music ends', ctl: tog(S.autoplay) })
    + setRow({ title: 'Crossfade songs', sub: 'Blend the end of one song into the start of the next', ctl: `<div class="slider-row"><input type="range" class="range" id="set-xf" min="0" max="12" step="1" value="${S.crossfade}" style="--pct:${S.crossfade / 12 * 100}%"><span id="set-xf-v">${S.crossfade ? S.crossfade + ' s' : 'Off'}</span></div>` })
    + setRow({ act: 'set-gapless', title: 'Gapless playback', sub: 'Buffer the next song early so albums and DJ mixes flow without silence', ctl: tog(S.gapless) })
    + (feat('smart') ? setRow({ act: 'set-smart', title: 'Smart transitions', sub: 'Skip silence between songs, stretch crossfades over a song\'s own fade-out, and keep albums that flow together gapless', ctl: tog(S.smart !== false) })
      + setRow({ act: 'set-matchvol', title: 'Match volume between songs', sub: 'Bring loud recordings down to the level of the rest, so nothing jumps out', ctl: tog(!!S.matchVol) }) : '')
    + setRow({ title: 'Sleep timer', sub: 'Pause playback after a set time', ctl: `<span class="val" data-sleep-val>${esc(sleepLabel())}</span><button class="btn ghost sm" data-act="sleep-menu">Set</button>` });
  h += `<div class="set-sec">Audio</div>`
    + (SITE.features && SITE.features.transcoding ? setRow({ title: 'Streaming quality', sub: 'Lossless sounds best; smaller streams start faster and use less data. Downloads are always lossless.',
        ctl: `<div class="seg">${Object.entries(QUALITIES).map(([k, l]) => `<button class="${(S.quality || 'original') === k ? 'on' : ''}" data-act="set-quality" data-q="${k}">${esc(l.split(' · ')[0])}</button>`).join('')}</div>` }) : '')
    + setRow({ act: 'eq-toggle', title: 'Equalizer', sub: 'Shape the sound with presets or drag the curve', ctl: tog(S.eqOn) })
    + `<div class="chips" style="margin:8px 0">${Object.entries(EQ_PRESETS).map(([k, [l]]) => `<button class="chip${S.eqPreset === k ? ' on' : ''}" data-act="eq-preset" data-p="${k}">${l}</button>`).join('')}${S.eqPreset === 'custom' ? '<button class="chip on">Custom</button>' : ''}</div>`
    + `<div class="eq-wrap${S.eqOn ? '' : ' disabled'}"><svg class="eq-svg" viewBox="0 0 600 220" preserveAspectRatio="none"></svg><div class="eq-labels">${EQ_BANDS.map(f => `<span>${f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz'}</span>`).join('')}</div></div>`
    + setRow({ title: 'Volume boost', sub: 'Louder output for quiet recordings. Very high values can distort.', ctl: `<div class="seg">${[1, 1.5, 2, 3, 4, 6].map(v => `<button class="${S.boost === v ? 'on' : ''}" data-act="boost" data-v="${v}">${v * 100}%</button>`).join('')}</div>` })
    + setRow({ act: 'set-normalize', title: 'Volume normalization', sub: 'Even out loudness between songs', ctl: tog(S.normalize) });
  h += `<div class="set-sec">Display</div>`
    + setRow({ title: 'Accent colour', sub: 'Used for buttons, progress and highlights', ctl: `<div class="swatches">${ACCENTS.map(c => `<button class="sw${c === accent ? ' on' : ''}" style="background:${c}" data-act="set-accent" data-c="${c}" aria-label="Accent ${c}"></button>`).join('')}<label class="sw custom" aria-label="Custom colour"><input type="color" id="set-color" value="${/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1ed760'}"></label></div>` })
    + setRow({ act: 'set-dyncolor', title: 'Colourful pages', sub: 'Tint pages with album artwork colours', ctl: tog(S.dynColor) })
    + setRow({ act: 'set-notify', title: 'Desktop notifications', sub: 'Show the new song when a track changes while this tab is in the background', ctl: tog(S.notify) });
  h += `<div class="set-sec">Devices & storage</div>`
    + setRow({ act: 'rename-device', title: 'Device name', sub: 'How this computer appears in Connect', ctl: `<span class="val">${esc(Connect.name)}</span>` })
    + setRow({ act: 'go', attrs: 'data-view="downloads"', title: 'Downloads', sub: `${count(Off.set.size, 'song')} saved for offline listening`, ctl: ic('fwd', 'md') })
    + setRow({ title: 'Remove all downloads', ctl: '<button class="btn danger sm" data-act="dl-remove-all">Remove</button>' })
    + setRow({ title: 'Clear cached data', sub: 'Download the library index again. Downloads, likes and playlists are kept.', ctl: '<button class="btn ghost sm" data-act="clear-cache">Clear</button>' });
  h += `<div class="set-sec">About</div>`
    + setRow({ title: 'Keyboard shortcuts', ctl: '<button class="btn ghost sm" data-act="shortcuts">Show</button>' })
    + setRow({ title: 'Library', ctl: `<span class="val">${nf(L.tracks.length)} songs • ${nf(L.albums.length)} releases</span>` })
    + setRow({ title: 'Version', ctl: `<span class="val">Axdio ${esc(SITE.app_version || '—')} • ${D.els.length === 2 ? 'gapless engine' : 'single deck'}</span>` })
    + setRow({ title: 'Mobile site', sub: 'The touch-friendly player for phones and tablets', ctl: '<a class="btn ghost sm" href="/mobile">Open</a>' })
    + `<a class="set-credit" href="${esc(CREDIT.url)}" target="_blank" rel="noopener">${esc(CREDIT.text)}</a>`;
  el.innerHTML = h + '</div>';
  const xf = el.querySelector('#set-xf');
  xf.addEventListener('input', () => { S.crossfade = +xf.value; xf.style.setProperty('--pct', S.crossfade / 12 * 100 + '%'); el.querySelector('#set-xf-v').textContent = S.crossfade ? S.crossfade + ' s' : 'Off'; saveSSoon(); });
  el.querySelector('#set-color').addEventListener('change', e => setAccent(e.target.value));
  eqEditor(el.querySelector('.eq-svg'), el);
};
function eqEditor(svg, root) {
  const W = 600, Hh = 220, pad = 24, xs = EQ_BANDS.map((_, i) => pad + i * (W - 2 * pad) / (EQ_BANDS.length - 1));
  const yOf = g => Hh / 2 - g / 12 * (Hh / 2 - 16);
  const draw = () => {
    const pts = S.eq.map((g, i) => [xs[i], yOf(g)]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
    }
    svg.innerHTML = [0, .25, .5, .75, 1].map(f => `<line class="grid${f === .5 ? ' zero' : ''}" x1="0" x2="${W}" y1="${16 + f * (Hh - 32)}" y2="${16 + f * (Hh - 32)}"/>`).join('')
      + `<path class="area" d="${d} L${xs[xs.length - 1]},${Hh} L${xs[0]},${Hh} Z"/><path class="curve" d="${d}"/>`
      + pts.map((p, i) => `<circle class="knob" cx="${p[0]}" cy="${p[1]}" r="10"><title>${EQ_BANDS[i]} Hz: ${S.eq[i] > 0 ? '+' : ''}${S.eq[i]} dB</title></circle>`).join('');
  };
  draw();
  let band = -1;
  const setFrom = e => { const r = svg.getBoundingClientRect(), y = (e.clientY - r.top) / r.height * Hh; setEqBand(band, Math.round(clamp((Hh / 2 - y) / (Hh / 2 - 16) * 12, -12, 12) * 2) / 2); draw(); };
  svg.addEventListener('pointerdown', e => {
    if (!S.eqOn) return;
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    band = xs.reduce((b, v, i) => Math.abs(v - x) < Math.abs(xs[b] - x) ? i : b, 0);
    svg.setPointerCapture(e.pointerId);
    $$('[data-act="eq-preset"]', root).forEach(b => b.classList.remove('on'));
    setFrom(e);
  });
  svg.addEventListener('pointermove', e => { if (band >= 0) setFrom(e); });
  const end = () => { if (band >= 0) { band = -1; saveS(); } };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
}
const AUTH = { mode: 'login' };
VIEWS.profile = el => {
  if (!U.token) {
    const reg = SITE.registration || 'open';
    if (reg === 'closed') AUTH.mode = 'login';
    const r = AUTH.mode === 'register';
    el.innerHTML = `<div class="content"><div class="auth-card"><h2>${r ? 'Create your account' : `Log in to ${esc(SITE.site_title || 'Axdio')}`}</h2><p class="muted">${r && reg === 'invite' ? 'Sign-ups on this server need an invite code from the admin.' : 'Sync liked songs, playlists and history across all your devices.'}</p>`
      + (reg !== 'closed' ? `<div class="seg"><button class="${r ? '' : 'on'}" data-act="auth-mode" data-m="login">Log in</button><button class="${r ? 'on' : ''}" data-act="auth-mode" data-m="register">Sign up</button></div>` : '')
      + `<div style="margin-top:16px">${discordButton(r ? 'Sign up with Discord' : 'Continue with Discord')}</div>`
      + `<form id="auth-form" novalidate>${r ? '<label class="lbl" for="au-name">Display name</label><input class="field" id="au-name" autocomplete="nickname">' : ''}<label class="lbl" for="au-user">Username</label><input class="field" id="au-user" autocomplete="username" spellcheck="false" required><label class="lbl" for="au-pass">Password</label><input class="field" id="au-pass" type="password" autocomplete="${r ? 'new-password' : 'current-password'}" required>`
      + (r && reg === 'invite' ? `<label class="lbl" for="au-invite">Invite code</label><input class="field" id="au-invite" value="${esc(pendingInvite())}" spellcheck="false" placeholder="ABCD-1234">` : '')
      + `<div class="form-err" id="au-err" role="alert"></div><button class="btn primary" type="submit" style="width:100%;margin-top:12px">${r ? 'Sign up' : 'Log in'}</button></form>`
      + (reg === 'closed' ? '<p class="muted" style="margin-top:16px;font-size:13px">Accounts on this server are created by the admin.</p>' : '') + '</div></div>';
    const form = el.querySelector('#auth-form');
    form.querySelector('#au-user').focus();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const u = form.querySelector('#au-user').value.trim(), pw = form.querySelector('#au-pass').value, n = form.querySelector('#au-name'), inv = form.querySelector('#au-invite');
      const err = form.querySelector('#au-err'), btn = form.querySelector('button[type=submit]');
      if (!u || !pw) { err.textContent = 'Enter your username and password.'; return; }
      if (r && pw.length < minPassword()) { err.textContent = `Use at least ${minPassword()} characters for your password.`; return; }
      btn.disabled = true; err.textContent = '';
      try { const who = await signIn(u, pw, r, n ? n.value.trim() : '', inv ? inv.value.trim().toUpperCase() : undefined); toast(`Welcome, ${who}!`); refreshAll(); renderMe(); Social.start(); if (window.AX.Party) window.AX.Party.start(); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    return;
  }
  const plays = U.history.reduce((s, x) => s + x.count, 0);
  const tops = topArtists(10);
  let h = `<div class="vbg"></div><div class="prof-hero">${feat('avatars') ? `<button class="prof-av" data-act="edit-profile" aria-label="Choose photo">${avatarHtml('lg')}<span class="ph-over">${ic('edit')}<span>Choose photo</span></span></button>` : avatarHtml('lg')}<div class="flex1"><div class="hero-kind">Profile</div><h1>${esc(U.name || U.username)}</h1><div class="hero-line"><span class="muted">@${esc(U.username)}</span><span class="dot"></span><span>${count(Object.keys(U.playlists).length, 'playlist')}</span><span class="dot"></span><span>${count(U.liked.length, 'liked song')}</span><span class="dot"></span><span>${count(U.follows.length, 'following', 'following')}</span><span class="dot"></span><span>${count(plays, 'play')}</span></div></div></div>`
    + `<div class="actions"><button class="pill-btn" data-act="edit-profile">Edit profile</button>${socialOn() ? `<button class="pill-btn" data-act="go" data-view="friends">Friends${Social.me.friends && Social.me.friends.length ? ' · ' + Social.me.friends.length : ''}</button>` : ''}<button class="pill-btn" data-act="change-pw">Change password</button><button class="pill-btn" data-act="logout">Log out</button></div><div class="content">`;
  h += shelf('Top artists', tops.map(itArtist), { kicker: 'Only visible to you' });
  const recentIds = uniq(U.history.map(x => L.byRel.get(x.rel_path)).filter(Boolean).map(t => t.id)).slice(0, 5);
  if (recentIds.length) { const ctx = vctx('list', 'history', 'Recently played', recentIds); h += `<section class="sec"><div class="sec-h"><h2>Recently played</h2><button class="more" data-act="go" data-view="recent">Show all</button></div>${tableShell(ctx, { noHead: true })}</section>`; }
  h += shelf('Playlists', Object.keys(U.playlists).map(itPlaylist));
  h += shelf('Following', U.follows.map(k => L.artistByKey.get(k)).filter(Boolean).map(itArtist));
  el.innerHTML = h + '</div>';
  fillTables(el);
  // The header takes its colour from the profile photo, else from the top artist.
  if (U.avatar && S.dynColor) dominant(U.avatar).then(c => { if (c) view.style.setProperty('--c', tone(c, .32, .25)); });
  else if (tops[0]) paint(tops[0].cover);
};
VIEWS.lyrics = el => {
  const t = curTrack();
  view.style.setProperty('--lc', getComputedStyle(document.documentElement).getPropertyValue('--lc') || '90, 90, 90');
  if (!t) { el.innerHTML = `<div class="lyr-view"><div class="lyr-msg">Play a song to see its lyrics.</div></div>`; return; }
  el.innerHTML = `<div class="lyr-view${LY.synced ? '' : ' plain'}" id="lyr-view">${LY.state === 'ok' ? LY.lines.map((l, i) => `<div class="ll" data-ly="${i}">${esc(l.text) || '&nbsp;'}</div>`).join('') : `<div class="lyr-msg">${esc(lyMsg())}</div>`}</div>`;
  LY.idx = -1; syncLyrics(true);
};

/* ======================================================================
   4. Track tables — select, double-click to play, drag, right-click
   ====================================================================== */
const TT = new Map();   // table options by context id
function tableShell(ctx, o = {}) {
  TT.set(ctx.rid, o);
  const head = o.noHead ? '' : `<div class="tt-h"><div>#</div><div>Title</div>${o.noAlbum ? '' : '<div>Album</div>'}<div>${o.plays ? 'Plays' : ''}</div></div>`;
  return `<div class="tt${o.noAlbum ? ' no-album' : ''}" data-ctx="${ctx.rid}"${o.pl ? ` data-pl="${esc(o.pl)}"` : ''}${o.cpl ? ` data-cpl="${esc(o.cpl)}"` : ''}>${head}<div class="tt-rows"></div></div>`;
}
function trRow(t, i, o = {}) {
  const liked = U.likedSet.has(t.rel), off = !navigator.onLine && !Off.set.has(t.rel);
  return `<div class="tr trk${P.cur === t.id ? ' playing' : ''}${off ? ' off' : ''}" data-t="${t.id}" data-i="${i}" draggable="true">`
    + `<div class="c-num"><span class="n">${o.trackNo ? (t.no || i + 1) : i + 1}</span>${EQB}<button class="c-play" data-act="row-play" tabindex="-1" aria-label="Play ${esc(t.title)}">${ic(P.cur === t.id && isPlaying() ? 'pause' : 'play')}</button></div>`
    + `<div class="c-title">${o.noArt ? '' : `<div class="art">${img(coverUrl(t.rel))}</div>`}<div class="flex1"><div class="t">${esc(t.title)}</div><div class="s"><span class="dl-slot" data-dl="${t.id}">${dlBadge(t.rel)}</span><span class="who">${credits(t)}</span></div></div></div>`
    + (o.noAlbum ? '' : `<div class="c-album"><a class="lnk" data-act="go" data-view="album" data-id="${t.albumId}">${esc(albumOf(t).title)}</a></div>`)
    + `<div class="c-end">${o.by ? o.by(t) : ''}${o.add ? `<button class="row-add" data-act="pl-add-one" data-t="${t.id}" data-tip="Add to this playlist">${ic('add')}</button>` : ''}<button class="row-like${liked ? ' liked' : ''}" data-act="like" data-t="${t.id}" data-tip="${liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}">${ic(liked ? 'heart-f' : 'heart')}</button>${o.plays ? `<span class="plays">${U.plays.get(t.rel) ? nf(U.plays.get(t.rel)) : ''}</span>` : ''}<button class="row-more" data-act="row-more" data-tip="More options for ${esc(t.title)}">${ic('more-h')}</button></div></div>`;
}
function drawRows(tt, indices) {
  const ctx = CTX.get(tt.dataset.ctx), o = TT.get(tt.dataset.ctx) || {}, rows = tt.querySelector('.tt-rows');
  if (!ctx || !rows) return;
  if (rows._dispose) rows._dispose();
  rows.innerHTML = '';
  rows._dispose = chunked(rows, indices.length, k => trRow(L.tracks[ctx.ids[indices[k]]], indices[k], o), 80);
}
function fillTables(root) {
  $$('.tt[data-ctx]', root).forEach(tt => {
    const rows = tt.querySelector('.tt-rows');
    if (!rows || rows.dataset.filled) return;
    rows.dataset.filled = '1';
    const ctx = CTX.get(tt.dataset.ctx), o = TT.get(tt.dataset.ctx) || {};
    if (!ctx) return;
    drawRows(tt, ctx.ids.map((_, i) => i).slice(0, o.limit || ctx.ids.length));
  });
  $$('[data-dlc]', root).forEach(updateDlButton);
}
function filterTable(tt, q) {
  if (!tt) return;
  const ctx = CTX.get(tt.dataset.ctx), nq = norm(q.trim());
  const idx = ctx.ids.map((_, i) => i).filter(i => !nq || L.tracks[ctx.ids[i]].s.includes(nq));
  drawRows(tt, idx);
  if (!idx.length) tt.querySelector('.tt-rows').insertAdjacentHTML('afterbegin', `<p class="list-foot">Nothing matches “${esc(q)}”.</p>`);
}
function playRow(row) {
  const tt = row.closest('[data-ctx]'), ctx = tt && CTX.get(tt.dataset.ctx), id = +row.dataset.t, t = L.tracks[id];
  if (!t) return;
  if (!navigator.onLine && !Off.set.has(t.rel)) { toast("This song isn't downloaded"); return; }
  if (!ctx) { playTrackAlone(id); return; }
  if (P.cur === id && ctxPlaying(ctx)) { togglePlay(); return; }
  if (ctx.type === 'search') rememberSearch('track', t.rel);
  playCtx(ctx, +row.dataset.i);
}
// Selection: click, Ctrl/Cmd+click to toggle, Shift+click for a range — like a file manager.
const SEL = {
  tt: null, set: new Set(), anchor: -1,
  reset() { this.tt = null; this.set.clear(); this.anchor = -1; },
  apply() { $$('.tr.sel').forEach(r => r.classList.remove('sel')); if (this.tt) $$('.tr', this.tt).forEach(r => r.classList.toggle('sel', this.set.has(+r.dataset.i))); },
  ids() { const ctx = this.tt && CTX.get(this.tt.dataset.ctx); return ctx ? [...this.set].sort((a, b) => a - b).map(i => ctx.ids[i]).filter(x => x != null) : []; },
  only(tt, i) { this.reset(); this.tt = tt; this.set.add(i); this.anchor = i; this.apply(); },
};
function rowClick(row, e) {
  const tt = row.closest('.tt'), i = +row.dataset.i;
  if (SEL.tt !== tt) { SEL.reset(); SEL.tt = tt; }
  if (e.shiftKey && SEL.anchor >= 0) {
    const rows = $$('.tr', tt).filter(r => !r.hidden), a = rows.findIndex(r => +r.dataset.i === SEL.anchor), b = rows.indexOf(row);
    if (!(e.ctrlKey || e.metaKey)) SEL.set.clear();
    if (a >= 0) rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(r => SEL.set.add(+r.dataset.i));
  } else if (e.ctrlKey || e.metaKey) { if (SEL.set.has(i)) SEL.set.delete(i); else SEL.set.add(i); SEL.anchor = i; }
  else { SEL.set.clear(); SEL.set.add(i); SEL.anchor = i; }
  SEL.apply();
}
function tableKeys(e) {
  const rows = $$('.tr', SEL.tt).filter(r => !r.hidden);
  if (!rows.length) return;
  const cur = rows.findIndex(r => +r.dataset.i === SEL.anchor);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = clamp(cur + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1), r = rows[n];
    if (e.shiftKey) SEL.set.add(+r.dataset.i); else SEL.set.clear(), SEL.set.add(+r.dataset.i);
    SEL.anchor = +r.dataset.i; SEL.apply();
    r.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); playRow(rows[cur]); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && (SEL.tt.dataset.pl || SEL.tt.dataset.cpl)) { e.preventDefault(); removeSelected(SEL.tt.dataset.pl, SEL.tt.dataset.cpl); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); rows.forEach(r => SEL.set.add(+r.dataset.i)); SEL.apply(); }
}
function removeSelected(name, cpl) {
  const ids = SEL.ids(); if (!ids.length) return;
  const rels = ids.map(id => L.tracks[id].rel);
  if (cpl) { Collab.remove(cpl, rels); toast(`Removed ${count(ids.length, 'song')}`, { action: 'Undo', onAction: () => Collab.add(cpl, ids) }); return; }
  removeFromPlaylist(name, rels);
  toast(`Removed ${count(ids.length, 'song')} from ${name}`, { action: 'Undo', onAction: () => addToPlaylist(name, ids) });
}

/* ======================================================================
   5. Sidebar (Your Library) & right panel (Now Playing / Queue)
   ====================================================================== */
const SIDE = { f: S.sideFilter || '', q: '', find: false };
const SIDE_MIN_W = 280;   // narrowest expanded library where the header and compact chips still fit on one line
const SORTS = { recent: 'Recents', added: 'Recently added', alpha: 'Alphabetical' };
const liHtml = it => `<div class="li${it.circle ? ' circle' : ''}${P.ctx && it.ck === P.ctx.recent ? ' ctx-playing' : ''}" ${openAttrs(it)} draggable="true"${S.sideMin ? ` data-tip="${esc(it.title)}"` : ''}><div class="li-art">${it.cover}</div><div class="li-meta"><div class="li-t">${esc(it.title)}</div><div class="li-s">${it.pinned ? `<span class="pin">${ic('pin')}</span>` : ''}<span class="ell">${esc(it.sub)}</span></div></div><span class="spk">${ic('volume', 'sm')}</span></div>`;
const SIDE_TABS = [['playlists', 'Playlists'], ['artists', 'Artists'], ['albums', 'Albums'], ['downloaded', 'Downloads']];
function renderSide() {
  const side = byId('side'), min = S.sideMin;
  side.classList.toggle('grid', S.sideView === 'grid');
  side.classList.toggle('compact', S.sideView === 'compact');
  side.classList.toggle('finding', SIDE.find && !min);
  side.innerHTML = `<div class="side-h">`
      + `<button class="side-title" data-act="side-collapse" data-tip="${min ? 'Expand' : 'Collapse'} Your Library">${ic(min ? 'lib' : 'lib-f')}<span>Your Library</span></button>`
      + `<div class="side-find">${ic('search', 'sm')}<input id="side-q" placeholder="Search in Your Library" value="${esc(SIDE.q)}" autocomplete="off" aria-label="Search in Your Library"><button class="icon-btn" data-act="side-find" data-tip="Close search" aria-label="Close search">${ic('close', 'sm')}</button></div>`
      + `<div class="side-acts">`
      + `<button class="icon-btn" data-act="side-find" data-tip="Search in Your Library" aria-label="Search in Your Library">${ic('search', 'sm')}</button>`
      + `<button class="icon-btn" data-act="side-sort" data-tip="Sort: ${SORTS[S.libSort] || 'Recents'}" aria-label="Sort and view">${ic('sort', 'sm')}</button>`
      + `<button class="icon-btn" data-act="create-menu" data-tip="Create" aria-label="Create">${ic('plus', 'sm')}</button>`
      + `</div></div>`
    + `<nav class="side-tabs" role="tablist" aria-label="Filter Your Library">${SIDE_TABS.map(([k, l]) => `<button class="stab${SIDE.f === k ? ' on' : ''}" role="tab" aria-selected="${SIDE.f === k}" data-act="side-filter" data-f="${k}">${l}</button>`).join('')}<i class="stab-ind"></i></nav>`
    + `<div class="side-list" id="side-list"></div><div class="resizer" data-resize="side"></div>`;
  const input = byId('side-q');
  input.addEventListener('input', debounce(() => { SIDE.q = input.value; drawSideList(); }, 120));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { SIDE.q = ''; SIDE.find = false; renderSide(); } });
  if (SIDE.find && SIDE.focus) { SIDE.focus = false; input.focus(); }
  fitTabs();
  drawSideList();
}
// Tabs keep one line at any library width by tightening their spacing; the underline slides to the chosen tab.
function fitTabs() {
  const nav = document.querySelector('#side .side-tabs'); if (!nav || !nav.offsetWidth) return;
  for (const f of ['', 'tight', 'tighter']) { nav.className = 'side-tabs ' + f; if (nav.scrollWidth <= nav.clientWidth) break; }
  placeTabInd(nav);
}
function placeTabInd(nav) {
  const ind = nav.querySelector('.stab-ind'), on = nav.querySelector('.stab.on');
  const to = on ? { l: on.offsetLeft, w: on.offsetWidth } : null, from = SIDE.ind;
  const set = r => { ind.style.transform = `translateX(${r.l}px)`; ind.style.width = r.w + 'px'; ind.style.opacity = r.w ? 1 : 0; };
  ind.style.transition = 'none';
  set(from || (to ? { l: to.l + to.w / 2, w: 0 } : { l: 0, w: 0 }));
  void ind.offsetWidth;
  ind.style.transition = '';
  set(to || (from ? { l: from.l + from.w / 2, w: 0 } : { l: 0, w: 0 }));
  SIDE.ind = to;
}
new ResizeObserver(() => fitTabs()).observe(byId('side'));
if (document.fonts) document.fonts.ready.then(fitTabs);
let sideDispose = null;
function drawSideList() {
  const box = byId('side-list'); if (!box) return;
  if (sideDispose) { sideDispose(); sideDispose = null; }
  if (!L.ready) { box.innerHTML = '<div class="li"><div class="li-art sk"></div><div class="li-meta"><div class="sk" style="height:14px;width:60%"></div></div></div>'.repeat(6); return; }
  const items = libItems(SIDE.f, SIDE.q, S.libSort);
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = `<div class="side-empty"><b>${SIDE.q ? 'No matches' : 'Nothing here yet'}</b><p>${SIDE.q ? 'Try a different search.' : 'Save albums, follow artists and make playlists to fill this up.'}</p></div>`; return; }
  sideDispose = chunkRender(box, box, items.length, i => liHtml(items[i]), 80);
  const hints = [];
  if (!Object.keys(U.playlists).length) hints.push(ghostLi('new-playlist', '', 'plus', 'Create playlist', "It's easy, we'll help you"));
  if (!U.follows.length) hints.push(ghostLi('go', 'data-view="list" data-kind="artists"', 'person-add', 'Follow artists', 'Keep your favourites up top', true));
  if (!SIDE.f && !SIDE.q && !S.sideMin && hints.length) box.insertAdjacentHTML('beforeend', hints.join(''));
  markSideActive();
}
const ghostLi = (act, attrs, icon, t, sub, circle) => `<div class="li ghost${circle ? ' circle' : ''}" data-act="${act}" ${attrs}><div class="li-art">${ic(icon)}</div><div class="li-meta"><div class="li-t">${t}</div><div class="li-s">${sub}</div></div></div>`;
const renderSideSoon = debounce(drawSideList, 60);
function routeKey() {
  const r = V.route; if (!r) return '';
  const p = r.params || {};
  return { album: 'album:' + p.key, artist: 'artist:' + p.key, playlist: 'playlist:' + p.name, cpl: 'cpl:' + p.id, mix: 'mix:' + p.id, liked: 'liked', downloads: 'downloads' }[r.view] || '';
}
function markSideActive() { const k = routeKey(); $$('#side .li').forEach(li => li.classList.toggle('active', !!k && li.dataset.ck === k)); }
function layout() {
  shell.style.setProperty('--side-w', (S.sideMin ? 72 : clamp(S.sideW, SIDE_MIN_W, 480)) + 'px');
  shell.style.setProperty('--right-w', S.rightW + 'px');
  shell.classList.toggle('side-min', !!S.sideMin);
  shell.classList.toggle('no-right', !RP.mode);
  byId('btn-np').classList.toggle('on', RP.mode === 'np');
  byId('btn-queue').classList.toggle('on', RP.mode === 'queue');
  renderSocialButtons();
}
document.addEventListener('pointerdown', e => {
  const rz = e.target.closest('.resizer'); if (!rz) return;
  e.preventDefault();
  rz.classList.add('drag'); rz.setPointerCapture(e.pointerId);
  const which = rz.dataset.resize, x0 = e.clientX, w0 = which === 'side' ? (S.sideMin ? 72 : clamp(S.sideW, SIDE_MIN_W, 480)) : S.rightW;
  const move = ev => {
    const dx = ev.clientX - x0;
    if (which === 'side') { const w = w0 + dx; if (w < 190) S.sideMin = true; else { S.sideMin = false; S.sideW = clamp(w, SIDE_MIN_W, 480); } }
    else S.rightW = clamp(w0 - dx, 280, 480);
    layout();
  };
  const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); saveS(); if (which === 'side') renderSide(); };
  rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
});

const RP = { mode: S.panel || '' };
function setPanel(mode) { RP.mode = RP.mode === mode ? '' : mode; S.panel = RP.mode; saveS(); layout(); renderPanel(); }
function renderPanel() {
  const rp = byId('rp');
  Social.activityOpen = RP.mode === 'friends';
  if (!RP.mode) { rp.innerHTML = ''; return; }
  if (RP.mode === 'friends') { if (socialOn()) renderFriendsPanel(rp); else setPanel('friends'); }
  else if (RP.mode === 'party') renderPartyPanel(rp);
  else if (RP.mode === 'queue') renderQueuePanel(rp); else renderNP(rp);
}
const ctxLabel = () => {
  const c = P.ctx; if (!c) return 'Now playing';
  return c.recent ? `<a class="lnk" data-act="go-ctx">${esc(c.name)}</a>` : esc(c.name);
};
const qrow = (t, kind, i) => `<div class="qrow${kind === 'now' ? ' now' : ''}" data-q="${kind}" data-qi="${i}" data-t="${t.id}"><div class="qa">${img(coverUrl(t.rel))}</div><div class="flex1"><div class="t">${esc(t.title)}</div><div class="s"><span class="dl-slot" data-dl="${t.id}">${dlBadge(t.rel)}</span><span class="ell">${esc(t.artist)}</span></div></div>${kind === 'user' ? `<button class="qx" data-act="q-remove" data-qi="${i}" data-tip="Remove from queue">${ic('close', 'sm')}</button><span data-drag aria-label="Drag to reorder">${ic('drag', 'sm')}</span>` : ''}</div>`;
function renderNP(rp) {
  const t = curTrack();
  const head = `<div class="rp-h"><b>${ctxLabel()}</b>${t ? `<button class="icon-btn" data-act="more-cur" data-tip="More options">${ic('more-h', 'md')}</button>` : ''}<button class="icon-btn" data-act="close-panel" data-tip="Close">${ic('close', 'md')}</button></div>`;
  if (!t) { rp.innerHTML = head + `<div class="rp-body">${emptyHtml('note', 'Nothing playing', 'Pick something to play and it shows up here.')}</div>`; return; }
  const al = albumOf(t), ar = artistOf(t), liked = U.likedSet.has(t.rel), following = U.follows.includes(ar.key);
  const upId = P.queue.length ? P.queue[0] : (upcoming(1)[0] || {}).id;
  const up = upId != null ? L.tracks[upId] : null;
  rp.innerHTML = head + `<div class="rp-body">`
    + `<div class="np-art">${img(coverUrl(t.rel))}<button class="expand" data-act="fullscreen" data-tip="Full screen">${ic('expand', 'sm')}</button></div>`
    + `<div class="np-meta"><div class="flex1"><div class="np-t"><a class="lnk" data-act="go" data-view="album" data-id="${al.id}">${esc(t.title)}</a></div><div class="np-a">${credits(t)}</div></div><button class="icon-btn pb-like${liked ? ' liked' : ''}" data-act="like-cur" data-tip="${liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}">${ic(liked ? 'heart-f' : 'heart')}</button></div>`
    + (LY.state === 'ok' ? `<div class="np-card"><div class="np-card-h"><span>Lyrics</span><button data-act="lyrics">Show lyrics</button></div><div class="lyr-peek" data-act="lyrics"><div id="np-lyr" style="transition:transform .5s var(--ease)">${LY.lines.map((l, i) => `<div class="ll${LY.synced ? '' : ' on'}" data-ly="${i}">${esc(l.text) || '&nbsp;'}</div>`).join('')}</div></div></div>` : '')
    + `<div class="np-card"><div class="about-img" style="background-image:${esc(cssUrl(coverUrl(ar.cover)))}"><span>About the artist</span></div><div class="about-body"><div class="flexrow"><div class="flex1"><b><a class="lnk" data-act="go" data-view="artist" data-id="${ar.id}">${esc(ar.name)}</a></b><div class="muted" style="font-size:13px;margin-top:4px">${count(ar.trackIds.length, 'song')} • ${count(ar.albumIds.length, 'release')} in your library</div></div><button class="pill-btn${following ? ' on' : ''}" data-act="follow" data-id="${ar.id}" data-follow="${ar.id}">${following ? 'Following' : 'Follow'}</button></div></div></div>`
    + `<div class="np-card"><div class="np-card-h"><span>Credits</span><button data-act="credits">Show all</button></div><div class="credits"><div>${credits(t)}<div class="muted">Performed by</div></div><div><a class="lnk" data-act="go" data-view="album" data-id="${al.id}">${esc(al.title)}</a><div class="muted">${esc(al.type)}${al.comp ? ' • Various artists' : ''}</div></div><div>${esc(fileExt(t.rel))}${Off.set.has(t.rel) ? ' • Downloaded' : ''}<div class="muted">Audio file</div></div></div></div>`
    + (up ? `<div class="np-card"><div class="np-card-h"><span>Next in queue</span><button data-act="toggle-queue">Open queue</button></div><div style="padding:0 8px 8px">${qrow(up, P.queue.length ? 'user' : 'ctx', P.queue.length ? 0 : (upcoming(1)[0] || {}).pos)}</div></div>` : '')
    + '</div>';
  syncLyrics(true);
}
function renderPartyPanel(rp) {
  if (!rp.querySelector('#party-mount')) rp.innerHTML = `<div class="rp-h"><b>Listening party</b><button class="icon-btn" data-act="close-panel" data-tip="Close">${ic('close', 'md')}</button></div><div class="rp-body"><div id="party-mount" style="padding:4px 16px 20px"></div></div>`;
  if (window.AX.Party) window.AX.Party.render(byId('party-mount'));
}
function renderQueuePanel(rp) {
  const t = curTrack();
  let h = `<div class="rp-h"><b>Queue</b><button class="icon-btn" data-act="go" data-view="recent" data-tip="Recently played">${ic('history', 'md')}</button><button class="icon-btn" data-act="close-panel" data-tip="Close">${ic('close', 'md')}</button></div><div class="rp-body" id="rp-body">`;
  if (!t) { rp.innerHTML = h + emptyHtml('queue', 'Add to your queue', 'Tap "Add to queue" from a song\'s menu, or drag songs here.') + '</div>'; return; }
  h += `<div class="q-sec"><span>Now playing</span></div>${qrow(t, 'now', 0)}`;
  if (P.queue.length) h += `<div class="q-sec"><span>Next in queue</span><button data-act="q-clear">Clear queue</button></div><div id="q-user">${P.queue.map((id, i) => qrow(L.tracks[id], 'user', i)).join('')}</div>`;
  const up = upcoming(80);
  if (up.length) h += `<div class="q-sec"><span>Next from: ${esc(P.ctx.name)}</span></div>${up.map(u => qrow(L.tracks[u.id], 'ctx', u.pos)).join('')}`;
  else if (S.autoplay) h += `<p class="list-foot">${ic('radio', 'sm')} Autoplay keeps similar music going after this.</p>`;
  rp.innerHTML = h + '</div>';
  const userList = byId('q-user');
  if (userList) dragSort(userList, '.qrow', '.rp-body', queueMove);
}

/* ======================================================================
   6. Player bar, fullscreen & miniplayer
   ====================================================================== */
const pb = { img: byId('pb-img'), t: byId('pb-t'), a: byId('pb-a'), range: byId('pb-range'), cur: byId('pb-cur'), dur: byId('pb-dur'), vol: byId('vol'), mute: byId('btn-mute') };
let lastSec = -1, scrubbing = false, lyrTouched = 0;
function onTrack(t) {
  byId('bar').classList.toggle('idle', !t);
  if (!t) { pb.img.removeAttribute('src'); pb.t.textContent = ''; pb.a.innerHTML = ''; renderPanel(); return; }
  pb.img.src = coverUrl(t.rel);
  pb.t.textContent = t.title; pb.t.dataset.id = t.albumId;
  pb.a.innerHTML = credits(t); pb.a.classList.remove('remote');
  if (S.dynColor) dominant(coverUrl(t.rel)).then(c => { if (c && curTrack() === t) { document.documentElement.style.setProperty('--lc', tone(c, .4, .45, .75)); if (V.route && V.route.view === 'lyrics') view.style.setProperty('--lc', tone(c, .4, .45, .75)); } });
  renderPanel(); renderFs(); renderPip(); notify(t);
}
function onPlayState(playing) {
  $$('.hover-play[data-hp]').forEach(b => { const on = playing && P.ctx && b.dataset.hp === P.ctx.recent; b.innerHTML = playIcon(on); b.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
  $$('.tr.playing .c-play').forEach(b => { b.innerHTML = playIcon(playing); });
  $$('.tr:not(.playing) .c-play').forEach(b => { if (b.querySelector('use').getAttribute('href') !== '#i-play') b.innerHTML = ic('play'); });
  byId('pb-play').dataset.tip = playing ? 'Pause' : 'Play';
  if (playing) document.body.classList.remove('remote');
  renderPip();
}
function onProgress(force) {
  const dur = (P.pending ? P.dur : audio.duration) || P.dur || 0, cur = P.pending ? P.pending.t : audio.currentTime || 0, f = dur ? clamp(cur / dur, 0, 1) : 0;
  if (!scrubbing) [pb.range, byId('fs-range')].forEach(r => { r.value = Math.round(f * 1000); r.style.setProperty('--pct', f * 100 + '%'); });
  const sec = Math.floor(cur);
  if (sec !== lastSec || force) {
    lastSec = sec;
    if (!scrubbing) { pb.cur.textContent = byId('fs-cur').textContent = fmt(cur); }
    pb.dur.textContent = byId('fs-dur').textContent = fmt(dur);
    if (PIP.win) { const r = PIP.win.document.getElementById('pip-prog'); if (r) r.style.width = f * 100 + '%'; }
  }
}
function bindRange(r) {
  r.addEventListener('input', () => {
    scrubbing = true;
    const dur = (P.pending ? P.dur : audio.duration) || 0, v = r.value / 1000;
    r.style.setProperty('--pct', v * 100 + '%');
    pb.cur.textContent = byId('fs-cur').textContent = fmt(v * dur);
  });
  r.addEventListener('change', () => { const dur = (P.pending ? P.dur : audio.duration) || 0; seek(r.value / 1000 * dur); scrubbing = false; onProgress(true); });
}
bindRange(pb.range); bindRange(byId('fs-range'));
function onVolume() {
  const v = S.muted ? 0 : S.volume;
  pb.vol.value = Math.round(v * 100); pb.vol.style.setProperty('--pct', v * 100 + '%');
  setUse(pb.mute, v === 0 ? 'vol-0' : v < .34 ? 'vol-1' : v < .67 ? 'vol-2' : 'volume');
  pb.mute.dataset.tip = S.muted ? 'Unmute' : 'Mute';
}
pb.vol.addEventListener('input', () => setVolume(pb.vol.value / 100));
byId('vol-wrap').addEventListener('wheel', e => { e.preventDefault(); setVolume((S.muted ? 0 : S.volume) + (e.deltaY < 0 ? .05 : -.05)); }, { passive: false });
function onRemote(name) {
  document.body.classList.add('remote');
  byId('remote-strip').innerHTML = `${ic('devices', 'sm')}Playing on ${esc(name)}`;
  pb.a.textContent = `Playing on ${name}`; pb.a.classList.add('remote');
}
function onQueue() { if (RP.mode) renderPanel(); }
function onLyrics() {
  if (V.route && V.route.view === 'lyrics') VIEWS.lyrics(view);
  if (RP.mode === 'np') renderPanel();
  renderFsLyrics();
}
function onLyricLine(i, force) {
  [byId('lyr-view'), byId('np-lyr'), byId('fs-lines')].forEach(box => {
    if (!box) return;
    $$('.ll', box).forEach((n, k) => { n.classList.toggle('on', k === i); n.classList.toggle('past', k < i); });
  });
  const lv = byId('lyr-view');
  if (lv && i >= 0 && now() - lyrTouched > 3500) { const line = lv.querySelector(`[data-ly="${i}"]`); if (line) view.scrollTo({ top: line.offsetTop - view.clientHeight * .35, behavior: force ? 'auto' : 'smooth' }); }
  const np = byId('np-lyr');
  if (np) { const pl = i >= 0 ? np.querySelector(`[data-ly="${i}"]`) : null; np.style.transform = `translateY(${pl ? -Math.max(0, pl.offsetTop - 60) : 0}px)`; }
  const fl = byId('fs-lines');
  if (fl && FS.lyr) { const pl = i >= 0 ? fl.querySelector(`[data-ly="${i}"]`) : null; fl.style.transform = `translateY(${pl ? -(pl.offsetTop - fl.parentElement.clientHeight * .35) : 0}px)`; }
}
view.addEventListener('wheel', () => { lyrTouched = now(); }, { passive: true });
function notify(t) {
  if (!S.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(t.title, { body: `${t.artist} — ${albumOf(t).title}`, icon: coverUrl(t.rel), tag: 'axdio-now', silent: true }); } catch (e) { /* not allowed here */ }
}

const FS = { open: false, lyr: false, scene: null, idle: 0, clock: 0, lock: null };
function openFs() {
  if (!curTrack()) { toast('Play something first'); return; }
  FS.open = true; byId('fs').classList.add('open'); byId('fs').setAttribute('aria-hidden', 'false'); renderFs();
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  fsViz(); fsWake(); fsTick(); FS.clock = setInterval(fsTick, 1000);
}
function closeFs() {
  FS.open = false; byId('fs').classList.remove('open', 'idle'); byId('fs').setAttribute('aria-hidden', 'true');
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  if (FS.scene) FS.scene.stop();
  clearInterval(FS.clock); clearTimeout(FS.idle);
  if (FS.lock) { FS.lock.release().catch(() => {}); FS.lock = null; }
}
// Visuals painted from the cover and driven by the music (web/app/immersive.js).
function fsViz() {
  const Vis = window.AX.Vis, fs = byId('fs');
  if (!Vis) return;
  if (!FS.scene) FS.scene = Vis.mount(byId('fs-viz'), { art: byId('fs-art'), len: .3 });
  const on = Vis.on && FS.open;
  fs.classList.toggle('viz', on); byId('fs-viz-btn').classList.toggle('on', Vis.on);
  if (on) { const t = curTrack(); FS.scene.setTrack(t ? coverUrl(t.rel) : ''); FS.scene.start(); } else FS.scene.stop();
  fsWake();
}
// Ambient mode: when the mouse rests, the controls and cursor fade away and a clock takes their place, like a TV screensaver.
function fsWake() {
  const fs = byId('fs');
  fs.classList.remove('idle'); clearTimeout(FS.idle);
  if (FS.open) FS.idle = setTimeout(() => { if (FS.open && isPlaying() && !fs.querySelector('.fs-bottom:hover, .fs-top:hover')) fs.classList.add('idle'); else fsWake(); }, 3500);
  if (FS.open && !FS.lock && navigator.wakeLock && isPlaying()) navigator.wakeLock.request('screen').then(l => { if (FS.open) FS.lock = l; else l.release(); }).catch(() => {});
}
function fsTick() {
  const box = byId('fs-clock');
  box.firstElementChild.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const nid = P.queue.length ? P.queue[0] : (upcoming(1)[0] || {}).id, n = nid != null ? L.tracks[nid] : null;
  box.lastElementChild.textContent = n ? `Up next · ${n.title} · ${n.artist}` : '';
}
['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart'].forEach(ev => byId('fs').addEventListener(ev, () => { if (FS.open) fsWake(); }, { passive: true }));
document.addEventListener('visibilitychange', () => { if (FS.open && !document.hidden) { FS.lock = null; fsWake(); } });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && FS.open) closeFs(); });
function renderFs() {
  if (!FS.open) return;
  const t = curTrack(); if (!t) return;
  byId('fs-bg').style.backgroundImage = cssUrl(coverUrl(t.rel));
  byId('fs-art').src = coverUrl(t.rel);
  byId('fs-title').textContent = t.title;
  byId('fs-artist').textContent = t.artist;
  byId('fs-ctx').textContent = P.ctx ? P.ctx.name : albumOf(t).title;
  if (FS.scene && FS.scene.running) FS.scene.setTrack(coverUrl(t.rel));
  fsTick();
  renderFsLyrics();
}
function renderFsLyrics() {
  const box = byId('fs-lyrics');
  byId('fs').classList.toggle('lyr', FS.lyr);
  byId('fs-lyr-btn').classList.toggle('on', FS.lyr);
  box.hidden = !FS.lyr;
  if (!FS.lyr || !FS.open) return;
  byId('fs-lines').innerHTML = LY.state === 'ok' ? LY.lines.map((l, i) => `<div class="ll${LY.synced ? '' : ' on'}" data-ly="${i}">${esc(l.text) || '&nbsp;'}</div>`).join('') : `<div class="ll on">${esc(lyMsg())}</div>`;
  syncLyrics(true);
}

// Miniplayer in its own always-on-top window (Document Picture-in-Picture, Chrome/Edge 116+).
const PIP = { win: null };
const PIP_CSS = `body{margin:0;background:#121212;color:#fff;font:14px 'Plus Jakarta Sans',system-ui,sans-serif;overflow:hidden;user-select:none}
.pip{position:fixed;inset:0;display:flex;flex-direction:column}.pip-art{flex:1;min-height:0;background:#282828 center/cover no-repeat;position:relative}
.pip-art::after{content:'';position:absolute;inset:0;background:linear-gradient(transparent 45%,rgba(0,0,0,.85))}
.pip-meta{position:absolute;left:14px;right:14px;bottom:62px;z-index:1}.pip-t{font-weight:800;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pip-a{color:#ddd;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.pip-bar{height:3px;background:rgba(255,255,255,.25);position:absolute;left:0;right:0;bottom:52px;z-index:1}
.pip-bar i{display:block;height:100%;background:#fff;width:0}.pip-ctl{height:52px;display:flex;align-items:center;justify-content:center;gap:18px;background:#181818}
.pip-ctl button{background:none;border:0;color:#fff;cursor:pointer;display:grid;place-items:center;width:36px;height:36px;border-radius:50%}
.pip-ctl button.play{background:#fff;color:#000}.pip-ctl button.liked{color:var(--acc,#1ed760)}.i{width:22px;height:22px;fill:currentColor}`;
async function togglePip() {
  if (PIP.win) { PIP.win.close(); PIP.win = null; return; }
  if (!('documentPictureInPicture' in window)) { toast("Your browser doesn't support the miniplayer yet — try Chrome or Edge"); return; }
  try {
    const w = await window.documentPictureInPicture.requestWindow({ width: 320, height: 380 });
    PIP.win = w;
    const st = w.document.createElement('style'); st.textContent = PIP_CSS; w.document.head.appendChild(st);
    const fonts = document.querySelector('link[href*="/web/fonts/"]'); if (fonts) { const l = fonts.cloneNode(); l.href = fonts.href; w.document.head.appendChild(l); }
    w.document.body.innerHTML = byId('ax-icons').outerHTML + `<div class="pip"><div class="pip-art" id="pip-art"></div><div class="pip-meta"><div class="pip-t" id="pip-t"></div><div class="pip-a" id="pip-a"></div></div><div class="pip-bar"><i id="pip-prog"></i></div><div class="pip-ctl"><button data-p="like" id="pip-like">${ic('heart', 'md')}</button><button data-p="prev">${ic('prev')}</button><button data-p="toggle" class="play" id="pip-pp">${ic('play')}</button><button data-p="next">${ic('next')}</button><button data-p="back" title="Back to the tab">${ic('external', 'md')}</button></div></div>`;
    w.document.body.style.setProperty('--acc', getComputedStyle(document.documentElement).getPropertyValue('--accent'));
    w.document.addEventListener('click', e => {
      const b = e.target.closest('[data-p]'); if (!b) return;
      ({ like: () => toggleLike(curTrack()), prev, toggle: togglePlay, next: () => next(), back: () => w.close() })[b.dataset.p]();
      renderPip();
    });
    w.addEventListener('pagehide', () => { PIP.win = null; byId('btn-pip').classList.remove('on'); });
    byId('btn-pip').classList.add('on');
    renderPip();
  } catch (e) { toast("Couldn't open the miniplayer"); }
}
function renderPip() {
  if (!PIP.win) return;
  const d = PIP.win.document, t = curTrack();
  d.getElementById('pip-art').style.backgroundImage = t ? cssUrl(location.origin + coverUrl(t.rel)) : '';
  d.getElementById('pip-t').textContent = t ? t.title : 'Nothing playing';
  d.getElementById('pip-a').textContent = t ? t.artist : '';
  setUse(d.getElementById('pip-pp'), isPlaying() ? 'pause' : 'play');
  const lk = d.getElementById('pip-like'), on = !!(t && U.likedSet.has(t.rel));
  lk.classList.toggle('liked', on); setUse(lk, on ? 'heart-f' : 'heart');
}

/* ======================================================================
   7. Menus, dialogs, toasts, tooltips, drag & drop
   ====================================================================== */
let MENUS = [];
function closeMenus(depth = 0) { MENUS.splice(depth).forEach(m => m.remove()); }
function openMenu(x, y, items, depth = 0, anchor = null) {
  closeMenus(depth);
  items = items.filter(it => it && !(it.feat && !feat(it.feat)));
  const m = document.createElement('div');
  m.className = 'cm'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, k) => it.sep ? '<div class="cm-sep"></div>'
    : it.find ? `<label class="cm-find">${ic('search')}<input placeholder="${esc(it.find)}" autocomplete="off"></label>`
    : it.head ? `<div class="cm-i" style="pointer-events:none;color:var(--text-2);font-size:12px;font-weight:700">${esc(it.head)}</div>`
    : `<button class="cm-i${it.on ? ' on' : ''}${it.danger ? ' danger' : ''}" data-k="${k}" role="menuitem"${it.disabled ? ' disabled' : ''}>${it.icon ? ic(it.icon) : ''}<span class="ell">${esc(it.label)}</span>${it.sub ? `<span class="sub-arrow">${ic('fwd')}</span>` : it.note ? `<span class="note">${esc(it.note)}</span>` : ''}</button>`).join('');
  document.body.appendChild(m);
  MENUS[depth] = m;
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = x, top = y;
  if (anchor) { left = anchor.right - 4; top = anchor.top - 4; if (left + w > innerWidth - 8) left = anchor.left - w + 4; }
  else if (left + w > innerWidth - 8) left = innerWidth - w - 8;
  if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
  m.style.left = Math.max(8, left) + 'px'; m.style.top = top + 'px';
  let subT = 0;
  const openSub = btn => { const it = items[+btn.dataset.k]; if (it && it.sub) openMenu(0, 0, typeof it.sub === 'function' ? it.sub() : it.sub, depth + 1, btn.getBoundingClientRect()); };
  m.addEventListener('mouseover', e => {
    const b = e.target.closest('.cm-i[data-k]'); if (!b) return;
    $$('.cm-i.hl', m).forEach(x => x.classList.remove('hl')); b.classList.add('hl');
    clearTimeout(subT);
    subT = setTimeout(() => { if (items[+b.dataset.k].sub) openSub(b); else closeMenus(depth + 1); }, 160);
  });
  m.addEventListener('click', e => {
    const b = e.target.closest('.cm-i[data-k]'); if (!b) return;
    const it = items[+b.dataset.k];
    if (it.sub) { openSub(b); return; }
    closeMenus();
    if (it.act) it.act();
  });
  const find = m.querySelector('.cm-find input');
  if (find) {
    find.focus();
    find.addEventListener('input', () => { const q = norm(find.value); $$('.cm-i[data-k]', m).forEach(b => { const it = items[+b.dataset.k]; if (it.filterable) b.hidden = !!q && !norm(it.label).includes(q); }); });
  }
  return m;
}
function menuAt(el, items) { const r = el.getBoundingClientRect(); openMenu(r.left, r.bottom + 6, items); }
function menuKeys(e) {
  const m = MENUS[MENUS.length - 1]; if (!m) return false;
  const btns = $$('.cm-i[data-k]:not([disabled])', m).filter(b => !b.hidden), cur = btns.findIndex(b => b.classList.contains('hl'));
  if (e.key === 'Escape') { e.preventDefault(); closeMenus(MENUS.length - 1); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = btns[(cur + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]; btns.forEach(b => b.classList.remove('hl')); if (n) { n.classList.add('hl'); n.focus(); } return true; }
  if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); btns[cur].click(); return true; }
  if (e.key === 'ArrowRight' && cur >= 0) { e.preventDefault(); btns[cur].dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
  if (e.key === 'ArrowLeft' && MENUS.length > 1) { e.preventDefault(); closeMenus(MENUS.length - 1); return true; }
  return false;
}
document.addEventListener('mousedown', e => { if (MENUS.length && !e.target.closest('.cm')) closeMenus(); }, true);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

function playlistSub(ids) {
  const names = Object.keys(U.playlists), collabs = Collab.list;
  const has = n => { const s = new Set(U.playlists[n]); return ids.every(id => s.has(L.tracks[id].rel)); };
  const hasC = p => { const s = new Set(Collab.rels(p.id)); return ids.every(id => s.has(L.tracks[id].rel)); };
  return [
    names.length + collabs.length > 6 ? { find: 'Find a playlist' } : null,
    { label: 'New playlist', icon: 'plus', act: () => createPlaylistDlg(ids) },
    names.length || collabs.length ? { sep: true } : null,
    ...names.map(n => ({ label: n, icon: has(n) ? 'check' : 'blank', on: has(n), filterable: true, act: () => { if (has(n)) toast(`Already in ${n}`); else { addToPlaylist(n, ids); toast(`Added to ${n}`); } } })),
    ...collabs.map(p => ({ label: p.name, icon: hasC(p) ? 'check' : 'people', on: hasC(p), filterable: true, act: () => { if (hasC(p)) toast(`Already in ${p.name}`); else { Collab.add(p.id, ids); toast(`Added to ${p.name}`); } } })),
  ];
}
function dlItem(ids, name) {
  const s = Off.summary(ids), done = s.total && s.done === s.total;
  return { feat: 'offline', label: done ? 'Remove download' : s.busy ? 'Cancel download' : 'Download', icon: done ? 'dl-f' : 'dl', on: done, act: () => toggleCtxDownload(makeCtx('list', 'dl:' + name, name, ids)) };
}
function trackMenu(ids, o = {}) {
  ids = ids.filter(id => L.tracks[id]);
  if (!ids.length) return [];
  const t = ids.length === 1 ? L.tracks[ids[0]] : null;
  const allLiked = ids.every(id => U.likedSet.has(L.tracks[id].rel));
  const arts = t ? creditParts(t).filter(p => p.artist).map(p => p.artist) : [];
  return [
    ids.length > 1 ? { head: count(ids.length, 'song') + ' selected' } : null,
    { label: 'Add to playlist', icon: 'pl-add', sub: () => playlistSub(ids) },
    o.plName ? { label: 'Remove from this playlist', icon: 'minus-c', act: () => { removeFromPlaylist(o.plName, ids.map(id => L.tracks[id].rel)); toast(`Removed from ${o.plName}`, { action: 'Undo', onAction: () => addToPlaylist(o.plName, ids) }); } } : null,
    o.cplId ? { label: 'Remove from this playlist', icon: 'minus-c', act: () => { Collab.remove(o.cplId, ids.map(id => L.tracks[id].rel)); toast('Removed', { action: 'Undo', onAction: () => Collab.add(o.cplId, ids) }); } } : null,
    o.queueIndex != null ? { label: 'Remove from queue', icon: 'minus-c', act: () => queueRemove(o.queueIndex) } : null,
    { label: allLiked ? 'Remove from your Liked Songs' : 'Save to your Liked Songs', icon: allLiked ? 'heart-f' : 'heart', on: allLiked, act: () => t ? toggleLike(t) : setLikedMany(ids, !allLiked) },
    { label: 'Add to queue', icon: 'queue', act: () => addToQueue(ids) },
    { label: 'Play next', icon: 'next', act: () => addToQueue(ids, true) },
    dlItem(ids, t ? t.title : count(ids.length, 'song')),
    { sep: true },
    t ? { label: 'Go to song radio', icon: 'radio', act: () => go('mix', { id: 'radio:' + t.rel }) } : null,
    t && arts.length > 1 ? { label: 'Go to artist', icon: 'person', sub: arts.map(a => ({ label: a.name, icon: 'person', act: () => goArtist(a.id) })) } : null,
    t && arts.length <= 1 ? { label: 'Go to artist', icon: 'person', act: () => goArtist((arts[0] || artistOf(t)).id) } : null,
    t ? { label: 'Go to album', icon: 'album', act: () => goAlbum(t.albumId) } : null,
    t ? { label: 'Show credits', icon: 'note', act: () => creditsDialog(t) } : null,
    t ? { feat: 'sharing', label: 'Copy song link', icon: 'copy', act: () => share(t.title, `${t.title} by ${t.artist}`, trackLink(t)) } : null,
    t && chatOn() ? { label: 'Send to a friend', icon: 'send', act: () => sendToDialog(attachTrack(t)) } : null,
  ];
}
function itemMenu(k, id) {
  const ids = itemIds(k, id), ctx = itemCtx(k, id);
  const head = [ctx ? { label: 'Play', icon: 'play', act: () => playCtx(ctx, -1) } : null, ids.length ? { label: 'Add to queue', icon: 'queue', act: () => addToQueue(ids) } : null, ids.length ? { label: 'Add to playlist', icon: 'pl-add', sub: () => playlistSub(ids) } : null];
  if (k === 'album') {
    const al = L.albums[+id]; if (!al) return [];
    const saved = U.saved.includes(al.key);
    return [...head, { label: saved ? 'Remove from Your Library' : 'Add to Your Library', icon: saved ? 'check-c' : 'add', on: saved, act: () => toggleSaveAlbum(al) }, dlItem(ids, al.title), { sep: true },
      al.artistId >= 0 ? { label: 'Go to artist', icon: 'person', act: () => goArtist(al.artistId) } : null,
      { feat: 'sharing', label: 'Copy album link', icon: 'copy', act: () => share(al.title, `${al.title} by ${albumArtist(al)}`, albumLink(al)) },
      chatOn() ? { label: 'Send to a friend', icon: 'send', act: () => sendToDialog(attachAlbum(al)) } : null];
  }
  if (k === 'artist') {
    const ar = L.artists[+id]; if (!ar) return [];
    const f = U.follows.includes(ar.key);
    return [...head, { label: f ? 'Unfollow' : 'Follow', icon: f ? 'check-c' : 'person-add', on: f, act: () => toggleFollow(ar) }, { label: 'Go to artist radio', icon: 'radio', act: () => go('mix', { id: 'artist-radio:' + ar.key }) },
      { label: 'Discography', icon: 'album', act: () => go('discog', { key: ar.key }) }, { sep: true }, { feat: 'sharing', label: 'Copy artist link', icon: 'copy', act: () => share(ar.name, ar.name, artistLink(ar)) },
      chatOn() ? { label: 'Send to a friend', icon: 'send', act: () => sendToDialog(attachArtist(ar)) } : null];
  }
  if (k === 'playlist') return [...head, dlItem(ids, id), { sep: true }, { label: 'Edit details', icon: 'edit', act: () => renamePlaylistDlg(id) }, collabOn() ? { label: 'Invite collaborators', icon: 'person-add', act: () => inviteDialog({ personal: id }) } : null, { label: 'Delete', icon: 'trash', danger: true, act: () => deletePlaylistDlg(id) }];
  if (k === 'cpl') { const pl = Collab.get(id); return pl ? [...head, dlItem(ids, pl.name), { sep: true }, ...cplMenu(pl)] : []; }
  if (k === 'mix') { const m = getMix(id); return m ? [...head, { label: 'Save as playlist', icon: 'add', act: () => createPlaylistDlg(ids, m.name) }, dlItem(ids, m.name)] : []; }
  if (k === 'liked' || k === 'downloads') return [...head, k === 'liked' ? dlItem(ids, 'Liked Songs') : null];
  if (k === 'track') return trackMenu([+id]);
  return head;
}

function modal(o) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(o.title)}"><div class="modal-h"><h3>${esc(o.title)}</h3><button class="icon-btn" data-m="x" aria-label="Close">${ic('close')}</button></div>${o.body || ''}${o.ok === null ? '' : `<div class="btns">${o.cancel === null ? '' : `<button class="btn ghost" data-m="cancel">${esc(o.cancel || 'Cancel')}</button>`}<button class="btn ${o.danger ? 'danger' : 'light'}" data-m="ok">${esc(o.ok || 'OK')}</button></div>`}</div>`;
    document.body.appendChild(wrap);
    closeMenus(); hideTip();
    const done = v => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const okVal = () => (o.value ? o.value(wrap) : true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(null); });
    wrap.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; if (b.dataset.m === 'ok') { const v = okVal(); if (v !== undefined) done(v); } else done(null); });
    const key = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && o.ok !== null && !e.target.closest('textarea, button')) { e.preventDefault(); e.stopPropagation(); const v = okVal(); if (v !== undefined) done(v); }
    };
    document.addEventListener('keydown', key, true);
    if (o.init) o.init(wrap, done); else { const b = wrap.querySelector('[data-m="ok"]'); if (b) b.focus(); }
  });
}
const promptDlg = ({ title, value = '', ok = 'Save', label = 'Name', placeholder = '' }) => modal({
  title, ok, body: `<label class="lbl">${esc(label)}</label><input class="field" maxlength="80" value="${esc(value)}" placeholder="${esc(placeholder)}">`,
  init: w => { const i = w.querySelector('input'); i.focus(); i.select(); },
  value: w => w.querySelector('input').value.trim() || null,
});
const confirmDlg = ({ title, text, ok = 'OK', danger }) => modal({ title, ok, danger, body: text ? `<p>${esc(text)}</p>` : '' });
async function createPlaylistDlg(ids = [], suggested) {
  const name = await promptDlg({ title: 'Create playlist', value: suggested || `My Playlist #${Object.keys(U.playlists).length + 1}`, ok: 'Create' });
  if (!name) return;
  const err = plCreate(name, ids);
  if (err) { toast(err); return; }
  toast(ids.length ? `Added to ${name}` : `Created ${name}`);
  go('playlist', { name });
}
async function renamePlaylistDlg(name) {
  const nn = await promptDlg({ title: 'Edit details', value: name, ok: 'Save' });
  if (!nn || nn === name) return;
  const err = plRename(name, nn);
  if (err) { toast(err); return; }
  if (V.route.view === 'playlist' && V.route.params.name === name) go('playlist', { name: nn }, { replace: true });
}
async function deletePlaylistDlg(name) {
  if (!(await confirmDlg({ title: 'Delete from Your Library?', text: `This will delete ${name} from Your Library on all your devices.`, ok: 'Delete', danger: true }))) return;
  const here = V.route.view === 'playlist' && V.route.params.name === name;
  plDelete(name);
  toast(`Removed ${name} from Your Library`);
  if (here) go('home', {}, { replace: true });
}
function creditsDialog(t) {
  const al = albumOf(t), rows = [['Title', esc(t.title)], ['Artists', credits(t)], ['Album', `<a class="lnk" data-act="go" data-view="album" data-id="${al.id}" data-m="x">${esc(al.title)}</a> • ${esc(al.type)}`],
    ...(t.src ? [['Source', `Shared by ${esc(L.sources[t.src] || 'another server')}`]] : []),
    ['Track', t.no ? '#' + t.no : '—'], ['Your plays', nf(U.plays.get(t.rel) || 0)], ['Format', esc(fileExt(t.rel)) + (Off.set.has(t.rel) ? ' • downloaded to this device' : '')], ['File', `<span style="word-break:break-all">${esc(t.rel)}</span>`]];
  modal({ title: 'Credits', ok: 'Close', cancel: null, body: `<div class="kbd-grid" style="grid-template-columns:auto 1fr">${rows.map(([k, v]) => `<span class="muted">${k}</span><span>${v}</span>`).join('')}</div>` });
}
function shortcutsDialog() {
  const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const rows = [['Play / pause', 'Space'], ['Next song', `${mod} →`], ['Previous song', `${mod} ←`], ['Volume up / down', `${mod} ↑ / ↓`], ['Search', `${mod} K  or  /`], ['Like the current song', 'Alt Shift B'],
    ['Shuffle', 'Alt S'], ['Repeat', 'Alt R'], ['Queue', 'Alt Q'], ['Lyrics', 'Alt L'], ['Full screen', 'Alt F'], ['Visuals in full screen', 'Alt V'], ['New playlist', 'Alt N'], ['Select all songs in a list', `${mod} A`], ['Remove selected from playlist', 'Delete'], ['Go back / forward', 'Alt ← / →'], ['Show this list', '?']];
  modal({ title: 'Keyboard shortcuts', ok: 'Done', cancel: null, body: `<div class="kbd-grid">${rows.map(([a, b]) => `<span>${a}</span><span>${b.split('  or  ').map(k => k.split(' ').map(x => `<kbd>${esc(x)}</kbd>`).join('')).join(' or ')}</span>`).join('')}</div>` });
}
function editProfileDialog() {
  const photos = feat('avatars');
  let blob = null, removed = false, preview = '', busy = false, close = null;
  const face = w => {
    const box = w.querySelector('.ph-img');
    box.innerHTML = avatarHtml('xl');
    if (preview) box.querySelector('.avatar').innerHTML = `<img src="${preview}" alt="">`;
    else if (removed) box.querySelector('.avatar').textContent = box.querySelector('.avatar').dataset.i;
    const rm = w.querySelector('[data-ep="remove"]');
    if (rm) rm.hidden = !(preview || (U.avatar && !removed));
  };
  modal({ title: 'Profile details', ok: 'Save',
    body: `<div class="ep">${photos ? `<button type="button" class="ph-pick" data-ep="pick" aria-label="Choose photo"><span class="ph-img"></span><span class="ph-over">${ic('edit')}<span>Choose photo</span></span></button>` : '<span class="ph-img"></span>'}`
      + `<div class="ep-side"><label class="lbl" for="ep-name">Name</label><input class="field" id="ep-name" maxlength="32" value="${esc(U.name)}" autocomplete="nickname">`
      + (photos ? '<button type="button" class="ep-link" data-ep="remove">Remove photo</button>' : '') + '<div class="form-err" id="ep-err"></div></div></div>'
      + (photos ? '<p class="ep-note">Your photo and name are shown to people on this server.</p>' : ''),
    init: (w, done) => {
      close = done; face(w);
      w.querySelector('#ep-name').focus();
      w.addEventListener('click', async e => {
        const b = e.target.closest('[data-ep]'); if (!b || busy) return;
        const err = w.querySelector('#ep-err'); err.textContent = '';
        if (b.dataset.ep === 'remove') { blob = null; preview = ''; removed = true; face(w); return; }
        const file = await pickImage(); if (!file) return;
        try {
          blob = await squarePhoto(file);
          if (preview) URL.revokeObjectURL(preview);
          preview = URL.createObjectURL(blob); removed = false; face(w);
        } catch (ex) { err.textContent = ex.message; }
      });
    },
    value: w => {
      if (busy) return undefined;
      const name = w.querySelector('#ep-name').value.trim(), err = w.querySelector('#ep-err'), ok = w.querySelector('[data-m="ok"]');
      busy = true; ok.disabled = true; err.textContent = '';
      (async () => {
        try {
          if (blob) await uploadAvatar(blob);
          else if (removed && U.avatar) await removeAvatar();
          if (name !== U.name) await updateProfile(name);
          if (preview) URL.revokeObjectURL(preview);
          close(true); toast('Profile updated'); refreshAll(); renderMe();
        } catch (ex) { err.textContent = ex.message; busy = false; ok.disabled = false; }
      })();
      return undefined;
    } });
}
function sessionsDialog() {
  const rows = list => list.length ? list.map(x => `<div class="sess-row"><div class="meta"><div class="t">${esc(x.device || 'Device signed in earlier')}</div><div class="s">${x.created ? 'Signed in ' + new Date(x.created * 1000).toLocaleDateString() : 'Sign-in date unknown'}</div></div>${x.current ? '<span class="sess-this">This device</span>' : `<button class="btn ghost sm" data-sess="${esc(x.id)}">Sign out</button>`}</div>`).join('') : '<p>No other devices.</p>';
  modal({ title: 'Signed-in devices', ok: null, body: '<div class="sess-list"><p>Loading…</p></div><div class="btns"><button class="btn ghost" data-sess="others">Sign out everywhere else</button></div>',
    init: w => {
      const list = w.querySelector('.sess-list');
      const load = () => listSessions().then(l => { list.innerHTML = rows(l); }).catch(e => { list.innerHTML = `<p>${esc(e.message)}</p>`; });
      w.addEventListener('click', async e => {
        const b = e.target.closest('[data-sess]'); if (!b) return;
        b.disabled = true;
        try { const r = await revokeSession(b.dataset.sess); toast(r.removed ? `Signed out ${count(r.removed, 'device')}` : 'No other devices were signed in'); load(); }
        catch (ex) { toast(ex.message); b.disabled = false; }
      });
      load();
    } });
}
function subsonicDialog() {
  modal({ title: 'Use other apps', ok: null, body: '<div class="ss-box"><p>Loading…</p></div>',
    init: w => {
      const box = w.querySelector('.ss-box');
      const code = (label, v, copy = true) => `<label class="lbl">${label}</label><div class="ss-code"><code>${esc(v)}</code>${copy ? `<button class="btn ghost sm" data-copy="${esc(v)}">Copy</button>` : ''}</div>`;
      const draw = (d, fresh) => {
        box.innerHTML = `<p>Add a Subsonic server in apps like Symfonium (Android), Substreamer and play:Sub (iPhone), Feishin and Sonixd (computer), DSub, Tempo and more. Use these details:</p>`
          + code('Server address', d.server) + code('Username', d.username)
          + (fresh ? code('App password (shown only now)', fresh) + '<p class="ss-note">Save it in the app now. You can make a new one any time.</p>'
            : `<label class="lbl">App password</label><p class="ss-note">${d.has_password ? `Created ${new Date(d.created * 1000).toLocaleDateString()}. Make a new one if you lost it; the old one stops working.` : 'Create one below. Apps use it instead of your real password.'}</p>`)
          + `<div class="btns"><button class="btn ghost" data-ss="revoke"${d.has_password ? '' : ' hidden'}>Turn off app access</button><button class="btn light" data-ss="create">${d.has_password ? 'Make a new app password' : 'Create app password'}</button></div>`;
      };
      w.addEventListener('click', async e => {
        const c = e.target.closest('[data-copy]');
        if (c) { navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied'), () => toast("Couldn't copy")); return; }
        const b = e.target.closest('[data-ss]'); if (!b) return;
        b.disabled = true;
        try { const d = await subsonicPassword(b.dataset.ss); draw(d, d.password); if (b.dataset.ss === 'revoke') toast('App access turned off'); }
        catch (ex) { toast(ex.message); b.disabled = false; }
      });
      subsonicInfo().then(d => draw(d)).catch(e => { box.innerHTML = `<p>${esc(e.message)}</p>`; });
    } });
}
function scrobblingDialog() {
  modal({ title: 'Scrobbling', ok: null, body: '<div class="ss-box"><p>Loading…</p></div>',
    init: w => {
      const box = w.querySelector('.ss-box');
      const draw = d => {
        const lb = d.listenbrainz, lf = d.lastfm;
        box.innerHTML = '<p>Send the songs you play here to your listening history. A song counts after half of it (or 4 minutes) has played.</p>'
          + `<label class="lbl">ListenBrainz</label>` + (lb.connected
            ? `<div class="ss-code"><code>Connected as ${esc(lb.user || 'you')}</code><button class="btn ghost sm" data-sc="lb-off">Disconnect</button></div>`
            : `<div class="ss-code"><input class="field" id="lb-token" placeholder="Paste your user token" autocomplete="off" spellcheck="false" style="margin:0"><button class="btn light sm" data-sc="lb-on">Connect</button></div><p class="ss-note">Find it at listenbrainz.org → your profile → User token.</p>`)
          + `<label class="lbl">Last.fm</label>` + (lf.connected
            ? `<div class="ss-code"><code>Connected as ${esc(lf.user || 'you')}</code><button class="btn ghost sm" data-sc="lf-off">Disconnect</button></div>`
            : lf.available ? '<div class="ss-code"><code>Not connected</code><a class="btn light sm" href="/api/user/scrobbling/lastfm/connect">Connect</a></div>'
              : '<p class="ss-note">Last.fm isn\'t set up on this server yet (the admin needs to add a Last.fm API key).</p>')
          + (d.last_error ? `<p class="ss-note" style="color:var(--danger)">Last attempt failed: ${esc(d.last_error)}</p>` : d.last_ok ? `<p class="ss-note">Last scrobble ${new Date(d.last_ok * 1000).toLocaleString()}.</p>` : '');
      };
      w.addEventListener('click', async e => {
        const b = e.target.closest('[data-sc]'); if (!b) return;
        b.disabled = true;
        try {
          const a = b.dataset.sc;
          const d = a === 'lb-on' ? await connectListenBrainz(w.querySelector('#lb-token').value.trim())
            : await disconnectScrobbler(a === 'lb-off' ? 'listenbrainz' : 'lastfm');
          draw(d); toast(a === 'lb-on' ? 'ListenBrainz connected' : 'Disconnected');
        } catch (ex) { toast(ex.message); b.disabled = false; }
      });
      scrobbleInfo().then(draw).catch(e => { box.innerHTML = `<p>${esc(e.message)}</p>`; });
    } });
}
function deleteAccountDialog() {
  modal({ title: 'Delete your account?', ok: 'Delete account', danger: true,
    body: `<p>Your likes, playlists and listening history are deleted from ${esc(SITE.site_title || 'this server')} for good. Downloads on this device stay until you remove them.</p><label class="lbl">Password</label><input class="field" id="da-pw" type="password" autocomplete="current-password"><div class="form-err" id="da-err" role="alert"></div>`,
    init: w => w.querySelector('#da-pw').focus(),
    value: w => {
      const pw = w.querySelector('#da-pw').value, err = w.querySelector('#da-err');
      if (!pw) { err.textContent = 'Enter your password to confirm.'; return undefined; }
      deleteAccount(pw).then(() => { toast('Your account was deleted'); refreshAll(); renderMe(); }).catch(e => toast(e.message));
      return true;
    } });
}
function changePasswordDialog() {
  const fresh = !U.passwordLogin;
  modal({ title: fresh ? 'Set a password' : 'Change password', ok: fresh ? 'Set password' : 'Update password', body: `${fresh ? '<p>Then you can sign in with your username and password as well as with Discord.</p>' : '<label class="lbl">Current password</label><input class="field" id="cp-old" type="password" autocomplete="current-password">'}<label class="lbl">New password</label><input class="field" id="cp-new" type="password" autocomplete="new-password"><label class="lbl">Confirm new password</label><input class="field" id="cp-new2" type="password" autocomplete="new-password"><div class="form-err" id="cp-err"></div>`,
    init: w => (w.querySelector('#cp-old') || w.querySelector('#cp-new')).focus(),
    value: w => {
      const g = s => (w.querySelector(s) || {}).value || '', err = w.querySelector('#cp-err');
      if (g('#cp-new').length < minPassword()) { err.textContent = `Use at least ${minPassword()} characters.`; return undefined; }
      if (g('#cp-new') !== g('#cp-new2')) { err.textContent = "The new passwords don't match."; return undefined; }
      changePassword(g('#cp-old'), g('#cp-new')).then(() => { U.passwordLogin = true; toast(fresh ? 'Password set' : 'Password updated'); if (V.route.view === 'settings') render(view.scrollTop); }).catch(e => toast(e.message));
      return true;
    } });
}

let toastT = 0;
function toast(msg, o = {}) {
  const host = byId('toast');
  host.innerHTML = `<div class="tst" role="status"><span>${esc(msg)}</span>${o.action ? `<button type="button">${esc(o.action)}</button>` : ''}</div>`;
  const el = host.firstChild;
  const hide = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  if (o.action) el.querySelector('button').addEventListener('click', () => { hide(); o.onAction(); });
  clearTimeout(toastT);
  toastT = setTimeout(hide, o.ms || (o.action ? 4500 : 2800));
}
let tipT = 0, tipEl = null;
function showTip(t) {
  hideTip();
  const text = t.dataset.tip; if (!text || !document.body.contains(t)) return;
  tipEl = document.createElement('div'); tipEl.className = 'hover-tip'; tipEl.textContent = text;
  document.body.appendChild(tipEl);
  const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let top = r.top - h - 8; if (top < 4) top = r.bottom + 8;
  tipEl.style.left = clamp(r.left + r.width / 2 - w / 2, 4, innerWidth - w - 4) + 'px';
  tipEl.style.top = top + 'px';
}
function hideTip() { clearTimeout(tipT); if (tipEl) { tipEl.remove(); tipEl = null; } }
document.addEventListener('mouseover', e => { const t = e.target.closest('[data-tip]'); if (!t || t.contains(e.relatedTarget)) return; clearTimeout(tipT); tipT = setTimeout(() => showTip(t), 450); });
document.addEventListener('mouseout', e => { const t = e.target.closest('[data-tip]'); if (t && !t.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('mousedown', hideTip, true);

// Drag songs (or whole albums/playlists) onto a playlist, Liked Songs, the queue, or within a playlist.
const DRAG = { ids: null, from: null };
document.addEventListener('dragstart', e => {
  const row = e.target.closest && e.target.closest('.tr[data-t]');
  const item = !row && e.target.closest && e.target.closest('[draggable][data-k]');
  let ids = [];
  if (row) {
    const tt = row.closest('.tt'), i = +row.dataset.i;
    if (!(SEL.tt === tt && SEL.set.has(i))) SEL.only(tt, i);
    ids = SEL.ids();
    DRAG.from = tt.dataset.pl || tt.dataset.cpl ? { pl: tt.dataset.pl, cpl: tt.dataset.cpl, tt, idx: [...SEL.set].sort((a, b) => a - b) } : null;
    $$('.tr.sel').forEach(r => r.classList.add('dragging-src'));
  } else if (item) { ids = itemIds(item.dataset.k, item.dataset.id); DRAG.from = null; }
  else return;
  if (!ids.length) { e.preventDefault(); return; }
  DRAG.ids = ids;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', ids.slice(0, 50).map(id => `${L.tracks[id].title} — ${L.tracks[id].artist}`).join('\n'));
  const ghost = byId('drag-ghost');
  ghost.textContent = ids.length === 1 ? L.tracks[ids[0]].title : count(ids.length, 'song');
  e.dataTransfer.setDragImage(ghost, -12, -8);
  hideTip();
});
document.addEventListener('dragend', () => { DRAG.ids = null; DRAG.from = null; clearDropMarks(); $$('.dragging-src').forEach(n => n.classList.remove('dragging-src')); });
const clearDropMarks = () => $$('.drop, .drop-above, .drop-below, .rp-drop').forEach(n => n.classList.remove('drop', 'drop-above', 'drop-below', 'rp-drop'));
function dropTarget(target, y) {
  const li = target.closest('.li[data-k], .card[data-k]');
  if (li && ['playlist', 'cpl', 'liked', 'downloads'].includes(li.dataset.k)) return { kind: li.dataset.k, el: li, name: li.dataset.id };
  if (target.closest('#right') && RP.mode === 'queue') return { kind: 'queue', el: byId('rp-body') };
  const row = target.closest('.tr'), tt = row && row.closest('.tt[data-pl], .tt[data-cpl]');
  if (tt && DRAG.from && DRAG.from.tt === tt) { const r = row.getBoundingClientRect(); return { kind: 'reorder', el: row, after: y > r.top + r.height / 2, tt }; }
  return null;
}
document.addEventListener('dragover', e => {
  if (!DRAG.ids) return;
  const t = dropTarget(e.target, e.clientY);
  clearDropMarks();
  if (!t || !t.el) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = t.kind === 'reorder' ? 'move' : 'copy';
  t.el.classList.add(t.kind === 'reorder' ? (t.after ? 'drop-below' : 'drop-above') : t.kind === 'queue' ? 'rp-drop' : 'drop');
});
document.addEventListener('drop', e => {
  if (!DRAG.ids) return;
  const t = dropTarget(e.target, e.clientY), ids = DRAG.ids;
  clearDropMarks();
  if (!t) return;
  e.preventDefault();
  if (t.kind === 'playlist') { const n = addToPlaylist(t.name, ids); toast(n ? `Added ${n === 1 ? '1 song' : count(n, 'song')} to ${t.name}` : `Already in ${t.name}`); }
  else if (t.kind === 'cpl') { const pl = Collab.get(t.name), n = Collab.add(t.name, ids); toast(n ? `Added ${n === 1 ? '1 song' : count(n, 'song')} to ${pl ? pl.name : 'the playlist'}` : 'Already there'); }
  else if (t.kind === 'liked') setLikedMany(ids, true);
  else if (t.kind === 'downloads') { const n = Off.enqueue(ids.map(id => L.tracks[id].rel)); toast(n ? `Downloading ${count(n, 'song')}` : 'Already downloaded'); }
  else if (t.kind === 'queue') addToQueue(ids);
  else if (t.kind === 'reorder') {
    const ctx = CTX.get(t.tt.dataset.ctx), name = DRAG.from.pl, moving = DRAG.from.idx, target = +t.el.dataset.i + (t.after ? 1 : 0);
    const rest = ctx.ids.map((_, i) => i).filter(i => !moving.includes(i));
    const at = rest.filter(i => i < target).length;
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (DRAG.from.cpl) {
      // Collaborative: one move per song, each placed before whatever follows it in the new order.
      const newIds = order.map(i => ctx.ids[i]);
      moving.slice().reverse().forEach(i => { const id = ctx.ids[i], next = newIds[newIds.indexOf(id) + 1]; Collab.place(DRAG.from.cpl, L.tracks[id].rel, next != null ? L.tracks[next].rel : null); });
      return;
    }
    const rels = U.playlists[name] || [];
    U.playlists[name] = order.map(i => L.tracks[ctx.ids[i]].rel).concat(rels.filter(r => !L.byRel.has(r)));
    window.AX.pushLibrary();
    render(view.scrollTop);
  }
});

/* ======================================================================
   7b. Friends, activity, collaborative playlists & private messages
       (data, polling and encryption live in web/app/social.js)
   ====================================================================== */
const { Social, Chat, E2EE, REACTIONS, attachment, attachTrack, attachAlbum, attachArtist, personAvatar, ago, agoText, previewText, Collab, itCollab } = window.AX;
const socialOn = () => !!U.token && feat('social');
const chatOn = () => socialOn() && feat('chat');
const collabOn = () => socialOn() && feat('collab');
const cardOf = name => Social.cards.get(name) || { username: name, display_name: name, avatar: '' };
const firstName = s => String(s || '').split(' ')[0];

function renderSocialButtons() {
  const f = byId('btn-friends'), m = byId('btn-msgs');
  if (f) {
    f.hidden = !socialOn();
    f.classList.toggle('on', RP.mode === 'friends');
    const n = (Social.me.incoming || []).length;
    f.querySelector('.badge').textContent = n || '';
  }
  if (m) {
    m.hidden = !chatOn();
    m.classList.toggle('on', !!V.route && V.route.view === 'messages');
    const n = Chat.ready ? Chat.unreadTotal() : (Social.pulse && Social.pulse.unread) || 0;
    m.querySelector('.badge').textContent = n > 99 ? '99+' : n || '';
  }
}
const lastUnread = new Map();
function notifyNewMessages() {
  for (const c of Chat.list) {
    const was = lastUnread.get(c.id) || 0;
    if (c.unread > was && c.preview && !c.preview.mine && !(V.route.view === 'messages' && V.route.params.c === c.id && !document.hidden)) {
      const who = Chat.title(c), text = previewText(c);
      if (document.hidden && S.notify && window.Notification && Notification.permission === 'granted') {
        try { new Notification(who, { body: text, tag: 'axdio-chat-' + c.id, silent: false }); } catch (e) { /* not allowed here */ }
      } else if (!document.hidden) toast(`${who}: ${text}`, { action: 'Reply', onAction: () => go('messages', { c: c.id }) });
    }
    lastUnread.set(c.id, c.unread || 0);
  }
}
function onSocial(what, data) {
  const v = V.route && V.route.view;
  if (what === 'pulse' || what === 'friends') renderSocialButtons();
  if (what === 'friends') { if (RP.mode === 'friends') renderPanel(); if (v === 'friends' || v === 'user') render(view.scrollTop); }
  if (what === 'activity' && RP.mode === 'friends') renderPanel();
  if (what === 'chats') {
    const first = !Chat.seenOnce; Chat.seenOnce = true;
    if (first) Chat.list.forEach(c => lastUnread.set(c.id, c.unread || 0)); else notifyNewMessages();
    renderSocialButtons();
    if (v === 'messages') { drawChatList(); updateThread(); }
  }
  if (what === 'thread' && v === 'messages' && V.route.params.c === data) updateThread();
  if (what === 'e2ee' && (v === 'messages' || v === 'settings')) render(view.scrollTop);
  if (what === 'link-request') linkRequestDialog(data);
}

/* --- Friend Activity (right panel) --- */
function songLine(now) {
  if (!now) return '';
  const t = L.byRel.get(now.rel), title = t ? t.title : now.title, artist = t ? t.artist : now.artist, album = t ? albumOf(t).title : now.album;
  return `<div class="fa-song"><a class="lnk" data-act="fa-play" data-rel="${esc(now.rel)}">${esc(title)}</a><span class="dot"></span><span class="ell">${esc(artist)}</span></div>`
    + (album ? `<div class="fa-ctx">${ic('album', 'sm')}<span class="ell">${esc(album)}</span></div>` : '');
}
function renderFriendsPanel(rp) {
  Social.activityOpen = true;
  if (!Social.activityAt || now() - Social.activityAt > 20000) Social.loadActivity();
  const reqs = Social.me.incoming || [], friends = Social.friends();
  let h = `<div class="rp-h"><b>Friend Activity</b><button class="icon-btn" data-act="go" data-view="friends" data-tip="Find friends">${ic('person-add', 'md')}</button><button class="icon-btn" data-act="close-panel" data-tip="Close">${ic('close', 'md')}</button></div><div class="rp-body fa">`;
  if (reqs.length) h += `<div class="q-sec"><span>Friend requests</span></div>` + reqs.map(c => `<div class="fa-row req">${personAvatar(c, 'fa-av')}<div class="flex1" data-act="open-user" data-u="${esc(c.username)}"><b class="ell">${esc(c.display_name)}</b><div class="fa-ctx ell">@${esc(c.username)}</div></div><button class="btn light sm" data-act="friend-act" data-a="accept" data-u="${esc(c.username)}">Accept</button><button class="icon-btn" data-act="friend-act" data-a="decline" data-u="${esc(c.username)}" data-tip="Decline">${ic('close', 'sm')}</button></div>`).join('');
  if (!friends.length) {
    h += `<div class="fa-empty">${ic('people')}<b>See what your friends are playing</b><p>Add friends on ${esc(SITE.site_title || 'Axdio')} and their listening shows up here.</p><button class="btn light sm" data-act="go" data-view="friends">Find friends</button></div>`;
  } else {
    const act = new Map(Social.activity.map(a => [a.username, a]));
    const list = Social.activity.length ? Social.activity : friends.map(f => Object.assign({ now: null }, f));
    h += list.map(a => {
      const n = (act.get(a.username) || a).now, live = n && n.live;
      const pty = (act.get(a.username) || a).party;
      return `<div class="fa-row"><div class="fa-av-wrap" data-act="open-user" data-u="${esc(a.username)}">${personAvatar(a, 'fa-av')}${live ? '<span class="live-dot"></span>' : ''}</div><div class="flex1"><div class="fa-top"><b class="ell lnk" data-act="open-user" data-u="${esc(a.username)}">${esc(a.display_name)}</b><span class="fa-t">${live ? `<span class="fa-eq">${EQB}</span>` : n ? ago(n.t * 1000) : ''}</span></div>${n ? songLine(n) : `<div class="fa-ctx">${a.sharing === false ? 'Not sharing what they play' : 'Nothing played yet'}</div>`}${pty ? `<button class="fa-party" data-act="party-join" data-id="${esc(pty.id)}">${ic('party', 'sm')}<span class="ell">In ${esc(pty.name)} · Join</span></button>` : ''}</div></div>`;
    }).join('');
  }
  const share = Social.me.settings && Social.me.settings.share_activity !== false;
  h += `<p class="list-foot">Friends ${share ? 'can' : "can't"} see what you play. <a class="lnk" data-act="go" data-view="settings">Change</a></p></div>`;
  rp.innerHTML = h;
}

/* --- Friends page --- */
const FR = { tab: 'friends', q: '', results: null, seq: 0 };
function personRow(c, buttons, sub) {
  return `<div class="pr-row">${personAvatar(c, 'pr-av')}<div class="flex1" data-act="open-user" data-u="${esc(c.username)}"><div class="t ell">${esc(c.display_name)}</div><div class="s ell">${sub || '@' + esc(c.username)}</div></div><div class="pr-btns">${buttons}</div></div>`;
}
function stateButtons(c, state) {
  const u = esc(c.username), btn = (a, label, cls = 'ghost') => `<button class="btn ${cls} sm" data-act="friend-act" data-a="${a}" data-u="${u}">${label}</button>`;
  if (state === 'friend') return (chatOn() ? `<button class="btn ghost sm" data-act="dm" data-u="${u}">${ic('chat', 'sm')}Message</button>` : '') + `<button class="icon-btn" data-act="friend-more" data-u="${u}" data-tip="More">${ic('more-h')}</button>`;
  if (state === 'incoming') return btn('accept', 'Accept', 'light') + btn('decline', 'Decline');
  if (state === 'outgoing') return btn('cancel', 'Requested');
  if (state === 'blocked') return btn('unblock', 'Unblock');
  return btn('request', `${ic('person-add', 'sm')}Add friend`, 'light');
}
VIEWS.friends = (el, p) => {
  if (!U.token) { el.innerHTML = `<div class="content" style="padding-top:88px">${emptyHtml('people', 'Friends', 'Log in to add friends, see what they play and send them messages.')}<p style="text-align:center"><button class="btn primary" data-act="go" data-view="profile">Log in</button></p></div>`; return; }
  if (!socialOn()) { VIEWS.missing(el); return; }
  if (p.tab) FR.tab = p.tab;
  const inc = Social.me.incoming || [], out = Social.me.outgoing || [], friends = Social.friends();
  const tabs = [['friends', `Friends${friends.length ? ' · ' + friends.length : ''}`], ['requests', `Requests${inc.length ? ' · ' + inc.length : ''}`], ['find', 'Find people']];
  let h = `<div class="content set"><h1 class="page-title">Friends</h1><div class="chips">${tabs.map(([k, l]) => `<button class="chip${FR.tab === k ? ' on' : ''}" data-act="fr-tab" data-t="${k}">${l}</button>`).join('')}</div><div class="pr-list">`;
  if (FR.tab === 'friends') {
    const act = new Map(Social.activity.map(a => [a.username, a.now]));
    h += friends.length ? friends.map(c => { const n = act.get(c.username); const t = n && L.byRel.get(n.rel); return personRow(c, stateButtons(c, 'friend'), n ? `${n.live ? 'Listening to' : 'Played'} ${esc(t ? t.title : n.title)}` : ''); }).join('')
      : `<div class="fa-empty">${ic('people')}<b>No friends yet</b><p>Find people on this server by their name or username.</p><button class="btn light sm" data-act="fr-tab" data-t="find">Find people</button></div>`;
  } else if (FR.tab === 'requests') {
    h += inc.length ? `<div class="set-sec">Waiting for you</div>` + inc.map(c => personRow(c, stateButtons(c, 'incoming'))).join('') : '';
    h += out.length ? `<div class="set-sec">Sent</div>` + out.map(c => personRow(c, stateButtons(c, 'outgoing'))).join('') : '';
    if (!inc.length && !out.length) h += `<p class="muted" style="padding:24px 0">No requests right now.</p>`;
  } else {
    h += `<label class="filter-box" style="width:min(460px,100%);height:44px;margin:4px 0 16px">${ic('search')}<input id="fr-q" placeholder="Search by name or username" autocomplete="off" value="${esc(FR.q)}" style="width:100%"></label><div id="fr-res"></div>`;
  }
  el.innerHTML = h + '</div></div>';
  const q = el.querySelector('#fr-q');
  if (q) {
    const draw = async () => {
      const box = el.querySelector('#fr-res'), s = ++FR.seq; FR.q = q.value.trim();
      if (FR.q.length < 2) { box.innerHTML = `<p class="muted">Type at least two letters.</p>`; return; }
      const users = await Social.search(FR.q).catch(() => []);
      if (s !== FR.seq) return;
      box.innerHTML = users.length ? users.map(c => personRow(c, stateButtons(c, c.state))).join('') : `<p class="muted">No one found. People can hide from search in their settings; you can still add them by their exact username.</p>`;
    };
    q.addEventListener('input', debounce(draw, 250));
    draw(); q.focus();
  }
};

/* --- Someone's profile --- */
VIEWS.user = (el, p) => {
  const u = String(p.u || '').toLowerCase();
  if (!socialOn() || !u) { VIEWS.missing(el); return; }
  if (u === U.username) { go('profile', {}, { replace: true }); return; }
  el.innerHTML = loading();
  const route = V.route;
  Social.profile(u).then(pr => {
    if (V.route !== route) return;
    const state = pr.state;
    const tops = (pr.top_artists || []).map(n => L.artistByKey.get(String(n).toLowerCase())).filter(a => a && a.trackIds.length);
    const recent = uniq((pr.recent || []).map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id)).slice(0, 10);
    let h = `<div class="vbg"></div><div class="prof-hero">${personAvatar(pr, 'lg')}<div class="flex1"><div class="hero-kind">Profile</div><h1>${esc(pr.display_name)}</h1><div class="hero-line"><span class="muted">@${esc(pr.username)}</span><span class="dot"></span><span>${count(pr.friends || 0, 'friend')}</span>${pr.mutual ? `<span class="dot"></span><span>${count(pr.mutual, 'mutual friend')}</span>` : ''}</div></div></div>`;
    h += `<div class="actions">${state === 'friend' ? '' : stateButtons(pr, state)}${state === 'friend' ? `<button class="pill-btn on" data-act="friend-more" data-u="${esc(pr.username)}">Friends ${ic('down', 'sm')}</button>${chatOn() ? `<button class="pill-btn" data-act="dm" data-u="${esc(pr.username)}">${ic('chat', 'sm')} Message</button>` : ''}` : ''}</div><div class="content">`;
    if (pr.now) {
      const t = L.byRel.get(pr.now.rel);
      if (t) h += `<section class="sec"><div class="sec-h"><h2>${pr.now.live ? 'Listening now' : 'Last played'}</h2></div><div class="now-card" data-act="fa-play" data-rel="${esc(t.rel)}">${img(coverUrl(t.rel))}<div class="flex1"><b>${esc(t.title)}</b><span>${esc(t.artist)} • ${esc(albumOf(t).title)}</span></div>${pr.now.live ? `<span class="fa-eq">${EQB}</span>` : `<span class="muted">${agoText(pr.now.t * 1000)}</span>`}<button class="big-play" style="width:44px;height:44px" aria-label="Play">${ic('play')}</button></div></section>`;
    }
    if (window.AX.ChatMedia) h += window.AX.ChatMedia.blendHtml(pr);
    if (tops.length) h += shelf('Top artists', tops.map(itArtist), { kicker: 'From their listening' });
    if (recent.length) { const ctx = vctx('list', 'user:' + u, `${pr.display_name}'s recent songs`, recent); h += `<section class="sec"><div class="sec-h"><h2>Recently played</h2></div>${tableShell(ctx, { noHead: true })}</section>`; }
    const shared = (pr.playlists || []).map(x => Collab.get(x.id)).filter(Boolean);
    if (shared.length) h += shelf('Playlists you make together', shared.map(itCollab));
    if (state !== 'friend' && !pr.now) h += `<p class="muted" style="padding:24px 0">${state === 'none' ? `Add ${esc(firstName(pr.display_name))} as a friend to see what they listen to.` : state === 'outgoing' ? 'Your friend request is waiting.' : ''}</p>`;
    el.innerHTML = h + '</div>';
    fillTables(el);
    if (tops[0]) paint(tops[0].cover); else if (pr.avatar && S.dynColor) dominant(pr.avatar).then(c => { if (c && V.route === route) view.style.setProperty('--c', tone(c, .32, .25)); });
    measure();
  }).catch(e => { if (V.route === route) el.innerHTML = `<div class="content" style="padding-top:100px">${emptyHtml('person', "Couldn't open this profile", e.message)}</div>`; });
};
function friendMenu(u) {
  const c = cardOf(u);
  return [{ head: c.display_name }, { label: 'View profile', icon: 'person', act: () => go('user', { u }) },
    chatOn() ? { label: 'Message', icon: 'chat', act: () => openDM(u) } : null,
    chatOn() && E2EE.state === 'ready' ? { label: 'Verify security code', icon: 'shield', act: () => safetyDialog(u) } : null,
    { sep: true }, { label: 'Remove friend', icon: 'minus-c', act: async () => { if (await confirmDlg({ title: `Remove ${c.display_name}?`, text: "You'll stop seeing each other's activity. Your chats and shared playlists stay.", ok: 'Remove' })) friendAct('remove', u); } },
    { label: 'Block', icon: 'block', danger: true, act: async () => { if (await confirmDlg({ title: `Block ${c.display_name}?`, text: "They won't be able to find you, add you or message you, and you'll leave each other's collaborative playlists.", ok: 'Block', danger: true })) friendAct('block', u); } }];
}
async function friendAct(a, u) {
  try {
    const st = await Social.act(a, u);
    toast({ request: st === 'friend' ? "You're now friends" : 'Friend request sent', accept: "You're now friends", decline: 'Request declined', cancel: 'Request cancelled', remove: 'Friend removed', block: 'Blocked', unblock: 'Unblocked' }[a]);
    if (FR.tab === 'find' && V.route.view === 'friends') render(view.scrollTop);
  } catch (e) { toast(e.message); }
}
async function openDM(u) {
  try { const c = await Chat.dm(u); go('messages', { c: c.id }); } catch (e) { toast(e.message); }
}

/* --- Private messages --- */
const groupAvatar = c => { const o = Chat.others(c).slice(0, 2); return `<span class="gav">${o.map(m => personAvatar(Chat.card(c, m))).join('') || personAvatar({ display_name: '?' })}</span>`; };
const convAvatar = (c, cls = '') => c.kind === 'dm' ? personAvatar(Chat.card(c, Chat.peer(c)), cls) : `<span class="${cls}">${groupAvatar(c)}</span>`;
function e2eeGate(st) {
  const site = esc(SITE.site_title || 'Axdio');
  if (st === 'unsupported') return `<div class="gate">${ic('lock')}<h1>Private messages need HTTPS</h1><p>Encryption only works on a secure connection. Open ${site} at its https:// address, or ask the server admin to set up HTTPS.</p></div>`;
  if (st === 'none') return `<div class="gate">${ic('lock')}<h1>Private messages</h1><p>Chat with friends and send each other music. Messages are end-to-end encrypted: they're locked on your device and can only be unlocked on the devices of the people in the conversation. The server and its admins only ever see scrambled data.</p>
    <ul><li>${ic('key', 'sm')}Your keys are made on this device and never leave it unprotected.</li><li>${ic('shield', 'sm')}Check a security code with a friend to be sure nobody is in between.</li><li>${ic('devices', 'sm')}Use your recovery key, or approve new devices from this one.</li></ul>
    <button class="btn primary" data-act="e2ee-setup">Turn on private messages</button></div>`;
  if (st === 'locked') return `<div class="gate">${ic('lock')}<h1>Unlock your messages</h1><p>Private messages are set up on another of your devices. Bring your keys to this one to read and send messages here.</p>
    <div class="gate-opts"><button class="gate-opt" data-act="e2ee-link">${ic('devices')}<b>Approve from another device</b><span>Open ${site} on a device where your messages work and confirm a code.</span></button><button class="gate-opt" data-act="e2ee-unlock">${ic('key')}<b>Use your recovery key</b><span>The 32-character key you saved when you turned on private messages.</span></button></div>
    <button class="lnk muted gate-reset" data-act="e2ee-reset">Lost your recovery key and other devices? Start over</button></div>`;
  return `<div class="gate">${ic('lock')}<h1>Loading messages…</h1></div>`;
}
VIEWS.messages = (el, p) => {
  if (!U.token) { el.innerHTML = `<div class="content" style="padding-top:88px">${emptyHtml('chat', 'Messages', 'Log in to message your friends.')}<p style="text-align:center"><button class="btn primary" data-act="go" data-view="profile">Log in</button></p></div>`; return; }
  if (!chatOn()) { VIEWS.missing(el); return; }
  view.classList.add('fixed');
  V.cleanup.push(() => { view.classList.remove('fixed'); Chat.open = ''; THREAD.cid = ''; });
  if (E2EE.state !== 'ready') { el.innerHTML = e2eeGate(E2EE.state); if (E2EE.state === 'off') E2EE.init(); return; }
  el.innerHTML = `<div class="msg-view"><aside class="msg-list"><div class="ml-h"><h1>Messages</h1><button class="icon-btn" data-act="new-chat" data-tip="New message" aria-label="New message">${ic('edit', 'md')}</button></div><div class="ml-body" id="ml-body"></div></aside><section class="msg-thread" id="msg-thread"></section></div>`;
  if (!Chat.ready) Chat.refresh();
  drawChatList();
  THREAD.cid = null;
  updateThread();
};
function drawChatList() {
  const box = byId('ml-body'); if (!box) return;
  box.closest('.msg-view').classList.toggle('none', Chat.ready && !Chat.list.length);
  const cur = V.route.params.c;
  if (!Chat.ready) { box.innerHTML = '<div class="ml-row"><div class="sk" style="width:48px;height:48px;border-radius:50%"></div><div class="flex1"><div class="sk" style="height:14px;width:60%"></div></div></div>'.repeat(4); return; }
  box.innerHTML = Chat.list.length ? Chat.list.map(c => `<div class="ml-row${c.id === cur ? ' on' : ''}${c.unread ? ' unread' : ''}" data-act="open-chat" data-c="${c.id}">${convAvatar(c, 'ml-av')}<div class="flex1"><div class="ml-top"><b class="ell">${esc(Chat.title(c))}</b><span class="ml-t">${c.preview ? ago(c.preview.ts) : ''}</span></div><div class="ml-sub"><span class="ell">${esc(previewText(c))}</span>${c.unread ? `<span class="ml-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div></div></div>`).join('')
    : `<div class="fa-empty">${ic('chat')}<b>No messages yet</b><p>Start a conversation with a friend, or make a group.</p><button class="btn light sm" data-act="new-chat">New message</button></div>`;
}
const THREAD = { cid: null, stick: true };
const dayLabel = ms => { const d = new Date(ms), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1); return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' }); };
const timeLabel = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const linkify = s => s.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
function attCard(a) {
  if (a.k === 'missing') return `<div class="att missing">${ic('note')}<div class="att-meta"><b class="ell">${esc(a.title || 'Something')}</b><span>${esc(a.sub || '')} • not in this library</span></div></div>`;
  const cover = a.k === 'track' ? img(coverUrl(a.t.rel)) : a.k === 'album' ? img(coverUrl(a.al.cover)) : a.k === 'artist' ? img(coverUrl(a.ar.cover)) : plCover(Collab.rels(a.id));
  return `<div class="att${a.k === 'artist' ? ' round' : ''}" data-act="att-open" data-k="${a.k}" data-id="${esc(a.id)}"><div class="att-art">${cover}</div><div class="att-meta"><b class="ell">${esc(a.title)}</b><span class="ell">${esc(a.sub)}</span></div><button class="att-play" data-act="att-play" data-k="${a.k}" data-id="${esc(a.id)}" aria-label="Play">${ic('play')}</button></div>`;
}
function reactChips(r) {
  if (!r || !r.size) return '';
  const by = new Map();
  r.forEach((e, u) => { if (!by.has(e)) by.set(e, []); by.get(e).push(u); });
  return `<div class="reacts">${[...by].map(([e, us]) => `<span class="rc${us.includes(U.username) ? ' me' : ''}" data-tip="${esc(us.map(u => u === U.username ? 'You' : cardOf(u).display_name).join(', '))}">${e}${us.length > 1 ? `<small>${us.length}</small>` : ''}</span>`).join('')}</div>`;
}
function msgHtml(c, th, m, grouped) {
  const who = Chat.card(c, m.from);
  let inner;
  if (m.deleted) inner = `<div class="bub gone">${m.mine ? 'You unsent a message' : 'Message unsent'}</div>`;
  else if (m.err === 'keys') inner = `<div class="bub gone">${ic('lock', 'sm')} Sent before this device had the right keys</div>`;
  else if (m.err) inner = `<div class="bub gone">${ic('lock', 'sm')} This message can't be decrypted</div>`;
  else {
    const a = attachment(m.body.a), CM = window.AX.ChatMedia;
    inner = (m.body.f && CM ? CM.html(c.id, m) : '') + (a ? attCard(a) : '') + (m.body.t ? `<div class="bub">${linkify(esc(m.body.t))}</div>` : '');
  }
  const tools = m.deleted || m.err ? '' : `<div class="msg-tools"><button data-act="react-menu" data-m="${m.id}" data-tip="React">${ic('smile', 'sm')}</button>${m.mine ? `<button data-act="unsend" data-m="${m.id}" data-tip="Unsend">${ic('trash', 'sm')}</button>` : ''}</div>`;
  return `<div class="msg${m.mine ? ' mine' : ''}${grouped ? ' grouped' : ''}" data-m="${m.id}">${m.mine ? '' : grouped ? '<span class="mt-av"></span>' : personAvatar(who, 'mt-av')}<div class="msg-col">${!m.mine && !grouped && c.kind === 'group' ? `<div class="msg-who">${esc(who.display_name)}</div>` : ''}<div class="msg-line">${m.mine ? tools : ''}<div class="msg-body">${inner}</div>${m.mine ? '' : tools}</div>${reactChips(th.reacts.get(m.id))}${m.trust === 'unknown' && !m.err ? '<span class="unv" data-tip="Signed with a key this device has never seen, so it can\'t confirm who sent it">Unverified sender</span>' : ''}</div><span class="msg-time">${timeLabel(m.ts)}</span></div>`;
}
function msgsHtml(c, th) {
  if (!th.loaded) return '<div class="mt-loading"><span class="spin-sm"></span></div>';
  let h = th.more ? `<div class="mt-older"><button class="btn ghost sm" data-act="chat-older">Load earlier messages</button></div>` : `<div class="mt-start">${convAvatar(c, 'mt-start-av')}<h2>${esc(Chat.title(c))}</h2><p>${ic('lock', 'sm')} Messages here are end-to-end encrypted. Only ${c.kind === 'dm' ? 'the two of you' : 'the people in this group'} can read them.</p></div>`;
  let prevFrom = '', prevTs = 0, prevDay = '', lostRun = 0;
  const flush = () => { if (lostRun) { h += `<div class="mt-note">${ic('lock', 'sm')} ${count(lostRun, 'earlier message')} can't be read on this device</div>`; lostRun = 0; } };
  for (const m of th.msgs) {
    if (m.expires && m.expires <= Date.now()) continue;
    if (m.err === 'keys') { lostRun++; continue; }
    flush();
    const day = new Date(m.ts).toDateString();
    if (day !== prevDay) { h += `<div class="mt-day">${dayLabel(m.ts)}</div>`; prevDay = day; prevFrom = ''; }
    h += msgHtml(c, th, m, m.from === prevFrom && m.ts - prevTs < 5 * 60e3);
    prevFrom = m.from; prevTs = m.ts;
  }
  flush();
  if (c.kind === 'dm') {
    const peer = Chat.peer(c), mine = th.msgs.filter(m => m.mine && !m.deleted), last = mine[mine.length - 1];
    if (last && th.msgs[th.msgs.length - 1] === last && (c.reads || {})[peer] >= last.seq) h += `<div class="mt-seen">Seen</div>`;
  }
  return h + (window.AX.ChatMedia ? window.AX.ChatMedia.pendingHtml(c.id) : '');
}
async function threadBanner(c) {
  const bits = [];
  for (const m of Chat.others(c)) {
    const pin = await E2EE.pin(m);
    if (pin && pin.changed && !pin.changed.seen) bits.push(`<div class="mt-warn">${ic('shield', 'sm')}<span class="flex1">${esc(Chat.card(c, m).display_name)}'s security code changed. This happens when they reset their keys${pin.changed.wasVerified ? ', and you had verified the old one' : ''}.</span><button class="btn ghost sm" data-act="safety" data-u="${esc(m)}">Check</button>${pin.changed.wasVerified ? '' : `<button class="btn ghost sm" data-act="code-seen" data-u="${esc(m)}">OK</button>`}</div>`);
  }
  const problem = await Chat.sendProblem(c);
  if (problem && problem !== 'locked' && !bits.length) bits.push(`<div class="mt-warn">${ic('lock', 'sm')}<span class="flex1">${esc(problem)}</span></div>`);
  return { html: bits.join(''), problem };
}
async function updateThread() {
  const box = byId('msg-thread'); if (!box) return;
  const cid = V.route.params.c || '';
  Chat.open = cid;
  if (!cid) {
    THREAD.cid = '';
    box.innerHTML = `<div class="mt-empty">${ic('lock')}<h2>Your messages</h2><p>End-to-end encrypted chats with your friends. Only the people in a conversation can read it — not the server, and not its admins.</p><button class="btn light" data-act="new-chat">New message</button></div>`;
    return;
  }
  const c = Chat.byId.get(cid);
  if (!c) { box.innerHTML = Chat.ready ? `<div class="mt-empty">${ic('chat')}<h2>This conversation isn't available</h2></div>` : '<div class="mt-loading"><span class="spin-sm"></span></div>'; return; }
  const th = Chat.thread(cid);
  if (THREAD.cid !== cid) {
    THREAD.cid = cid; THREAD.stick = true;
    const head = c.kind === 'dm'
      ? `<div class="mt-who" data-act="open-user" data-u="${esc(Chat.peer(c))}">${convAvatar(c, 'mt-hav')}<div><b id="mt-title"></b><span>@${esc(Chat.peer(c))}</span></div></div><span class="flex1"></span>${E2EE.state === 'ready' ? `<button class="icon-btn" data-act="safety" data-u="${esc(Chat.peer(c))}" data-tip="Verify security code">${ic('shield', 'md')}</button>` : ''}`
      : `<div class="mt-who" data-act="group-info">${convAvatar(c, 'mt-hav')}<div><b id="mt-title"></b><span id="mt-sub"></span></div></div><span class="flex1"></span><button class="icon-btn" data-act="group-info" data-tip="Group info">${ic('group', 'md')}</button>`;
    box.innerHTML = `<div class="mt-h">${head}<button class="icon-btn" data-act="chat-more" data-tip="More">${ic('more-h', 'md')}</button></div><div class="mt-banner" id="mt-banner"></div><div class="mt-body" id="mt-body"></div>`
      + `<form class="composer" id="composer"><button type="button" class="icon-btn" data-act="chat-attach" data-tip="Share what's playing" aria-label="Share what's playing">${ic('note')}</button>${window.AX.ChatMedia ? window.AX.ChatMedia.buttons('icon-btn') : ''}<textarea id="mt-input" rows="1" maxlength="4000" placeholder="Message"></textarea><button class="send" type="submit" aria-label="Send">${ic('send')}</button></form>`;
    const body = byId('mt-body'), input = byId('mt-input'), form = byId('composer');
    if (window.AX.ChatMedia) window.AX.ChatMedia.mount(form, cid, box);
    body.addEventListener('scroll', () => {
      THREAD.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      if (body.scrollTop < 60 && th.more && th.loaded) { const h0 = body.scrollHeight; Chat.older(cid).then(() => { body.scrollTop = body.scrollHeight - h0 + body.scrollTop; }); }
    }, { passive: true });
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      input.value = ''; grow(); THREAD.stick = true;
      try { await Chat.send(cid, text); } catch (err) { toast(err.message); input.value = text; grow(); }
    });
    const draft = sessionStorage.getItem('axdio_draft_' + cid);
    if (draft) { input.value = draft; grow(); }
    input.addEventListener('input', debounce(() => sessionStorage.setItem('axdio_draft_' + cid, input.value), 300));
    form.addEventListener('submit', () => sessionStorage.removeItem('axdio_draft_' + cid));
    input.focus();
    if (!th.loaded) Chat.load(cid).catch(e => toast(e.message));
  }
  byId('mt-title').textContent = Chat.title(c);
  const sub = byId('mt-sub'); if (sub) sub.textContent = count(c.st.members.length, 'member');
  byId('mt-input').placeholder = `Message ${c.kind === 'dm' ? firstName(Chat.title(c)) : Chat.title(c)}`;
  const body = byId('mt-body');
  body.innerHTML = msgsHtml(c, th);
  if (window.AX.ChatMedia) window.AX.ChatMedia.hydrate(body);
  if (THREAD.stick) body.scrollTop = body.scrollHeight;
  const { html, problem } = await threadBanner(c);
  if (THREAD.cid !== cid) return;
  byId('mt-banner').innerHTML = (window.AX.ChatMedia ? window.AX.ChatMedia.banner(c) : '') + html;
  const input = byId('mt-input');
  input.disabled = !!problem; byId('composer').classList.toggle('off', !!problem);
  if (th.loaded) Chat.markRead(cid);
}
function chatExtras(c) {
  const CM = window.AX.ChatMedia;
  return CM ? [{ label: c.ttl ? `Disappearing messages: ${CM.ttlName(c.ttl)}` : 'Disappearing messages', icon: 'timer', act: () => CM.ttlDialog(c.id) },
    feat('party') && window.AX.Party ? { label: 'Start a listening party here', icon: 'party', act: () => CM.partyInvite(c.id) } : null] : [];
}
function chatMenu(c) {
  if (c.kind === 'dm') {
    const peer = Chat.peer(c);
    return [{ label: 'View profile', icon: 'person', act: () => go('user', { u: peer }) }, E2EE.state === 'ready' ? { label: 'Verify security code', icon: 'shield', act: () => safetyDialog(peer) } : null, ...chatExtras(c), { sep: true },
      { label: 'Clear chat', icon: 'trash', act: async () => { if (await confirmDlg({ title: 'Clear this chat?', text: 'The messages disappear from your devices. The other person keeps their copy.', ok: 'Clear' })) { await Chat.hide(c.id); go('messages'); } } },
      { label: 'Block', icon: 'block', danger: true, act: async () => { if (await confirmDlg({ title: `Block ${Chat.title(c)}?`, text: "They won't be able to message you or find you.", ok: 'Block', danger: true })) friendAct('block', peer); } }];
  }
  const admin = c.st.admin === U.username;
  return [{ label: 'Group info', icon: 'group', act: () => groupInfoDialog(c.id) }, { label: 'Rename group', icon: 'edit', act: () => renameGroupDlg(c.id) }, { label: 'Add people', icon: 'person-add', act: () => addPeopleDlg(c.id) }, ...chatExtras(c), { sep: true },
    { label: 'Clear chat', icon: 'trash', act: async () => { if (await confirmDlg({ title: 'Clear this chat?', text: 'The messages disappear from your devices. Everyone else keeps theirs.', ok: 'Clear' })) { await Chat.hide(c.id); go('messages'); } } },
    { label: 'Leave group', icon: 'logout', danger: true, act: async () => { if (await confirmDlg({ title: 'Leave this group?', text: admin ? "You're the admin; the next person who joined becomes admin." : "You won't get its messages anymore.", ok: 'Leave', danger: true })) { await Chat.leave(c.id); go('messages'); } } }];
}
function friendPicker({ title, ok, exclude = [], multi = true, withName = false }) {
  const friends = Social.friends().filter(f => !exclude.includes(f.username));
  if (!friends.length) { toast(exclude.length ? 'All your friends are already here' : 'Add friends first'); if (!exclude.length) go('friends', { tab: 'find' }); return Promise.resolve(null); }
  return modal({ title, ok,
    body: `<label class="filter-box" style="width:100%;height:40px;margin-bottom:12px">${ic('search')}<input id="fp-q" placeholder="Search friends" autocomplete="off" style="width:100%"></label><div class="pick-list">${friends.map(f => `<label class="pick" data-n="${esc(norm(f.display_name + ' ' + f.username))}"><input type="${multi ? 'checkbox' : 'radio'}" name="pick" value="${esc(f.username)}">${personAvatar(f, 'pr-av')}<span class="flex1"><b>${esc(f.display_name)}</b><small>@${esc(f.username)}</small></span><span class="pick-box">${ic('check', 'sm')}</span></label>`).join('')}</div>${withName ? '<div id="fp-name-wrap" hidden><label class="lbl" for="fp-name">Group name (optional)</label><input class="field" id="fp-name" maxlength="100" placeholder="Name this group"></div>' : ''}<div class="form-err" id="fp-err"></div>`,
    init: w => {
      const q = w.querySelector('#fp-q');
      q.addEventListener('input', () => { const n = norm(q.value); w.querySelectorAll('.pick').forEach(p => { p.hidden = !!n && !p.dataset.n.includes(n); }); });
      w.addEventListener('change', () => { const wrap = w.querySelector('#fp-name-wrap'); if (wrap) wrap.hidden = w.querySelectorAll('.pick input:checked').length < 2; });
      q.focus();
    },
    value: w => {
      const picked = [...w.querySelectorAll('.pick input:checked')].map(i => i.value);
      if (!picked.length) { w.querySelector('#fp-err').textContent = 'Choose at least one friend.'; return undefined; }
      return { users: picked, name: (w.querySelector('#fp-name') || {}).value || '' };
    } });
}
async function newChatDialog() {
  if (E2EE.state !== 'ready') { go('messages'); return; }
  const r = await friendPicker({ title: 'New message', ok: 'Chat', withName: true });
  if (!r) return;
  try {
    if (r.users.length === 1) { await openDM(r.users[0]); return; }
    const c = await Chat.group(r.users, r.name.trim());
    go('messages', { c: c.id });
  } catch (e) { toast(e.message); }
}
async function sendToDialog(att) {
  if (!chatOn()) return;
  if (E2EE.state !== 'ready') { toast('Turn on private messages first'); go('messages'); return; }
  const convs = Chat.list.slice(0, 8);
  const friends = Social.friends().filter(f => !convs.some(c => c.kind === 'dm' && Chat.peer(c) === f.username));
  const row = (key, avatar, name, sub) => `<label class="pick"><input type="checkbox" value="${esc(key)}">${avatar}<span class="flex1"><b>${esc(name)}</b><small>${esc(sub)}</small></span><span class="pick-box">${ic('check', 'sm')}</span></label>`;
  const a = attachment(att);
  const picked = await modal({ title: 'Send to…', ok: 'Send',
    body: `${a ? attCard(a) : ''}<div class="pick-list" style="margin-top:12px">${convs.map(c => row('c:' + c.id, convAvatar(c, 'pr-av'), Chat.title(c), c.kind === 'dm' ? 'Chat' : 'Group')).join('')}${friends.map(f => row('u:' + f.username, personAvatar(f, 'pr-av'), f.display_name, '@' + f.username)).join('')}</div><label class="lbl" for="st-msg">Add a message (optional)</label><input class="field" id="st-msg" maxlength="1000" placeholder="Say something about it"><div class="form-err" id="st-err"></div>`,
    value: w => {
      const keys = [...w.querySelectorAll('.pick input:checked')].map(i => i.value);
      if (!keys.length) { w.querySelector('#st-err').textContent = 'Choose who to send it to.'; return undefined; }
      return { keys, text: w.querySelector('#st-msg').value };
    } });
  if (!picked) return;
  let sent = 0;
  for (const k of picked.keys) {
    try {
      const cid = k.startsWith('c:') ? k.slice(2) : (await Chat.dm(k.slice(2))).id;
      await Chat.send(cid, picked.text, { a: att });
      sent++;
    } catch (e) { toast(e.message); }
  }
  if (sent) toast(sent === 1 ? 'Sent' : `Sent to ${sent} chats`);
}
async function groupInfoDialog(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const admin = c.st.admin;
  modal({ title: Chat.title(c), ok: null,
    body: `<p class="muted" style="margin-bottom:12px">${count(c.st.members.length, 'member')} • end-to-end encrypted</p><div class="pick-list">${c.st.members.map(m => { const card = Chat.card(c, m); return `<div class="pick static">${personAvatar(card, 'pr-av')}<span class="flex1"><b>${esc(m === U.username ? 'You' : card.display_name)}</b><small>${m === admin ? 'Admin' : '@' + esc(m)}</small></span>${m !== U.username && E2EE.state === 'ready' ? `<button class="icon-btn" data-gi="safety" data-u="${esc(m)}" data-tip="Verify security code">${ic('shield', 'sm')}</button>` : ''}${admin === U.username && m !== U.username ? `<button class="icon-btn" data-gi="remove" data-u="${esc(m)}" data-tip="Remove from group">${ic('minus-c', 'sm')}</button>` : ''}</div>`; }).join('')}</div><div class="btns" style="justify-content:flex-start"><button class="btn ghost sm" data-gi="add">${ic('person-add', 'sm')}Add people</button><button class="btn ghost sm" data-gi="rename">${ic('edit', 'sm')}Rename</button><span class="flex1"></span><button class="btn danger sm" data-gi="leave">Leave group</button></div>`,
    init: (w, done) => w.addEventListener('click', async e => {
      const b = e.target.closest('[data-gi]'); if (!b) return;
      const a = b.dataset.gi, u = b.dataset.u;
      done(null);
      if (a === 'safety') safetyDialog(u);
      else if (a === 'add') addPeopleDlg(cid);
      else if (a === 'rename') renameGroupDlg(cid);
      else if (a === 'remove') { if (await confirmDlg({ title: `Remove ${cardOf(u).display_name}?`, text: "They won't see new messages. The group gets a new key.", ok: 'Remove', danger: true })) Chat.removeMember(cid, u).catch(er => toast(er.message)); }
      else if (a === 'leave') { if (await confirmDlg({ title: 'Leave this group?', ok: 'Leave', danger: true })) { await Chat.leave(cid); go('messages'); } }
    }) });
}
async function addPeopleDlg(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const r = await friendPicker({ title: 'Add people', ok: 'Add', exclude: c.st.members });
  if (!r) return;
  for (const u of r.users) { try { await Chat.addMember(cid, u); } catch (e) { toast(e.message); } }
}
async function renameGroupDlg(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const name = await promptDlg({ title: 'Rename group', value: c.st.name || '', label: 'Group name', placeholder: 'Name this group' });
  if (name) Chat.rename(cid, name).then(() => toast('Group renamed')).catch(e => toast(e.message));
}
function reactMenu(b) {
  const cid = V.route.params.c, mid = b.dataset.m, mine = ((Chat.thread(cid).reacts.get(mid) || new Map()).get(U.username));
  closeMenus();
  const r = b.getBoundingClientRect(), m = document.createElement('div');
  m.className = 'cm react-pop';
  m.innerHTML = REACTIONS.map(e => `<button class="${e === mine ? 'on' : ''}" data-e="${e}">${e}</button>`).join('');
  document.body.appendChild(m);
  m.style.left = clamp(r.left - m.offsetWidth / 2 + r.width / 2, 8, innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = (r.top - m.offsetHeight - 6) + 'px';
  MENUS.push(m);
  m.addEventListener('click', e => { const x = e.target.closest('[data-e]'); if (!x) return; closeMenus(); Chat.react(cid, mid, x.dataset.e).catch(er => toast(er.message)); });
}
async function safetyDialog(user) {
  if (E2EE.state !== 'ready') return;
  const sn = await E2EE.safetyNumber(user), pin = await E2EE.pin(user), name = cardOf(user).display_name;
  if (!sn) { toast(`${name} hasn't turned on private messages yet`); return; }
  const rows = sn.split(' ');
  const ok = await modal({ title: 'Verify security code', ok: pin.verified ? 'Clear verification' : 'Mark as verified', cancel: 'Close',
    body: `<p>Compare these numbers with the ones on ${esc(name)}'s screen, in person or on a call. If they match, nobody has swapped the keys that protect your conversations.</p><div class="sn">${[0, 4, 8].map(i => `<div>${rows.slice(i, i + 4).map(g => `<span>${g}</span>`).join('')}</div>`).join('')}</div>${pin.verified ? `<p class="sn-ok">${ic('shield', 'sm')} You've verified ${esc(name)}</p>` : ''}` });
  if (!ok) return;
  await E2EE.setPin(user, pin.verified ? { verified: false } : { verified: true, changed: pin.changed ? Object.assign({}, pin.changed, { ok: true, seen: true }) : undefined });
  toast(pin.verified ? 'Verification cleared' : `${name} is verified`);
  if (V.route.view === 'messages') { THREAD.cid = null; updateThread(); }
}
const PRESENCE_STEPS = `<ol class="steps"><li><b>Get Python</b> if the computer doesn't have it yet. It's free at <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">python.org</a>.</li><li><b>Download the helper</b> on the computer where you use the Discord app. It's made for your account.</li><li><b>Open it once.</b> On Windows, double-click it. On a Mac or Linux, run <code>python3 ~/Downloads/axdio-discord.py</code> in Terminal. A window says when it's done.</li></ol><p class="steps-done">That's all. It runs in the background and starts by itself whenever you sign in to the computer. While Discord is open, your status shows the song, artist, album, artwork and time left.</p>`;
function presenceDialog() {
  let info = null;
  modal({ title: 'Show what you play on Discord', ok: null,
    body: `<p>Discord only lets programs on your own computer change your status, so this uses a small helper.</p>${PRESENCE_STEPS}<p class="muted" id="pr-state" style="font-size:13px"></p><div class="btns"><button class="btn primary" data-pr="get">${ic('dl', 'sm')}Download the helper</button></div><p class="muted" style="font-size:12.5px;margin:12px 0 0">If double-clicking opens it in a text editor, right-click it and choose Open with › Python. Turning this off removes the helper from your computer the next time it checks in. Discord's phone apps can't show this status.</p>`,
    init: w => {
      const state = w.querySelector('#pr-state');
      presenceInfo().then(d => { info = d; state.textContent = d.enabled ? (d.seen ? `Your helper last checked in ${agoText(d.seen * 1000).toLowerCase()}.` : "Your helper hasn't checked in yet.") : ''; }).catch(() => {});
      w.addEventListener('click', async e => {
        if (!e.target.closest('[data-pr="get"]')) return;
        try { await presenceSetup(); toast('Helper downloaded. Open it once to finish.'); state.textContent = 'Waiting for your helper to start…'; if (V.route.view === 'settings') render(view.scrollTop); }
        catch (ex) { toast(ex.message); }
      });
    } });
}
function recoveryKeyDialog(rk, first) {
  return modal({ title: first ? 'Save your recovery key' : 'Your recovery key', ok: first ? 'Done' : 'Close', cancel: null,
    body: `<p>${first ? "Private messages are on. " : ''}This key unlocks your messages on a new device if none of your other devices are around to approve it. Nobody else has it, not even the server's admins, so it can't be recovered if you lose it.</p><div class="rk">${esc(rk.slice(0, 19))}<br>${esc(rk.slice(20))}</div><div class="btns" style="justify-content:flex-start;margin:12px 0 0"><button class="btn ghost sm" data-rk="copy">${ic('copy', 'sm')}Copy</button><button class="btn ghost sm" data-rk="save">${ic('dl', 'sm')}Save as file</button></div><p class="muted" style="font-size:13px;margin-top:16px">Keep it somewhere safe, like a password manager. Anyone with this key and your password could read your messages.</p>${first ? '<label class="chk"><input type="checkbox" id="rk-ok"> I saved my recovery key</label><div class="form-err" id="rk-err"></div>' : ''}`,
    init: w => w.addEventListener('click', e => {
      const b = e.target.closest('[data-rk]'); if (!b) return;
      if (b.dataset.rk === 'copy') navigator.clipboard.writeText(rk).then(() => toast('Recovery key copied')).catch(() => toast("Couldn't copy it"));
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`${SITE.site_title || 'Axdio'} recovery key for @${U.username}\n\n${rk}\n\nKeep this private. It unlocks your private messages on a new device.\n`], { type: 'text/plain' })); a.download = `${(SITE.site_title || 'axdio').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-recovery-key.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
    }),
    value: w => { const c = w.querySelector('#rk-ok'); if (c && !c.checked) { w.querySelector('#rk-err').textContent = 'Save the key first, then tick the box.'; return undefined; } return true; } });
}
async function e2eeSetup(reset) {
  try { const rk = await E2EE.setup(reset); await recoveryKeyDialog(rk, true); toast('Private messages are on'); render(0); }
  catch (e) { toast(e.message); }
}
function unlockDialog() {
  let busy = false;
  modal({ title: 'Unlock with your recovery key', ok: 'Unlock', body: `<p>Enter the recovery key you saved when you turned on private messages.</p><input class="field mono" id="rk-in" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" autocapitalize="characters"><div class="form-err" id="rk-err"></div>`,
    init: (w, done) => { w.querySelector('#rk-in').focus(); w._done = done; },
    value: w => {
      if (busy) return undefined;
      busy = true; w.querySelector('#rk-err').textContent = '';
      E2EE.unlock(w.querySelector('#rk-in').value).then(() => { w._done(true); toast('Messages unlocked'); render(0); }).catch(e => { busy = false; w.querySelector('#rk-err').textContent = e.message; });
      return undefined;
    } });
}
async function linkDialog() {
  let p;
  try { p = await E2EE.requestLink(); } catch (e) { toast(e.message); return; }
  let timer = 0, open = true;
  const result = modal({ title: 'Approve from another device', ok: null,
    body: `<p>On a device where your messages already work, open ${esc(SITE.site_title || 'Axdio')}. A prompt appears there; approve it if it shows this code:</p><div class="link-code">${esc(p.code)}</div><p class="muted link-wait"><span class="spin-sm"></span> Waiting for approval…</p>`,
    init: (w, done) => {
      const tick = async () => {
        if (!open) return;
        try {
          const st = await E2EE.checkLink();
          if (st === 'approved') { done(true); toast('Messages unlocked'); render(0); return; }
          if (st !== 'pending') { w.querySelector('.link-wait').textContent = st === 'denied' ? 'The request was declined.' : 'The request expired. Close this and try again.'; return; }
        } catch (e) { w.querySelector('.link-wait').textContent = e.message; return; }
        timer = setTimeout(tick, 2000);
      };
      timer = setTimeout(tick, 2000);
    } });
  await result;
  open = false; clearTimeout(timer); E2EE.cancelLink();
}
function linkRequestDialog(l) {
  modal({ title: 'Link a new device?', ok: 'Approve', cancel: 'Decline', danger: false,
    body: `<p><b>${esc(l.device || 'A device')}</b> wants to read and send your private messages. Only approve it if you're signing in there yourself and it shows this code:</p><div class="link-code">${esc(l.code)}</div><p class="muted" style="font-size:13px">If you didn't ask for this, decline and change your password.</p>` })
    .then(ok => (ok ? E2EE.approve(l).then(() => toast('Device approved')) : E2EE.deny(l).then(() => toast('Request declined'))).catch(e => toast(e.message)));
}

/* --- Collaborative playlists --- */
function peopleLine(p) {
  const names = [p.owner, ...p.collaborators];
  const cards = names.map(n => Collab.person(p, n));
  const label = names.map(n => n === U.username ? 'You' : firstName(Collab.person(p, n).display_name));
  const text = label.length <= 3 ? label.join(label.length === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ' and $1') : `${label.slice(0, 2).join(', ')} and ${label.length - 2} others`;
  return `<span class="stack">${cards.slice(0, 4).map(c => personAvatar(c)).join('')}</span><b>${esc(text)}</b>`;
}
VIEWS.cpl = (el, p) => {
  if (!L.ready) { el.innerHTML = loading(); return; }
  const pl = Collab.get(p.id);
  if (!pl) { el.innerHTML = `<div class="content" style="padding-top:100px">${emptyHtml('people', "This playlist isn't available", 'It may have been deleted, or you were taken off it.')}</div>`; if (collabOn()) Collab.refresh(); return; }
  const ids = Collab.ids(pl.id), rels = pl.tracks.map(t => t.r), owner = Collab.owns(pl);
  const ctx = vctx('playlist', 'cpl:' + pl.id, pl.name, ids, 'cpl:' + pl.id);
  ctx.cplId = pl.id;
  const byRel = new Map(pl.tracks.map(t => [t.r, t]));
  const line = `${peopleLine(pl)}<span class="dot"></span><span class="muted">${count(ids.length, 'song')}</span>`;
  let h = '<div class="vbg"></div>' + vhead(pl.name, ctx) + heroHtml({ kind: 'Collaborative playlist', cover: plCover(rels), title: pl.name, line, editable: owner ? 'cpl-rename' : '' })
    + `<div class="actions">${ids.length ? playBtn(ctx) + shufBtn() : ''}${dlBtn(ctx)}${owner ? `<button class="act-btn" data-act="cpl-invite" data-tip="Invite friends">${ic('person-add')}</button>` : ''}${moreBtn('cpl', pl.id)}<span class="flex1"></span>${ids.length > 8 ? `<label class="filter-box">${ic('search')}<input id="pl-filter" placeholder="Search in playlist" autocomplete="off"></label>` : ''}</div><div class="content">`;
  if (ids.length) h += tableShell(ctx, { cpl: pl.id, by: t => { const it = byRel.get(t.rel); const c = it && Collab.person(pl, it.by); return c ? `<span class="added-by" data-tip="Added by ${esc(it.by === U.username ? 'you' : c.display_name)}">${personAvatar(c)}</span>` : ''; } });
  h += `<section class="sec"><div class="sec-h"><div><h2>${ids.length ? 'Recommended' : 'Add the first songs'}</h2>${ids.length ? '<div class="kicker" style="margin-top:4px">Based on what\'s in this playlist</div>' : ''}</div></div><label class="filter-box" style="width:min(420px,100%);height:40px;margin-bottom:12px">${ic('search')}<input id="pl-find" placeholder="Search for songs to add" autocomplete="off" style="width:100%"></label><div id="pl-rec"></div></section>`;
  el.innerHTML = h + '</div>';
  fillTables(el);
  if (ids.length) paint(L.tracks[ids[0]].rel);
  const recBox = el.querySelector('#pl-rec'), find = el.querySelector('#pl-find');
  const drawRec = () => {
    const q = find.value.trim();
    const have = new Set(rels);
    const recIds = q ? (searchAll(q) || { songs: [] }).songs.slice(0, 20)
      : ids.length ? uniq(ids.slice(-6).flatMap(id => AXradio(id))).filter(id => !have.has(L.tracks[id].rel)).slice(0, 10) : shuffled(L.tracks.map(t => t.id), rng(dayKey())).slice(0, 10);
    const rc = vctx('list', 'rec:cpl:' + pl.id, 'Recommended', recIds);
    recBox.innerHTML = recIds.length ? tableShell(rc, { noHead: true, add: true }) : '<p class="muted">No matches.</p>';
    fillTables(recBox);
  };
  find.addEventListener('input', debounce(drawRec, 150));
  drawRec();
  const filter = el.querySelector('#pl-filter');
  if (filter) filter.addEventListener('input', debounce(() => filterTable(el.querySelector('.tt'), filter.value), 120));
};
async function inviteDialog({ personal, cid }) {
  const pl = cid ? Collab.get(cid) : null;
  const r = await friendPicker({ title: personal ? `Make “${personal}” collaborative` : 'Invite friends', ok: 'Invite', exclude: pl ? [pl.owner, ...pl.collaborators] : [] });
  if (!r) return;
  try {
    if (personal) { const p = await Collab.fromPersonal(personal, r.users); toast('Your friends can now add songs too'); go('cpl', { id: p.id }, { replace: V.route.view === 'playlist' }); }
    else { await Collab.op(cid, { op: 'invite', users: r.users }); toast(r.users.length === 1 ? 'Invited' : `Invited ${r.users.length} friends`); }
  } catch (e) { toast(e.message); }
}
async function newCollabDialog() {
  const name = await promptDlg({ title: 'New collaborative playlist', value: `Our Playlist #${Collab.list.length + 1}`, ok: 'Next' });
  if (!name) return;
  const r = await friendPicker({ title: 'Invite friends', ok: 'Create' });
  if (!r) return;
  try { const p = await Collab.create(name, [], r.users); go('cpl', { id: p.id }); } catch (e) { toast(e.message); }
}
function cplMenu(pl) {
  const owner = Collab.owns(pl);
  return [owner ? { label: 'Invite friends', icon: 'person-add', act: () => inviteDialog({ cid: pl.id }) } : null,
    owner ? { label: 'Rename', icon: 'edit', act: async () => { const n = await promptDlg({ title: 'Rename playlist', value: pl.name }); if (n) Collab.op(pl.id, { op: 'rename', name: n }).catch(() => {}); } } : null,
    owner && pl.collaborators.length ? { label: 'Remove a collaborator', icon: 'minus-c', sub: pl.collaborators.map(u => ({ label: Collab.person(pl, u).display_name, icon: 'person', act: () => Collab.op(pl.id, { op: 'kick', user: u }).then(() => toast('Removed')).catch(() => {}) })) } : null,
    chatOn() ? { label: 'Send to a friend', icon: 'send', act: () => sendToDialog({ k: 'cpl', id: pl.id, title: pl.name }) } : null,
    { sep: true },
    owner ? { label: 'Delete', icon: 'trash', danger: true, act: async () => { if (await confirmDlg({ title: `Delete “${pl.name}”?`, text: 'It disappears for everyone on it.', ok: 'Delete', danger: true })) { await Collab.op(pl.id, { op: 'delete' }).catch(() => {}); if (V.route.view === 'cpl') go('home'); } } }
      : { label: 'Leave playlist', icon: 'logout', danger: true, act: async () => { if (await confirmDlg({ title: `Leave “${pl.name}”?`, text: "It won't be in your library anymore.", ok: 'Leave', danger: true })) { await Collab.op(pl.id, { op: 'leave' }).catch(() => {}); if (V.route.view === 'cpl') go('home'); } } }];
}

/* ======================================================================
   8. Actions, keyboard shortcuts & boot
   ====================================================================== */
const ACT = {
  go: b => {
    const v = b.dataset.view, id = b.dataset.id;
    if (v === 'album') goAlbum(id);
    else if (v === 'artist') goArtist(id);
    else if (v === 'discog') { const ar = L.artists[+id]; if (ar) go('discog', { key: ar.key }); }
    else if (v === 'list') go('list', { kind: b.dataset.kind });
    else if (v === 'search') byId('q').focus();
    else go(v);
  },
  open: b => openItem(b.dataset.k, b.dataset.id),
  'hist-back': () => history.back(),
  'hist-fwd': () => history.forward(),
  'item-play': b => {
    const k = b.dataset.k, id = b.dataset.id;
    if (k === 'track') { playTrackAlone(+id); return; }
    const ctx = itemCtx(k, id); if (!ctx) return;
    if (P.ctx && P.ctx.key === ctx.key) togglePlay(); else playCtx(ctx, -1);
  },
  'item-more': b => menuAt(b, itemMenu(b.dataset.k, b.dataset.id)),
  'play-ctx': b => { const ctx = CTX.get(b.dataset.pc); if (!ctx) return; if (ctxPlaying(ctx)) togglePlay(); else playCtx(ctx, -1); },
  toggle: togglePlay, next: () => next(), prev,
  shuffle: () => setShuffle(!P.shuffle), repeat: cycleRepeat, 'shuffle-all': shuffleAll,
  like: b => toggleLike(L.tracks[+b.dataset.t], b),
  'like-cur': b => { const t = curTrack(); if (t) toggleLike(t, b); },
  'row-play': b => playRow(b.closest('.tr')),
  'row-more': b => { const row = b.closest('.tr'), tt = row.closest('.tt'), i = +row.dataset.i; if (!(SEL.tt === tt && SEL.set.has(i))) SEL.only(tt, i); menuAt(b, trackMenu(SEL.ids(), { plName: tt.dataset.pl, cplId: tt.dataset.cpl })); },
  'more-cur': b => { const t = curTrack(); if (t) menuAt(b, trackMenu([t.id])); },
  'save-album': b => toggleSaveAlbum(L.albums[+b.dataset.id]),
  follow: b => toggleFollow(L.artists[+b.dataset.id]),
  'dl-ctx': b => { const ctx = CTX.get(b.dataset.dlc); if (ctx) toggleCtxDownload(ctx); },
  'mix-save': b => { const m = getMix(b.dataset.id); if (m) createPlaylistDlg(m.ids.slice(), m.name); },
  'pl-rename': () => renamePlaylistDlg(V.route.params.name),
  'pl-add-one': b => {
    const p = V.route.params;
    if (V.route.view === 'cpl') { if (Collab.add(p.id, [+b.dataset.t])) toast('Added'); return; }
    if (addToPlaylist(p.name, [+b.dataset.t])) toast(`Added to ${p.name}`);
  },
  'new-playlist': () => createPlaylistDlg(),
  'liked-sort': b => menuAt(b, [['recent', 'Recently added'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album']].map(([k, l]) => ({ label: l, icon: LIKED.sort === k ? 'check' : 'blank', on: LIKED.sort === k, act: () => { LIKED.sort = k; render(view.scrollTop); } }))),
  'artist-more': () => { V.artist.more = !V.artist.more; render(view.scrollTop); },
  'disc-chip': b => { V.artist.disc = b.dataset.f; render(view.scrollTop); },
  'discog-filter': b => { V.discog.f = b.dataset.f; render(view.scrollTop); },
  'search-filter': b => { SR.f = b.dataset.f; render(0); },
  'forget-search': b => { forgetSearch(b.dataset.sk, b.dataset.skey); render(view.scrollTop); },
  'clear-searches': () => { clearSearches(); render(0); },
  'home-filter': b => { S.homeFilter = b.dataset.f; saveS(); render(0); },
  'side-filter': b => { SIDE.f = SIDE.f === b.dataset.f ? '' : b.dataset.f; S.sideFilter = SIDE.f; saveS(); renderSide(); },
  'side-find': () => { SIDE.find = !SIDE.find; SIDE.focus = SIDE.find; if (!SIDE.find) SIDE.q = ''; renderSide(); },
  'side-collapse': () => { S.sideMin = !S.sideMin; saveS(); layout(); renderSide(); },
  'side-sort': b => menuAt(b, [{ head: 'Sort by' }, ...Object.entries(SORTS).map(([k, l]) => ({ label: l, icon: S.libSort === k ? 'check' : 'blank', on: S.libSort === k, act: () => { S.libSort = k; saveS(); renderSide(); } })),
    { sep: true }, { head: 'View as' }, ...[['compact', 'Compact', 'compact'], ['list', 'List', 'list'], ['grid', 'Grid', 'grid']].map(([k, l, i]) => ({ label: l, icon: i, on: S.sideView === k, act: () => { S.sideView = k; saveS(); renderSide(); } }))]),
  'create-menu': b => menuAt(b, [{ label: 'Playlist', icon: 'note', note: 'Create a playlist with songs', act: () => createPlaylistDlg() },
    collabOn() ? { label: 'Collaborative playlist', icon: 'people', act: () => newCollabDialog() } : null,
    (P.cur != null) ? { label: 'Playlist from queue', icon: 'queue', act: () => createPlaylistDlg(uniq([P.cur, ...P.queue, ...upcoming(100).map(u => u.id)]), 'My queue') } : null]),
  'me-menu': b => menuAt(b, U.token
    ? [{ head: U.name || U.username }, { label: 'Profile', icon: 'person', act: () => go('profile') }, socialOn() ? { label: 'Friends', icon: 'people', act: () => go('friends') } : null, chatOn() ? { label: 'Messages', icon: 'chat', act: () => go('messages') } : null, { label: 'Settings', icon: 'gear', act: () => go('settings') }, { label: 'Downloads', icon: 'dl', act: () => go('downloads') }, feat('rewind') && window.AX.Rewind ? { label: 'Your Rewind', icon: 'spark', act: () => window.AX.Rewind.open() } : null, { label: 'Keyboard shortcuts', icon: 'keyboard', act: shortcutsDialog }, { sep: true }, { label: 'Mobile site', icon: 'phone', act: () => { location.href = '/mobile'; } }, { label: 'Log out', icon: 'logout', act: ACT.logout }]
    : [{ label: 'Log in or sign up', icon: 'person', act: () => go('profile') }, { label: 'Settings', icon: 'gear', act: () => go('settings') }, { label: 'Keyboard shortcuts', icon: 'keyboard', act: shortcutsDialog }, { sep: true }, { label: 'Mobile site', icon: 'phone', act: () => { location.href = '/mobile'; } }]),
  'toggle-np': () => setPanel('np'),
  'toggle-friends': () => setPanel('friends'),
  'party': () => { setPanel('party'); if (window.AX.Party && RP.mode === 'party') window.AX.Party.refresh(); },
  'party-join': b => window.AX.Party && window.AX.Party.join('', b.dataset.id),
  'discord-link': () => discordLink(),
  'discord-unlink': async () => { if (await confirmDlg({ title: 'Disconnect Discord?', text: "You won't be able to sign in with Discord until you connect it again.", ok: 'Disconnect' })) { try { await discordUnlink(); toast('Discord disconnected'); render(view.scrollTop); } catch (e) { toast(e.message); } } },
  'presence-setup': () => presenceDialog(),
  'presence-off': async () => { if (await confirmDlg({ title: 'Turn off Discord status?', text: 'The helper on your computer stops working. You can set it up again any time.', ok: 'Turn off' })) { try { await presenceOff(); toast('Discord status turned off'); render(view.scrollTop); } catch (e) { toast(e.message); } } },
  'fa-play': b => { const t = L.byRel.get(b.dataset.rel); if (t) playTrackAlone(t.id); else toast("That song isn't in the library"); },
  'open-user': b => go('user', { u: b.dataset.u }),
  'friend-act': b => friendAct(b.dataset.a, b.dataset.u),
  'friend-more': b => menuAt(b, friendMenu(b.dataset.u)),
  dm: b => openDM(b.dataset.u),
  'fr-tab': b => { FR.tab = b.dataset.t; go('friends', { tab: FR.tab }, { replace: true, force: true }); },
  'blocked-list': () => {
    const list = Social.me.blocked || [];
    modal({ title: 'Blocked people', ok: 'Done', cancel: null, body: list.length ? `<div class="pick-list">${list.map(c => `<div class="pick static">${personAvatar(c, 'pr-av')}<span class="flex1"><b>${esc(c.display_name)}</b><small>@${esc(c.username)}</small></span><button class="btn ghost sm" data-bl="${esc(c.username)}">Unblock</button></div>`).join('')}</div>` : '<p>Nobody is blocked.</p>',
      init: w => w.addEventListener('click', async e => { const x = e.target.closest('[data-bl]'); if (!x) return; await friendAct('unblock', x.dataset.bl); x.closest('.pick').remove(); }) });
  },
  'set-share-activity': () => Social.setting('share_activity', !(Social.me.settings || {}).share_activity).then(() => render(view.scrollTop)).catch(e => toast(e.message)),
  'set-discoverable': () => Social.setting('discoverable', !(Social.me.settings || {}).discoverable).then(() => render(view.scrollTop)).catch(e => toast(e.message)),
  'open-chat': b => go('messages', { c: b.dataset.c }, { replace: V.route.view === 'messages' }),
  'new-chat': () => newChatDialog(),
  'chat-older': () => Chat.older(V.route.params.c),
  'chat-more': b => { const c = Chat.byId.get(V.route.params.c); if (c) menuAt(b, chatMenu(c)); },
  'chat-attach': () => { const t = curTrack(); if (!t) { toast('Play something first, then share it here'); return; } Chat.send(V.route.params.c, '', { a: attachTrack(t) }).catch(e => toast(e.message)); },
  'att-open': b => {
    const k = b.dataset.k, id = b.dataset.id;
    if (k === 'track') { const t = L.tracks[+id]; if (t) goAlbum(t.albumId); } else if (k === 'album') goAlbum(id); else if (k === 'artist') goArtist(id); else if (k === 'cpl') go('cpl', { id });
  },
  'att-play': b => {
    const k = b.dataset.k, id = b.dataset.id;
    if (k === 'track') { playTrackAlone(+id); return; }
    const ctx = itemCtx(k, id); if (ctx) playCtx(ctx, -1);
  },
  'react-menu': b => reactMenu(b),
  unsend: async b => { if (await confirmDlg({ title: 'Unsend this message?', text: "It's removed for everyone in the chat.", ok: 'Unsend' })) Chat.unsend(V.route.params.c, b.dataset.m).catch(e => toast(e.message)); },
  safety: b => safetyDialog(b.dataset.u),
  'code-seen': async b => { const p = await E2EE.pin(b.dataset.u); if (p && p.changed) await E2EE.setPin(b.dataset.u, { changed: Object.assign({}, p.changed, { seen: true }) }); THREAD.cid = null; updateThread(); },
  'group-info': () => groupInfoDialog(V.route.params.c),
  'e2ee-setup': () => e2eeSetup(false),
  'e2ee-unlock': () => unlockDialog(),
  'e2ee-link': () => linkDialog(),
  'e2ee-reset': async () => { if (await confirmDlg({ title: 'Reset private messages?', text: 'This makes new keys for your account. Messages sent before, in every conversation, can no longer be read on any of your devices, and your friends will see that your security code changed.', ok: 'Reset', danger: true })) e2eeSetup(true); },
  'rk-show': () => { const rk = E2EE.recoveryKey(); if (rk) recoveryKeyDialog(rk, false); else toast("This device doesn't have your recovery key. Make a new one instead."); },
  'rk-new': async () => { if (await confirmDlg({ title: 'Make a new recovery key?', text: 'The old one stops working. Save the new one somewhere safe.', ok: 'Make new key' })) { try { recoveryKeyDialog(await E2EE.newRecoveryKey(), true); } catch (e) { toast(e.message); } } },
  'cpl-rename': async () => { const pl = Collab.get(V.route.params.id); if (!pl) return; const n = await promptDlg({ title: 'Rename playlist', value: pl.name }); if (n) Collab.op(pl.id, { op: 'rename', name: n }).catch(() => {}); },
  'cpl-invite': () => inviteDialog({ cid: V.route.params.id }),
  'toggle-queue': () => setPanel('queue'),
  'close-panel': () => setPanel(RP.mode),
  lyrics: () => { if (V.route.view === 'lyrics') history.back(); else go('lyrics'); },
  credits: () => { const t = curTrack(); if (t) creditsDialog(t); },
  devices: async b => {
    const devs = await Connect.list();
    const others = (devs || []).filter(d => d.id !== Connect.id);
    menuAt(b, [{ head: 'Current device' }, { label: Connect.name, icon: 'pc', on: true }, { sep: true }, { head: 'Select another device' },
      ...(devs === null ? [{ label: "Couldn't reach the server", icon: 'cloud-off', disabled: true }]
        : others.length ? others.map(d => ({ label: d.name, icon: /desktop|pc|mac|win|linux/i.test(d.name) ? 'pc' : 'phone', note: d.state && d.state.playing ? 'Playing' : d.is_active ? 'Available' : 'Idle', act: () => Connect.transfer(d.id, d.name) }))
        : [{ label: 'No other devices found', icon: 'phone', disabled: true }]),
      { sep: true }, { label: 'Rename this device', icon: 'edit', act: ACT['rename-device'] }]);
  },
  mute: toggleMute,
  pip: togglePip,
  fullscreen: () => (FS.open ? closeFs() : openFs()),
  'fs-lyrics': () => { FS.lyr = !FS.lyr; renderFsLyrics(); },
  'fs-viz': () => { if (!window.AX.Vis) return; window.AX.Vis.toggle(); fsViz(); toast(window.AX.Vis.on ? 'Visuals on' : 'Visuals off'); },
  'q-clear': queueClear,
  'q-remove': b => queueRemove(+b.dataset.qi),
  'go-ctx': () => {
    const k = (P.ctx && P.ctx.recent) || '';
    if (k.startsWith('album:')) go('album', { key: k.slice(6) });
    else if (k.startsWith('artist:')) go('artist', { key: k.slice(7) });
    else if (k.startsWith('playlist:')) go('playlist', { name: k.slice(9) });
    else if (k.startsWith('mix:')) go('mix', { id: k.slice(4) });
    else if (k === 'liked') go('liked');
    else if (k === 'downloads') go('downloads');
  },
  'pb-album': () => { const t = curTrack(); if (t) goAlbum(t.albumId); },
  'dl-remove-all': async () => { if (Off.set.size && await confirmDlg({ title: 'Remove all downloads?', text: `${count(Off.set.size, 'song')} will be removed from this browser.`, ok: 'Remove', danger: true })) { await Off.removeAll(); toast('All downloads removed'); } },
  'dl-cancel-all': () => { Off.cancel([...Off.queue, ...Off.active.keys()]); toast('Downloads cancelled'); render(view.scrollTop); },
  'set-autoplay': () => { S.autoplay = !S.autoplay; saveS(); render(view.scrollTop); },
  'set-gapless': () => { S.gapless = !S.gapless; saveS(); render(view.scrollTop); },
  'set-smart': () => { S.smart = S.smart === false; saveS(); window.AX.SM.refresh(); render(view.scrollTop); },
  'set-matchvol': () => { S.matchVol = !S.matchVol; saveS(); window.AX.SM.refresh(); render(view.scrollTop); },
  'set-normalize': toggleNormalize,
  'set-dyncolor': () => { S.dynColor = !S.dynColor; saveS(); refreshAll(); },
  'set-notify': async () => {
    if (S.notify) { S.notify = false; saveS(); render(view.scrollTop); return; }
    if (!('Notification' in window)) { toast("This browser can't show notifications"); return; }
    const p = await Notification.requestPermission();
    S.notify = p === 'granted'; saveS(); render(view.scrollTop);
    if (!S.notify) toast('Notifications are blocked — allow them in your browser settings');
  },
  'eq-toggle': toggleEq,
  'eq-preset': b => setEqPreset(b.dataset.p),
  boost: b => setBoost(+b.dataset.v),
  'set-accent': b => setAccent(b.dataset.c),
  'rename-device': async () => { const n = await promptDlg({ title: 'Device name', value: Connect.name, ok: 'Save', label: 'Shown to your other devices in Connect' }); if (n) { Connect.rename(n); render(view.scrollTop); } },
  'clear-cache': async () => { if (!(await confirmDlg({ title: 'Clear cached data?', text: 'The library index will be downloaded again. Your downloads, likes and playlists are kept.', ok: 'Clear' }))) return; try { await caches.delete(META_CACHE); } catch (e) { /* ignore */ } location.reload(); },
  shortcuts: shortcutsDialog,
  'sleep-menu': b => menuAt(b, [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['eot', 'End of song']].map(([v, l]) => ({ label: l, icon: 'moon', act: () => setSleep(v) }))
    .concat(SL.end || SL.eot ? [{ sep: true }, { label: 'Turn off timer', icon: 'close', danger: true, act: () => setSleep(0) }] : [])),
  logout: async () => { if (await confirmDlg({ title: 'Log out?', text: 'Your downloads stay in this browser.', ok: 'Log out' })) { Social.stop(); signOut(); renderMe(); renderSocialButtons(); } },
  'edit-profile': editProfileDialog,
  'change-pw': changePasswordDialog,
  'set-quality': b => { setQuality(b.dataset.q); toast(`Streaming quality: ${QUALITIES[b.dataset.q]}`); },
  'devices-signed': sessionsDialog,
  subsonic: subsonicDialog,
  scrobbling: scrobblingDialog,
  'delete-account': deleteAccountDialog,
  'export-data': () => exportMyData().then(() => toast('Downloading your data'), e => toast(e.message)),
  'auth-mode': b => { AUTH.mode = b.dataset.m; render(0); },
};

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a && !a.closest('.cm')) {
    const fn = ACT[a.dataset.act];
    if (fn) { e.preventDefault(); e.stopPropagation(); fn(a, e); return; }
  }
  const row = e.target.closest('.tr[data-t]');
  if (row) { rowClick(row, e); return; }
  const q = e.target.closest('.qrow[data-q]');
  if (q) { if (q.dataset.q === 'user') queueJump(+q.dataset.qi); else if (q.dataset.q === 'ctx') ctxJump(+q.dataset.qi); return; }
  if (SEL.tt && !e.target.closest('.tt, .cm, .modal-wrap')) { SEL.reset(); SEL.apply(); }
});
document.addEventListener('dblclick', e => { const row = e.target.closest('.tr[data-t]'); if (row && !e.target.closest('a, button')) playRow(row); });
document.addEventListener('contextmenu', e => {
  const row = e.target.closest('.tr[data-t]');
  if (row) {
    e.preventDefault();
    const tt = row.closest('.tt'), i = +row.dataset.i;
    if (!(SEL.tt === tt && SEL.set.has(i))) SEL.only(tt, i);
    openMenu(e.clientX, e.clientY, trackMenu(SEL.ids(), { plName: tt.dataset.pl, cplId: tt.dataset.cpl }));
    return;
  }
  const q = e.target.closest('.qrow[data-t]');
  if (q) { e.preventDefault(); openMenu(e.clientX, e.clientY, trackMenu([+q.dataset.t], { queueIndex: q.dataset.q === 'user' ? +q.dataset.qi : null })); return; }
  const it = e.target.closest('[data-k][data-act="open"], .top-card[data-k]');
  if (it) { e.preventDefault(); openMenu(e.clientX, e.clientY, itemMenu(it.dataset.k, it.dataset.id)); return; }
  if (e.target.closest('#bar .pb-left, #rp .np-art')) { const t = curTrack(); if (t) { e.preventDefault(); openMenu(e.clientX, e.clientY, trackMenu([t.id])); } }
});
document.addEventListener('keydown', e => {
  if (MENUS.length && menuKeys(e)) return;
  if (document.querySelector('.modal-wrap')) return;
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  if ((mod && e.key.toLowerCase() === 'k') || (!typing && e.key === '/')) { e.preventDefault(); const qi = byId('q'); qi.focus(); qi.select(); return; }
  if (e.key === 'Escape') {
    if (FS.open) closeFs();
    else if (typing) e.target.blur();
    else if (SEL.tt) { SEL.reset(); SEL.apply(); }
    return;
  }
  if (typing) return;
  if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  else if (mod && e.key === 'ArrowRight') { e.preventDefault(); next(); }
  else if (mod && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  else if (mod && e.key === 'ArrowUp') { e.preventDefault(); setVolume((S.muted ? 0 : S.volume) + .1); }
  else if (mod && e.key === 'ArrowDown') { e.preventDefault(); setVolume((S.muted ? 0 : S.volume) - .1); }
  else if (e.altKey && e.shiftKey && e.code === 'KeyB') { e.preventDefault(); const t = curTrack(); if (t) toggleLike(t); }
  else if (e.altKey && e.code === 'KeyS') { e.preventDefault(); setShuffle(!P.shuffle); }
  else if (e.altKey && e.code === 'KeyR') { e.preventDefault(); cycleRepeat(); }
  else if (e.altKey && e.code === 'KeyQ') { e.preventDefault(); setPanel('queue'); }
  else if (e.altKey && e.code === 'KeyL') { e.preventDefault(); ACT.lyrics(); }
  else if (e.altKey && e.code === 'KeyF') { e.preventDefault(); ACT.fullscreen(); }
  else if (e.altKey && e.code === 'KeyV' && FS.open) { e.preventDefault(); ACT['fs-viz'](); }
  else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); createPlaylistDlg(); }
  else if (e.key === '?') { e.preventDefault(); shortcutsDialog(); }
  else if (SEL.tt) tableKeys(e);
});
view.addEventListener('click', e => { const l = e.target.closest('#lyr-view .ll'); if (l && LY.synced) { seek(LY.lines[+l.dataset.ly].t); lyrTouched = 0; if (audio.paused) play(); } });
byId('fs').addEventListener('click', e => { const l = e.target.closest('#fs-lines .ll'); if (l && LY.synced) seek(LY.lines[+l.dataset.ly].t); });

// Top-bar search: typing searches live; the URL follows so results survive reloads and back/forward.
const qi = byId('q');
qi.addEventListener('focus', () => { if (!V.route || V.route.view !== 'search') go('search', { q: qi.value }); });
qi.addEventListener('input', debounce(() => {
  byId('q-clear').hidden = !qi.value;
  if (V.route && V.route.view === 'search') { history.replaceState({ idx: NAV.idx, scroll: 0 }, '', ROUTES.search({ q: qi.value })); render(0); }
  else go('search', { q: qi.value });
}, 140));
qi.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const first = view.querySelector('.top-card, .tt .tr'); if (first) { e.preventDefault(); if (first.classList.contains('tr')) playRow(first); else first.click(); } }
  if (e.key === 'ArrowDown') { const first = view.querySelector('.tt'); if (first) { e.preventDefault(); qi.blur(); const r = first.querySelector('.tr'); if (r) SEL.only(first, +r.dataset.i); } }
});
byId('q-clear').addEventListener('click', () => { qi.value = ''; qi.dispatchEvent(new Event('input')); qi.focus(); });
// Home: the header wash follows the colour of whichever quick pick you hover.
view.addEventListener('mouseover', e => {
  const q = e.target.closest('.qt[data-k="album"]');
  if (!q || !S.dynColor || V.route.view !== 'home') return;
  const al = L.albums[+q.dataset.id]; if (al) paint(al.cover);
});

function renderMe() { byId('me-avatar').innerHTML = avatarHtml(); }
function applyBrand() {
  byId('brand-name').textContent = SITE.site_title || 'Axdio';
  if (SITE.custom_logo_url && /^(https?:|\/)/.test(SITE.custom_logo_url)) byId('brand-mark').outerHTML = `<img id="brand-mark" src="${esc(SITE.custom_logo_url)}" alt="">`;
}
function handleDeepLink() {
  const q = new URLSearchParams(location.search), rel = q.get('play');
  const lf = q.get('lastfm');
  if (lf) {
    toast({ connected: 'Last.fm connected', failed: "Couldn't connect Last.fm", unavailable: "Last.fm isn't set up on this server" }[lf] || 'Last.fm');
    history.replaceState(history.state, '', location.pathname);
  }
  if (!rel) return;
  const t = L.byRel.get(rel);
  if (!t) { toast("That song isn't in the library anymore"); go('home', {}, { replace: true }); return; }
  stageTrack(t);
  go('album', { key: albumOf(t).key }, { replace: true, force: true });
  toast(`Ready to play "${t.title}"`, { action: 'Play', onAction: play });
}
function showMobileHint() {
  if (!MOBILE_UA || sessionStorage.getItem('axdio_hide_mobile_hint')) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="mobile-hint" id="mobile-hint"><span class="flex1"><b>On a phone?</b><div class="muted" style="font-size:13px">The mobile site is made for touch.</div></span><button class="btn ghost sm" data-act="hide-hint">Stay</button><a class="btn primary sm" href="/mobile">Switch</a></div>`);
  ACT['hide-hint'] = () => { sessionStorage.setItem('axdio_hide_mobile_hint', '1'); byId('mobile-hint').remove(); };
}

const Boot = {
  box: byId('axdio-term-logs'), overlay: byId('axdio-loading-overlay'), t0: window.__axdioBootT0 || now(),
  log(type, text) {
    if (!this.box) return;
    const tag = type === 'OK' ? '<span style="color:#22c55e;font-weight:700">[&nbsp;&nbsp;OK&nbsp;&nbsp;]</span> ' : type === 'INFO' ? '<span style="color:#38bdf8;font-weight:700">[&nbsp;INFO&nbsp;]</span> ' : type === 'WARN' ? '<span style="color:#f59e0b;font-weight:700">[&nbsp;WARN&nbsp;]</span> ' : '';
    this.box.insertAdjacentHTML('beforeend', `<div style="margin:2px 0">${tag}${type === 'SYS' ? `<span style="color:#a1a1aa">${esc(text)}</span>` : esc(text)}</div>`);
    const body = byId('axdio-term-body'); if (body) body.scrollTop = body.scrollHeight;
  },
  done() {
    const o = this.overlay;
    if (!o || o.dataset.closing) return;
    o.dataset.closing = '1';
    setTimeout(() => { o.style.transition = 'opacity .35s ease'; o.style.opacity = '0'; setTimeout(() => o.remove(), 360); }, Math.max(0, 900 - (now() - this.t0)));
  },
};
if (Boot.overlay) Boot.overlay.addEventListener('click', () => Boot.done());

async function boot() {
  Boot.log('SYS', `Axdio desktop 2.0 — ${D.els.length === 2 ? 'gapless / crossfade' : 'single-deck'} audio engine`);
  NAV.idx = (history.state && history.state.idx) || 0;
  history.replaceState({ idx: NAV.idx, scroll: (history.state && history.state.scroll) || 0 }, '');
  layout(); renderMe(); renderSide(); render(0); renderPanel(); onVolume(); showMobileHint();
  await window.AX.boot({ platform: 'desktop', log: (type, text) => Boot.log(type, text), onLibrary: () => { renderSide(); render(view.scrollTop); } });
  applyBrand();
  handleDeepLink();
  if (pendingInvite() && !U.token && SITE.registration !== 'closed' && !document.getElementById('ax-gate')) { AUTH.mode = 'register'; go('profile'); }
  refreshAll(); renderMe();
  if (U.token) Social.start();
  const note = takeDiscordNote();
  if (note && note.invite) {
    const code = await promptDlg({ title: 'Invite code needed', label: 'This server needs an invite code for new accounts', placeholder: 'ABCD-1234', ok: 'Sign up' });
    if (code) { try { await discordFinish(code.toUpperCase()); toast(`Welcome, ${U.name || U.username}!`); refreshAll(); renderMe(); Social.start(); } catch (e) { toast(e.message); } }
  } else if (note && note.text) setTimeout(() => toast(note.text), 400);
  Boot.log('OK', 'Startup complete.');
  Boot.done();
}

Object.assign(UI, {
  party(v) { const b = byId('btn-party'); if (b) b.classList.toggle('on', !!v); },
  openParty() { if (RP.mode !== 'party') setPanel('party'); },
  track: onTrack, playState: onPlayState, queue: onQueue, progress: onProgress, volume: onVolume, lyrics: onLyrics, lyricLine: onLyricLine,
  remote: onRemote, dirty: markDirty, refresh: refreshAll, toast, confirm: confirmDlg, online: () => { if (V.route) render(view.scrollTop); }, social: onSocial,
  pickPlaylist: ids => openMenu(innerWidth / 2 - 120, innerHeight - 380, playlistSub(ids)),
});
Object.assign(window.AX, { go, render, SEL, openMenu });   // debug handles
boot().catch(err => { console.error(err); Boot.log('WARN', 'Startup error: ' + err.message); Boot.done(); });
}

// A page cached from an older version may not load the shared scripts yet: fetch whatever is missing first.
(function bootstrap() {
  const need = [!window.AX && '/web/app/core.js?v=3.2.0', !(window.AX && window.AX.Social) && '/web/app/social.js?v=1.0.0', !(window.AX && window.AX.Party) && '/web/app/party.js?v=1.0.0', !(window.AX && window.AX.Vis) && '/web/app/immersive.js?v=1.0.0', !(window.AX && window.AX.ChatMedia) && '/web/app/chatmedia.js?v=1.0.0', !(window.AX && window.AX.Rewind) && '/web/app/rewind.js?v=1.0.0'].filter(Boolean);
  const next = () => {
    const src = need.shift();
    if (!src) { axdioDesktop(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = next;
    document.head.appendChild(s);
  };
  next();
})();
