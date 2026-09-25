/* ==========================================================================
   Axdio Mobile — touch UI (loaded by web/mobile.html after web/app/core.js)

   The playback engine, library index, user data and downloads live in core.js;
   this file renders them for phones and plugs into AX.UI.

   1. History / page navigation   3. Sheets, dialogs & toasts   5. Gestures & boot
   2. Views                       4. Overlays (player, lyrics, queue)
   ========================================================================== */
function axdioMobile() {
'use strict';
const {
  UI, libItems,
  IOS, byId, $$, esc, norm, clamp, fmt, nf,
  count, ic, EQB, debounce, uniq, now, setUse, collator,
  haptic, hashStr, rng, shuffled, pick, dayKey, weekKey, monthYear,
  LS, K, S, saveS, saveSSoon, AUDIO_CACHE, META_CACHE, streamUrl, QUALITIES, setQuality,
  SITE, feat, featOn, CREDIT, minPassword, pendingInvite, PH, coverUrl, img, tone, hexRgb, dominant, applyAccent,
  ACCENTS, setAccent, setThemeColor, L, sortName, fileExt, buildLibrary, albumArtist, albumSource,
  albumOf, artistOf, creditParts, relatedArtists, topArtists, popular, radioIds, MIX,
  PALETTE, buildMixes, getMix, searchAll, U, api, signIn, signOut, takeDiscordNote, discordLink, discordUnlink, discordFinish, discordButton, presenceInfo, presenceSetup, presenceOff, listSessions, revokeSession, exportMyData, deleteAccount, subsonicInfo, subsonicPassword, scrobbleInfo, connectListenBrainz, disconnectScrobbler,
  updateProfile, pickImage, squarePhoto, uploadAvatar, removeAvatar, changePassword, cacheUser, recordPlay, toggleLike, setLikedMany, toggleFollow, toggleSaveAlbum,
  addToPlaylist, removeFromPlaylist, reorderPlaylist, plCreate, plRename, plDelete, pushLibrary, pushPrefs,
  RECENTS, touchRecent, recentTs, SEARCHES, rememberSearch, forgetSearch, clearSearches, Off,
  ring, dlBadge, dlChanged, updateDlButton, toggleCtxDownload, EQ_BANDS, EQ_PRESETS, eqLabel,
  FX, setBoost, toggleNormalize, toggleEq, setEqPreset, setEqBand, audio, D,
  P, CTX, makeCtx, regCtx, curTrack, ctxPlaying, isPlaying, buildOrder,
  playCtx, playTrackAlone, load, play, pause, togglePlay, shuffleAll, next,
  prev, setShuffle, cycleRepeat, addToQueue, upcoming, queueJump, ctxJump, queueRemove,
  queueMove, queueClear, seek, setVolume, toggleMute, applyVolume, stageTrack, SL,
  setSleep, sleepLabel, saveState, trackChanged, refreshLike, updatePlayButtons, updateModes, syncMediaSession,
  LY, lyMsg, syncLyrics, Connect, share, trackLink, albumLink, artistLink, setOnline, avatarHtml, itAlbum,
  itArtist, itPlaylist, itSearchPl, itLiked, itDownloads, itMix, itFromKey, searchItem, itemIds,
  itemCtx, plCover, mixCover, emptyHtml, COMP_RE, chunkRender, dragSort,
} = window.AX;

/* ======================================================================
   8. History (back button) & page navigation
   ====================================================================== */
// One browser history entry per open page / tab switch / overlay, so Android back and iOS swipe-back
// close things in the order they were opened.
const H = {
  st: [], skip: 0, waiters: [],
  push(entry) {
    if (this.skip) { this.waiters.push(() => this.push(entry)); return; }
    history.pushState({ axd: this.st.length + 1 }, '');
    this.st.push(entry);
  },
  top() { return this.st[this.st.length - 1]; },
  pop(n = 1) {
    n = Math.min(n, this.st.length);
    if (!n) return Promise.resolve();
    const closing = this.st.splice(this.st.length - n, n).reverse();
    closing.forEach((e, i) => e.close(i));
    this.skip++;
    return new Promise(res => { this.waiters.push(res); history.go(-n); });
  },
  layersOnTop() { let n = 0; for (let i = this.st.length - 1; i >= 0 && this.st[i].kind === 'layer'; i--) n++; return n; },
  closeEntry(entry) { const i = this.st.lastIndexOf(entry); return i < 0 ? Promise.resolve() : this.pop(this.st.length - i); },
};
window.addEventListener('popstate', () => {
  if (H.skip) { H.skip--; if (!H.skip) H.waiters.splice(0).forEach(f => f()); return; }
  const e = H.st.pop();
  if (e) e.close(0);
});
const afterLayers = fn => H.pop(H.layersOnTop()).then(fn);

const T = { tab: 'home', stacks: { home: [], search: [], library: [] }, seq: 0 };
const VIEWS = {};
const curPage = () => { const s = T.stacks[T.tab]; return s[s.length - 1]; };
function mkPage(view, params, tab) {
  const el = document.createElement('section');
  el.className = 'page';
  el.dataset.view = view;
  el.hidden = true;
  byId('app').appendChild(el);
  const pg = { id: ++T.seq, el, view, params: params || {}, tab, scroll: 0, ctxs: [], cleanup: [], dirty: false, state: null, heroEnd: 260, stickAt: 1e9 };
  let raf = 0;
  el.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onPageScroll(pg); }); }, { passive: true });
  renderPage(pg);
  return pg;
}
function renderPage(pg, keepScroll) {
  const y = pg.el.scrollTop;
  pg.ctxs.forEach(id => CTX.delete(id)); pg.ctxs = [];
  pg.cleanup.forEach(f => f()); pg.cleanup = [];
  pg.dirty = false;
  (VIEWS[pg.view] || VIEWS.missing)(pg);
  socialBadges();
  if (keepScroll) pg.el.scrollTop = y;
  requestAnimationFrame(() => measurePage(pg));
}
function measurePage(pg) {
  const act = pg.el.querySelector('.actions'), hero = pg.el.querySelector('.hero-title, .art-name, .prof-hero h1');
  pg.stickAt = act ? act.offsetTop + act.offsetHeight - 60 : 1e9;
  pg.heroEnd = hero ? hero.offsetTop + hero.offsetHeight : 260;
  onPageScroll(pg);
}
function onPageScroll(pg) {
  const y = pg.el.scrollTop;
  const p = clamp((y - pg.heroEnd * .55) / (pg.heroEnd * .4), 0, 1);
  pg.el.style.setProperty('--p', p.toFixed(3));
  pg.el.style.setProperty('--q', clamp(y / pg.heroEnd, 0, 1).toFixed(3));
  if (y < 600) pg.el.style.setProperty('--scroll', y.toFixed(0));
  pg.el.classList.toggle('stuck', y > pg.stickAt);
}
function pageCtx(pg, type, ref, name, ids, recent) {
  const ctx = regCtx(makeCtx(type, ref, name, ids, recent));
  pg.ctxs.push(ctx.rid);
  return ctx;
}
function showPage(pg, anim) {
  pg.el.hidden = false;
  document.body.classList.toggle('in-chat', pg.view === 'thread' && pg.el.classList.contains('chat'));
  if (anim) { pg.el.classList.remove('enter', 'fade', 'leave'); void pg.el.offsetWidth; pg.el.classList.add(anim); }
  if (pg.dirty) renderPage(pg);
  pg.el.scrollTop = pg.scroll;
  onPageScroll(pg);
  // Runs synchronously inside the tap that opened the page, so iOS still allows focus() to raise the keyboard.
  if (pg.afterShow) { const f = pg.afterShow; pg.afterShow = null; f(); }
}
function hidePage(pg) { pg.scroll = pg.el.scrollTop; pg.el.hidden = true; }
function destroyPage(pg, anim) {
  pg.ctxs.forEach(id => CTX.delete(id)); pg.cleanup.forEach(f => f());
  if (anim) { pg.el.classList.remove('enter', 'fade'); pg.el.classList.add('leave'); setTimeout(() => pg.el.remove(), 230); }
  else pg.el.remove();
}
function pushPage(view, params = {}) {
  const tab = T.tab, stack = T.stacks[tab], prev = stack[stack.length - 1];
  if (prev) prev.scroll = prev.el.scrollTop;
  const pg = mkPage(view, params, tab);
  stack.push(pg);
  showPage(pg, 'enter');
  if (prev) setTimeout(() => { if (prev !== curPage() && !prev.el.hidden && stack.includes(prev)) hidePage(prev); }, 340);
  H.push({ kind: 'page', tab, close: i => popPage(tab, i === 0) });
  return pg;
}
function popPage(tab, anim = true) {
  const stack = T.stacks[tab];
  if (stack.length <= 1) return;
  const pg = stack.pop(), top = stack[stack.length - 1];
  if (tab === T.tab) { showPage(top); destroyPage(pg, anim); } else destroyPage(pg, false);
}
function showTab(tab) {
  if (tab === T.tab && curPage()) return;
  const cur = curPage();
  if (cur) hidePage(cur);
  T.tab = tab;
  if (!T.stacks[tab].length) T.stacks[tab].push(mkPage(tab, {}, tab));
  showPage(curPage(), 'fade');
  $$('.nav-tab').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
}
function switchTab(tab) {
  haptic();
  if (tab === T.tab) {
    let n = 0;
    for (let i = H.st.length - 1; i >= 0 && H.st[i].kind === 'page' && H.st[i].tab === tab; i--) n++;
    if (n) { H.pop(n); return; }
    const pg = curPage();
    if (pg.el.scrollTop > 0) pg.el.scrollTo({ top: 0, behavior: 'smooth' });
    else if (tab === 'search') openPage('find');
    return;
  }
  const top = H.top();
  if (top && top.kind === 'tab') { if (top.back === tab) H.pop(1); else showTab(tab); return; }
  const back = T.tab;
  showTab(tab);
  H.push({ kind: 'tab', back, close: () => showTab(back) });
}
function goBack() {
  if (H.st.length) { H.pop(1); return; }
  if (T.stacks[T.tab].length > 1) popPage(T.tab);
  else if (T.tab !== 'home') showTab('home');
}
function openPage(view, params) {
  if (view === 'album' || view === 'artist') {
    const obj = view === 'album' ? L.albums[params.id] : L.artists[params.id];
    if (!obj) return;
    params = { key: obj.key };
    touchRecent(view + ':' + obj.key);
  }
  if (view === 'playlist') touchRecent('playlist:' + params.name);
  if (view === 'cpl') touchRecent('cpl:' + params.id);
  if (view === 'mix') touchRecent('mix:' + params.id);
  if (view === 'liked') touchRecent('liked');
  haptic(5);
  return pushPage(view, params);
}
function openItem(k, id) {
  switch (k) {
    case 'album': return openPage('album', { id: +id });
    case 'artist': return openPage('artist', { id: +id });
    case 'playlist': return openPage('playlist', { name: id });
    case 'cpl': return openPage('cpl', { id });
    case 'mix': return openPage('mix', { id });
    case 'liked': return openPage('liked');
    case 'downloads': return openPage('downloads');
    case 'list': return openPage('list', { kind: id });
    case 'track': { const t = L.tracks[+id]; if (t) playTrackAlone(t.id); return null; }
    default: return null;
  }
}
// Re-render pages whose data changed. Visible pages refresh now only when `now` is set.
function markDirty(views, nowVisible) {
  const cur = curPage();
  for (const tab of Object.keys(T.stacks)) for (const pg of T.stacks[tab]) {
    if (!views.includes(pg.view)) continue;
    if (pg === cur && nowVisible) renderPage(pg, true); else if (pg !== cur) pg.dirty = true;
  }
}
function refreshAll() {
  for (const tab of Object.keys(T.stacks)) for (const pg of T.stacks[tab]) { if (pg === curPage()) renderPage(pg, true); else pg.dirty = true; }
  trackChanged();
}

/* ======================================================================
   9. Views
   ====================================================================== */
const avatarBtn = () => `<button data-act="nav" data-view="profile" aria-label="Profile">${avatarHtml()}</button>`;
const topbar = (title, ctx) => `<div class="topbar"><button class="tb-btn" data-act="back" aria-label="Back">${ic('back')}</button><div class="tb-title">${esc(title)}</div>${ctx ? `<button class="tb-play" data-act="play-ctx" data-pc="${ctx.rid}" aria-label="Play">${ic(ctxPlaying(ctx) && !audio.paused ? 'pause' : 'play')}</button>` : ''}</div>`;
const playBtn = ctx => `<button class="btn-play" data-act="play-ctx" data-pc="${ctx.rid}" aria-label="Play">${ic(ctxPlaying(ctx) && !audio.paused ? 'pause' : 'play')}</button>`;
const shuffleBtn = () => `<button class="ib${P.shuffle ? ' on' : ''}" data-act="shuffle" data-shuf aria-label="Shuffle">${ic('shuffle')}</button>`;
const dlBtn = ctx => `<button class="ib dl-btn" data-act="dl-ctx" data-dlc="${ctx.rid}" aria-label="Download"></button>`;
function paint(pg, rel) {
  if (!S.dynColor || !rel) return;
  dominant(coverUrl(rel)).then(c => { if (c) pg.el.style.setProperty('--c', tone(c, .3, .25)); });
}
function afterRender(pg) { $$('[data-dlc]', pg.el).forEach(updateDlButton); }

const attrs = it => `data-act="open" data-k="${it.k}" data-id="${esc(it.id)}"${it.ck ? ` data-ck="${esc(it.ck)}"` : ''}`;
const cardHtml = it => `<div class="card${it.circle ? ' circle' : ''}${P.ctx && it.ck === P.ctx.recent ? ' ctx-playing' : ''}" ${attrs(it)}><div class="card-img">${it.cover}</div><div class="card-t ell">${esc(it.title)}</div><div class="card-s clamp2">${esc(it.sub)}</div></div>`;
const rowHtml = (it, big) => `<div class="row${big ? ' big' : ''}${it.circle ? ' circle' : ''}" ${attrs(it)}><div class="row-art">${it.cover}</div><div class="meta"><div class="t">${esc(it.title)}</div><div class="s">${it.pinned ? `<span class="pinned">${ic('pin')}</span>` : ''}<span>${esc(it.sub)}</span></div></div></div>`;
const quickHtml = it => `<div class="qt" ${attrs(it)}><div class="qt-art">${it.cover}</div><div class="qt-t clamp2">${esc(it.title)}</div>${EQB}</div>`;
function shelf(title, items, opts = {}) {
  if (!items.length) return '';
  return `<div class="sec-h"><div>${opts.kicker ? `<div class="kicker">${esc(opts.kicker)}</div>` : ''}<h2>${esc(title)}</h2></div>${opts.more ? `<button class="more" ${opts.more}>Show all</button>` : ''}</div><div class="shelf${opts.big ? ' big' : ''}">${items.map(cardHtml).join('')}</div>`;
}
function trackRow(t, i, o = {}) {
  const liked = U.likedSet.has(t.rel);
  const off = !navigator.onLine && !Off.set.has(t.rel);
  const lead = o.num ? `<div class="num"><span class="num-n">${i + 1}</span>${EQB}</div>` : o.noArt ? '' : `<div class="row-art">${img(coverUrl(t.rel))}${EQB}</div>`;
  const tail = o.tail != null ? o.tail
    : `<button class="row-act${liked ? ' liked' : ''}" data-act="like" data-t="${t.id}" aria-label="${liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}">${ic(liked ? 'heart-f' : 'heart', 'md')}</button><button class="row-act" data-act="more" data-t="${t.id}" aria-label="More options for ${esc(t.title)}">${ic('more-v', 'md')}</button>`;
  return `<div class="trk${P.cur === t.id ? ' playing' : ''}${off ? ' off' : ''}" data-t="${t.id}" data-i="${i}">${o.drag ? `<div class="drag-h" data-drag aria-label="Reorder">${ic('drag')}</div>` : ''}${lead}<div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="dl-slot" data-dl="${t.id}">${dlBadge(t.rel)}</span><span>${esc(o.sub != null ? o.sub : t.artist)}</span></div></div>${tail}</div>`;
}
function trackList(ctx, o = {}) { return `<div class="rows" data-ctx="${ctx.rid}">${ctx.ids.slice(0, o.limit || ctx.ids.length).map((id, i) => trackRow(L.tracks[id], i, o)).join('')}</div>`; }
// Long lists render in chunks as you scroll; disposal is tied to the page.
function chunked(pg, container, n, render, step = 50) {
  const dispose = chunkRender(pg.el, container, n, render, step);
  pg.cleanup.push(dispose);
  return dispose;
}

VIEWS.party = pg => {
  pg.el.innerHTML = topbar('Listening party') + '<div class="party-page"><div></div></div>';
  if (window.AX.Party) window.AX.Party.render(pg.el.querySelector('.party-page > div'));
};
VIEWS.missing = pg => { pg.el.innerHTML = topbar('') + `<div style="padding-top:80px">${emptyHtml('album', "This isn't available", 'It may have been removed from the library.', '<button class="btn light" data-act="back">Go back</button>')}</div>`; };

function skeletonShelves() {
  const card = '<div><div class="sk" style="aspect-ratio:1"></div><div class="sk" style="height:12px;margin-top:10px;width:80%"></div></div>';
  const sec = `<div class="sec-h"><div class="sk" style="height:22px;width:55%"></div></div><div class="shelf">${card.repeat(4)}</div>`;
  return `<div class="quick">${'<div class="sk" style="height:56px"></div>'.repeat(6)}</div>${sec}${sec}`;
}

VIEWS.home = pg => {
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  let h = `<header class="root-h home-h">${avatarBtn()}<h1 class="greet">${greet}</h1>${chatBtn()}${chatOn() ? '' : `<button class="hb" data-act="nav" data-view="recent" aria-label="Recently played">${ic('history')}</button>`}<button class="hb" data-act="nav" data-view="settings" aria-label="Settings">${ic('gear')}</button></header>`;
  if (!L.ready) { pg.el.innerHTML = h + skeletonShelves(); return; }
  const rand = rng(dayKey() + U.username);
  // Quick picks: pinned + recently used, topped up with albums you've played or a daily random pick.
  const seen = new Set(), quick = [];
  const addQ = it => { if (it && !seen.has(it.ck) && quick.length < 8) { seen.add(it.ck); quick.push(it); } };
  if (U.liked.length) addQ(itLiked());
  RECENTS.forEach(r => addQ(itFromKey(r.k)));
  U.history.forEach(hh => { const t = L.byRel.get(hh.rel_path); if (t) addQ(itAlbum(albumOf(t))); });
  const bigAlbums = L.albums.filter(a => a.type === 'Album');
  shuffled(bigAlbums.length > 8 ? bigAlbums : L.albums, rand).slice(0, 12).forEach(a => addQ(itAlbum(a)));
  h += `<div class="quick">${quick.slice(0, quick.length >= 6 ? (quick.length >= 8 ? 8 : 6) : quick.length).map(quickHtml).join('')}</div>`;
  if (window.AX.Rewind) h += `<div class="rw-wrap">${window.AX.Rewind.homeCard()}</div>`;
  h += friendsShelf();

  const jump = RECENTS.map(r => itFromKey(r.k)).filter(it => it && !quick.slice(0, 8).some(q => q.ck === it.ck)).slice(0, 12);
  if (jump.length >= 3) h += shelf('Jump back in', jump);
  const mixes = buildMixes();
  h += shelf(U.name ? U.name : 'Made for you', mixes.map(itMix), { kicker: U.name ? 'Made for' : '', big: true, more: 'data-act="open" data-k="list" data-id="mixes"' });
  h += shelf('Recently added', L.newestAlbums.slice(0, 14).map(id => itAlbum(L.albums[id])), { more: 'data-act="open" data-k="list" data-id="recent-albums"' });
  const tops = topArtists(12);
  if (tops.length >= 3) h += shelf('Your top artists', tops.map(itArtist));
  else h += shelf('Artists to explore', shuffled(L.artists.filter(a => a.trackIds.length >= 5), rand).slice(0, 12).map(itArtist), { more: 'data-act="open" data-k="list" data-id="artists"' });
  const anchor = tops[0] || pick(L.artists.filter(a => a.rel.size), rand);
  if (anchor) {
    const rel = relatedArtists(anchor, 12);
    const albs = uniq(rel.flatMap(r => r.albumIds.slice(0, 2))).map(id => itAlbum(L.albums[id]));
    if (albs.length >= 3) h += shelf(`More like ${anchor.name}`, shuffled(albs, rand).slice(0, 12), { kicker: tops[0] ? 'Because you listen to' : 'Artists you might like' });
  }
  const followed = U.follows.map(k => L.artistByKey.get(k)).filter(a => a && a.trackIds.length);
  if (followed.length) h += shelf('New from artists you follow', uniq(followed.flatMap(a => a.albumIds.slice(0, 2))).sort((a, b) => L.albums[b].mtime - L.albums[a].mtime).slice(0, 12).map(id => itAlbum(L.albums[id])));
  const playedAlbums = new Set(U.history.map(x => { const t = L.byRel.get(x.rel_path); return t ? t.albumId : -1; }));
  const unplayed = L.albums.filter(a => a.trackIds.length >= 5 && !playedAlbums.has(a.id));
  h += shelf('Something different', shuffled(unplayed.length > 12 ? unplayed : L.albums, rand).slice(0, 12).map(itAlbum), { kicker: 'Picked for today' });
  h += shelf('Fresh singles', L.newestAlbums.map(id => L.albums[id]).filter(a => a.type === 'Single' || a.type === 'EP').slice(0, 14).map(itAlbum), { more: 'data-act="open" data-k="list" data-id="singles"' });
  h += `<div class="stats-foot"><div class="flex1"><b>Your library</b><div class="muted">${count(L.tracks.length, 'song')} • ${count(L.azArtists.length, 'artist')} • ${count(L.albums.length, 'release')}</div></div><button class="btn primary" data-act="shuffle-all">${ic('shuffle', 'md')}Shuffle</button></div>`;
  pg.el.innerHTML = h;
};

VIEWS.recent = pg => {
  const ids = U.history.map(x => L.byRel.get(x.rel_path)).filter(Boolean).map(t => t.id).slice(0, 300);
  const ctx = pageCtx(pg, 'list', 'history', 'Recently played', ids);
  let h = topbar('Recently played') + `<div class="hero" style="padding-bottom:6px"><h1 class="hero-title">Recently played</h1><div class="hero-sub">${U.token ? 'Synced across your devices' : 'On this device'}</div></div>`;
  if (!ids.length) { pg.el.innerHTML = h + emptyHtml('history', 'Nothing here yet', 'Songs you play will show up here.'); return; }
  const today = new Date().toDateString(), yest = new Date(now() - 864e5).toDateString();
  let last = '', rows = '';
  U.history.forEach(x => {
    const t = L.byRel.get(x.rel_path); if (!t) return;
    const i = ids.indexOf(t.id); if (i < 0) return;
    const d = x.last_played ? new Date(x.last_played) : null;
    const label = !d || isNaN(d) ? 'Earlier' : d.toDateString() === today ? 'Today' : d.toDateString() === yest ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (label !== last) { rows += `<div class="q-sec" style="padding-top:22px">${esc(label)}</div>`; last = label; }
    rows += trackRow(t, i, { sub: `${t.artist}${x.count > 1 ? ` • ${count(x.count, 'play')}` : ''}` });
  });
  pg.el.innerHTML = h + `<div class="rows" data-ctx="${ctx.rid}">${rows}</div>`;
};

const BROWSE = [
  ['Liked Songs', '#8d67ab', 'data-act="open" data-k="liked"', 'heart-f'],
  ['Recently added', '#e8115b', 'data-act="open" data-k="list" data-id="recent-albums"', 'new'],
  ['Made for you', '#1e3264', 'data-act="open" data-k="list" data-id="mixes"', 'spark'],
  ['Discover Weekly', '#477d95', 'data-act="open" data-k="mix" data-id="discover"', 'radio'],
  ['Singles & EPs', '#148a08', 'data-act="open" data-k="list" data-id="singles"', 'note'],
  ['Compilations & DJ mixes', '#ba5d07', 'data-act="open" data-k="list" data-id="comps"', 'album'],
  ['All artists', '#509bf5', 'data-act="open" data-k="list" data-id="artists"', 'person'],
  ['All albums', '#af2896', 'data-act="open" data-k="list" data-id="albums"', 'album'],
  ['Downloaded', '#27856a', 'data-act="open" data-k="downloads"', 'dl-f'],
  ['Shuffle everything', '#e91429', 'data-act="shuffle-all"', 'shuffle'],
];
VIEWS.search = pg => {
  let h = `<header class="root-h">${avatarBtn()}<h1>Search</h1></header><div class="search-box" data-act="nav" data-view="find" role="search">${ic('search')}<span>What do you want to listen to?</span></div>`;
  if (!L.ready) { pg.el.innerHTML = h + skeletonShelves(); return; }
  const tile = ([label, color, act, icon]) => `<div class="tile" style="background:${color}" ${act}><span>${esc(label)}</span><div class="tile-ic">${ic(icon)}</div></div>`;
  h += `<div class="sec-h"><h2>Start browsing</h2></div><div class="browse">${BROWSE.slice(0, 4).map(tile).join('')}</div>`;
  const rand = rng(dayKey());
  const tops = topArtists(8);
  const arts = (tops.length >= 4 ? tops : shuffled(L.artists.filter(a => a.trackIds.length >= 8), rand)).slice(0, 8);
  h += `<div class="sec-h"><h2>Browse all</h2></div><div class="browse">${BROWSE.slice(4).map(tile).join('')}${arts.map((a, i) => `<div class="tile" style="background:${PALETTE[(i * 3 + 1) % PALETTE.length]}" data-act="open" data-k="artist" data-id="${a.id}"><span>${esc(a.name)}</span>${img(coverUrl(a.cover))}</div>`).join('')}</div>`;
  pg.el.innerHTML = h;
};

/* Active search page */
VIEWS.find = pg => {
  const st = pg.state || (pg.state = { q: '', f: 'top' });
  pg.el.innerHTML = `<div class="find-h"><label class="find-in">${ic('search', 'md')}<input type="search" enterkeyhint="search" placeholder="What do you want to listen to?" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search" value="${esc(st.q)}"><button class="clear" type="button" aria-label="Clear" ${st.q ? '' : 'hidden'}>${ic('close', 'md')}</button></label><button class="find-cancel" data-act="back">Cancel</button></div><div class="chips find-chips" ${st.q ? '' : 'hidden'}></div><div class="find-body"></div>`;
  const input = pg.el.querySelector('input'), clear = pg.el.querySelector('.clear'), chips = pg.el.querySelector('.find-chips'), body = pg.el.querySelector('.find-body');
  const run = () => {
    st.q = input.value;
    clear.hidden = !st.q; chips.hidden = !st.q.trim();
    pg.ctxs.forEach(id => CTX.delete(id)); pg.ctxs = [];
    const res = searchAll(st.q);
    if (!res) { renderRecentSearches(body); return; }
    chips.innerHTML = [['top', 'Top'], ['songs', 'Songs'], ['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists']]
      .map(([id, l]) => `<button class="chip${st.f === id ? ' on' : ''}" data-f="${id}">${l}</button>`).join('');
    body.innerHTML = searchResults(pg, res, st.f, st.q);
  };
  function renderRecentSearches(el) {
    const items = SEARCHES.map(s => [s, searchItem(s)]).filter(x => x[1]);
    if (!items.length) { el.innerHTML = emptyHtml('search', 'Play what you love', 'Search artists, songs, albums and playlists.'); return; }
    el.innerHTML = `<div class="recent-h"><h2>Recent searches</h2></div>${items.map(([s, it]) => `<div class="row${it.circle ? ' circle' : ''}" ${it.k === 'track' ? `data-act="open" data-k="track" data-id="${it.id}"` : attrs(it)}><div class="row-art">${it.cover}</div><div class="meta"><div class="t">${esc(it.title)}</div><div class="s"><span>${esc(it.sub)}</span></div></div><button class="row-act" data-act="forget-search" data-sk="${esc(s.k)}" data-skey="${esc(s.key)}" aria-label="Remove">${ic('close', 'md')}</button></div>`).join('')}<div class="sheet-foot"><button class="btn ghost" data-act="clear-searches">Clear recent searches</button></div>`;
  }
  input.addEventListener('input', debounce(run, 110));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  clear.addEventListener('click', e => { e.preventDefault(); input.value = ''; run(); input.focus(); });
  chips.addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { st.f = b.dataset.f; run(); pg.el.scrollTop = 0; } });
  body.addEventListener('touchstart', () => input.blur(), { passive: true });
  pg.rerunSearch = run;
  run();
  if (!st.q) { if (pg.el.hidden) pg.afterShow = () => input.focus(); else input.focus(); }
};
function searchResults(pg, res, f, q) {
  const songsCtx = pageCtx(pg, 'search', q, `Search: ${q}`, res.songs);
  const artistIt = res.artists.map(id => itArtist(L.artists[id])), albumIt = res.albums.map(id => itAlbum(L.albums[id]));
  const plIt = res.playlists.map(itSearchPl).filter(Boolean);
  const none = emptyHtml('search', `No results for “${q}”`, 'Check the spelling, or try fewer or different keywords.');
  if (f === 'songs') return res.songs.length ? trackList(songsCtx) : none;
  if (f === 'artists') return artistIt.length ? artistIt.map(it => rowHtml(it)).join('') : none;
  if (f === 'albums') return albumIt.length ? albumIt.map(it => rowHtml(it, true)).join('') : none;
  if (f === 'playlists') return plIt.length ? plIt.map(it => rowHtml(it, true)).join('') : none;
  if (!res.top) return none;
  let h = '';
  const top = res.top;
  if (top.k === 'artist') { const ar = L.artists[top.id]; h += `<div class="top-res circle" data-act="open" data-k="artist" data-id="${ar.id}"><div class="row-art">${img(coverUrl(ar.cover))}</div><div><div class="t">${esc(ar.name)}</div><div class="s">Artist • ${count(ar.trackIds.length, 'song')}</div></div></div>`; }
  else if (top.k === 'album') { const al = L.albums[top.id]; h += `<div class="top-res" data-act="open" data-k="album" data-id="${al.id}"><div class="row-art">${img(coverUrl(al.cover))}</div><div><div class="t">${esc(al.title)}</div><div class="s">${al.type} • ${esc(albumArtist(al))}</div></div></div>`; }
  else { const t = L.tracks[top.id]; h += `<div class="top-res" data-act="open" data-k="track" data-id="${t.id}"><div class="row-art">${img(coverUrl(t.rel))}</div><div><div class="t">${esc(t.title)}</div><div class="s">Song • ${esc(t.artist)}</div></div></div>`; }
  if (res.songs.length) h += `<div class="sec-h"><h2>Songs</h2>${res.songs.length > 5 ? '<button class="more" data-act="find-filter" data-f="songs">Show all</button>' : ''}</div>` + trackList(songsCtx, { limit: 5 });
  if (artistIt.length) h += `<div class="sec-h"><h2>Artists</h2>${artistIt.length > 4 ? '<button class="more" data-act="find-filter" data-f="artists">Show all</button>' : ''}</div>` + artistIt.slice(0, 4).map(it => rowHtml(it)).join('');
  if (albumIt.length) h += `<div class="sec-h"><h2>Albums</h2>${albumIt.length > 4 ? '<button class="more" data-act="find-filter" data-f="albums">Show all</button>' : ''}</div>` + albumIt.slice(0, 4).map(it => rowHtml(it, true)).join('');
  if (plIt.length) h += `<div class="sec-h"><h2>Playlists</h2></div>` + plIt.slice(0, 4).map(it => rowHtml(it, true)).join('');
  return h;
}

/* Your Library */
const LIB_FILTERS = [['playlists', 'Playlists'], ['artists', 'Artists'], ['albums', 'Albums'], ['downloaded', 'Downloaded']];
const SORTS = { recent: 'Recents', added: 'Recently added', alpha: 'Alphabetical' };
VIEWS.library = pg => {
  const st = pg.state || (pg.state = { f: '', q: '', searching: false });
  const chips = (st.f ? `<button class="chip x" data-act="lib-filter" data-f="" aria-label="Clear filter">${ic('close', 'sm')}</button>` : '')
    + LIB_FILTERS.filter(([id]) => !st.f || id === st.f).map(([id, l]) => `<button class="chip${st.f === id ? ' on' : ''}" data-act="lib-filter" data-f="${id}">${l}</button>`).join('');
  pg.el.innerHTML = `<div class="lib-top"><header class="root-h">${avatarBtn()}<h1>Your Library</h1><button class="hb" data-act="lib-search" aria-label="Search Your Library">${ic('search')}</button><button class="hb" data-act="new-playlist" aria-label="Create playlist">${ic('plus')}</button></header>${st.searching ? `<div class="filter-in">${ic('search')}<input type="search" placeholder="Search Your Library" value="${esc(st.q)}" autocomplete="off" aria-label="Search Your Library"></div>` : ''}<div class="chips">${chips}</div><div class="lib-bar"><button data-act="lib-sort">${ic('sort', 'sm')}${SORTS[S.libSort]}</button><button class="ib" data-act="lib-view" aria-label="${S.libView === 'grid' ? 'List view' : 'Grid view'}">${ic(S.libView === 'grid' ? 'list' : 'grid', 'md')}</button></div></div><div class="lib-list"></div>`;
  const list = pg.el.querySelector('.lib-list');
  const draw = () => {
    if (!L.ready) { list.innerHTML = '<div class="rows">' + '<div class="row"><div class="row-art sk"></div><div class="meta"><div class="sk" style="height:14px;width:60%"></div></div></div>'.repeat(6) + '</div>'; return; }
    const items = libItems(st.f, st.q, S.libSort);
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = emptyHtml('lib', st.q ? 'No matches' : 'Nothing here yet', st.q ? 'Try a different search.' : 'Follow artists, save albums and create playlists to fill Your Library.'); return; }
    const box = document.createElement('div');
    box.className = S.libView === 'grid' ? 'lib-grid' : 'rows';
    list.appendChild(box);
    chunked(pg, box, items.length, i => S.libView === 'grid' ? cardHtml(items[i]) : rowHtml(items[i], true), 40);
    if (!st.f && !st.q && items.length < 8) {
      const cta = (act, icon, title, sub) => `<div class="row big" ${act}><div class="row-art"><div class="cover-glyph">${ic(icon)}</div></div><div class="meta"><div class="t">${title}</div><div class="s"><span>${sub}</span></div></div></div>`;
      list.insertAdjacentHTML('beforeend', `<div class="rows" style="margin-top:8px">${cta('data-act="new-playlist"', 'plus', 'Create playlist', 'Build your own mix')}${cta('data-act="lib-filter" data-f="artists"', 'person', 'Browse artists', `${nf(L.azArtists.length)} in your library — follow the ones you love`)}${cta('data-act="lib-filter" data-f="albums"', 'album', 'Browse albums', `${nf(L.albums.length)} releases to save`)}</div>`);
    }
  };
  const input = pg.el.querySelector('.filter-in input');
  if (input) {
    input.addEventListener('input', debounce(() => { st.q = input.value; draw(); }, 120));
    if (st.focus) { st.focus = false; input.focus(); }
  }
  draw();
};

/* Detail pages */
function heroHtml({ cover, title, desc, by, sub, xl }) {
  return `<div class="hero"><div class="hero-cover">${cover}</div><h1 class="hero-title${xl ? ' xl' : ''}">${esc(title)}</h1>${desc ? `<div class="hero-desc">${esc(desc)}</div>` : ''}${by || ''}${sub ? `<div class="hero-sub">${sub}</div>` : ''}</div>`;
}
VIEWS.album = pg => {
  const al = L.albumByKey.get(pg.params.key);
  if (!al) { VIEWS.missing(pg); return; }
  const ar = al.artistId >= 0 ? L.artists[al.artistId] : null;
  const ctx = pageCtx(pg, 'album', al.key, al.title, al.trackIds, 'album:' + al.key);
  const saved = U.saved.includes(al.key);
  const by = ar ? `<button class="hero-by" data-act="open" data-k="artist" data-id="${ar.id}">${img(coverUrl(ar.cover))}${esc(ar.name)}</button>` : '<div class="hero-by">Various Artists</div>';
  let h = topbar(al.title, ctx) + '<div class="wash"></div>'
    + heroHtml({ cover: img(coverUrl(al.cover)), title: al.title, by, sub: albumSource(al) ? `${al.type} • Shared by ${albumSource(al)}` : `${al.type} • ${monthYear(al.mtime) ? 'Added ' + monthYear(al.mtime) : ''}` })
    + `<div class="actions"><button class="ib${saved ? ' lit' : ''}" data-act="save-album" data-id="${al.id}" data-save="${al.id}" aria-label="Save to Your Library">${ic(saved ? 'check-c' : 'add')}</button>${dlBtn(ctx)}<button class="ib" data-act="more-ctx" data-k="album" data-id="${al.id}" aria-label="More options">${ic('more-v')}</button><span class="flex1"></span>${shuffleBtn()}${playBtn(ctx)}</div>`
    + trackList(ctx, { num: al.trackIds.length > 1, noArt: false })
    + `<div class="list-foot">${count(al.trackIds.length, 'song')}${al.comp ? ` • ${count(uniq(al.trackIds.map(id => L.tracks[id].artistId)).length, 'artist')}` : ''}</div>`;
  if (ar) {
    const more = ar.albumIds.filter(id => id !== al.id).slice(0, 12).map(id => itAlbum(L.albums[id]));
    h += shelf(`More by ${ar.name}`, more, { more: more.length >= 6 ? `data-act="discog" data-id="${ar.id}"` : '' });
  }
  pg.el.innerHTML = h;
  afterRender(pg);
  paint(pg, al.cover);
};
VIEWS.artist = pg => {
  const ar = L.artistByKey.get(pg.params.key);
  if (!ar || !ar.trackIds.length) { VIEWS.missing(pg); return; }
  const st = pg.state || (pg.state = { more: false });
  const pop = popular(ar, 10);
  const ctx = pageCtx(pg, 'artist', ar.key, ar.name, uniq(pop.concat(ar.albumIds.flatMap(id => L.albums[id].trackIds), ar.trackIds)), 'artist:' + ar.key);
  const following = U.follows.includes(ar.key);
  let h = topbar(ar.name, ctx) + `<div class="art-hero">${img(coverUrl(ar.cover))}<h1 class="art-name">${esc(ar.name)}</h1></div>`
    + `<div class="art-sub">${count(ar.trackIds.length, 'song')} • ${count(ar.albumIds.length, 'release')} in your library</div>`
    + `<div class="actions"><button class="pill-btn${following ? ' on' : ''}" data-act="follow" data-id="${ar.id}" data-follow="${ar.id}">${following ? 'Following' : 'Follow'}</button><button class="ib" data-act="more-ctx" data-k="artist" data-id="${ar.id}" aria-label="More options">${ic('more-v')}</button><span class="flex1"></span>${shuffleBtn()}${playBtn(ctx)}</div>`
    + `<div class="sec-h"><h2>Popular</h2></div><div class="rows" data-ctx="${ctx.rid}">${pop.slice(0, st.more ? 10 : 5).map((id, i) => trackRow(L.tracks[id], i, { num: true, sub: L.tracks[id].artist === ar.name ? albumOf(L.tracks[id]).title : L.tracks[id].artist })).join('')}</div>`
    + (pop.length > 5 ? `<button class="see-more" data-act="artist-more">${st.more ? 'Show less' : 'See more'}</button>` : '');
  const likedN = ar.trackIds.filter(id => U.likedSet.has(L.tracks[id].rel)).length;
  if (likedN) h += `<div class="sec-h"><h2>Liked songs</h2></div><div class="liked-by" data-act="open" data-k="liked"><div class="row-art" style="overflow:visible">${img(coverUrl(ar.cover))}<span class="heart-dot">${ic('heart-f')}</span></div><div class="meta"><div class="t">You've liked ${count(likedN, 'song')}</div><div class="s"><span>By ${esc(ar.name)}</span></div></div></div>`;
  const rel = ar.albumIds.slice().sort((a, b) => popScore(b) - popScore(a)).slice(0, 4);
  if (rel.length) h += `<div class="sec-h"><h2>Popular releases</h2></div>${rel.map(id => rowHtml({ ...itAlbum(L.albums[id]), sub: `${L.albums[id].type} • ${count(L.albums[id].trackIds.length, 'song')}` }, true)).join('')}${ar.albumIds.length > 4 ? `<button class="see-more" data-act="discog" data-id="${ar.id}">See discography</button>` : ''}`;
  const extras = [];
  const feat = getMix('feat:' + ar.key);
  if (feat) extras.push(itMix(feat));
  const radio = getMix('artist-radio:' + ar.key);
  if (radio) extras.push(itMix(radio));
  h += shelf(`Featuring ${ar.name}`, extras);
  h += shelf('Fans also like', relatedArtists(ar, 12).map(itArtist));
  h += shelf('Appears on', [...ar.compIds].map(id => itAlbum(L.albums[id])));
  pg.el.innerHTML = h;
  paint(pg, ar.cover);
  function popScore(id) { return L.albums[id].trackIds.reduce((s, t) => s + (U.plays.get(L.tracks[t].rel) || 0), 0) * 10 + L.albums[id].trackIds.length / 4 + L.albums[id].mtime / (ar.mtime || 1); }
};
VIEWS.discog = pg => {
  const ar = L.artistByKey.get(pg.params.key);
  if (!ar) { VIEWS.missing(pg); return; }
  const st = pg.state || (pg.state = { f: 'all' });
  const groups = { all: ar.albumIds, albums: ar.albumIds.filter(id => L.albums[id].type === 'Album'), singles: ar.albumIds.filter(id => ['Single', 'EP'].includes(L.albums[id].type)), comps: [...ar.compIds] };
  const ids = groups[st.f] || groups.all;
  pg.el.innerHTML = topbar('Discography') + `<div class="hero" style="padding-bottom:4px"><h1 class="hero-title">${esc(ar.name)}</h1><div class="hero-sub">Discography</div></div><div class="chips">${[['all', 'All'], ['albums', 'Albums'], ['singles', 'Singles and EPs'], ['comps', 'Appears on']].filter(([k]) => groups[k].length).map(([k, l]) => `<button class="chip${st.f === k ? ' on' : ''}" data-act="discog-filter" data-f="${k}">${l}</button>`).join('')}</div><div class="rows"></div>`;
  chunked(pg, pg.el.querySelector('.rows'), ids.length, i => { const al = L.albums[ids[i]]; return rowHtml({ ...itAlbum(al), sub: `${al.type} • ${count(al.trackIds.length, 'song')}${al.mtime ? ' • ' + monthYear(al.mtime) : ''}` }, true); });
};
VIEWS.playlist = pg => {
  const name = pg.params.name, rels = U.playlists[name];
  if (!rels) { VIEWS.missing(pg); return; }
  const st = pg.state || (pg.state = { edit: false });
  const ids = rels.map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  const ctx = pageCtx(pg, 'playlist', name, name, ids, 'playlist:' + name);
  ctx.plName = name;
  const by = `<div class="hero-by">${avatarHtml()}${esc(U.name || 'You')}</div>`;
  let h = topbar(name, ctx) + '<div class="wash"></div>' + heroHtml({ cover: plCover(rels), title: name, by, sub: count(ids.length, 'song') });
  h += `<div class="actions">${dlBtn(ctx)}<button class="ib" data-act="pl-add" aria-label="Add songs">${ic('pl-add')}</button><button class="ib${st.edit ? ' lit' : ''}" data-act="pl-edit" aria-label="Edit playlist">${ic('edit')}</button><button class="ib" data-act="more-ctx" data-k="playlist" data-id="${esc(name)}" aria-label="More options">${ic('more-v')}</button><span class="flex1"></span>${st.edit ? '<button class="btn light" data-act="pl-edit">Done</button>' : shuffleBtn() + playBtn(ctx)}</div>`;
  if (!ids.length) h += emptyHtml('note', "Let's start building your playlist", 'Find songs you love and add them here.', '<button class="btn light" data-act="pl-add">Add to this playlist</button>');
  else if (st.edit) h += `<div class="rows" data-ctx="${ctx.rid}" data-sortable>${ids.map((id, i) => trackRow(L.tracks[id], i, { drag: true, tail: `<button class="row-act" data-act="pl-remove" data-t="${id}" aria-label="Remove">${ic('minus-c', 'md')}</button>` })).join('')}</div>`;
  else h += trackList(ctx);
  if (ids.length && !st.edit) {
    const rec = uniq(ids.slice(-6).flatMap(id => radioIds(id, 10).slice(1))).filter(id => !rels.includes(L.tracks[id].rel)).slice(0, 10);
    if (rec.length) h += `<div class="sec-h"><div><h2>Recommended songs</h2><div class="kicker" style="margin-top:4px">Based on what's in this playlist</div></div></div><div class="rows">${rec.map((id, i) => trackRow(L.tracks[id], i, { tail: `<button class="row-act" data-act="pl-add-one" data-t="${id}" aria-label="Add">${ic('add', 'md')}</button>` })).join('')}</div>`;
  }
  pg.el.innerHTML = h;
  afterRender(pg);
  if (ids.length) paint(pg, L.tracks[ids[0]].rel);
  const sortable = pg.el.querySelector('[data-sortable]');
  if (sortable) dragSort(sortable, '.trk', '.page', (from, to) => { reorderPlaylist(name, ids, from, to); renderPage(pg, true); });
};
VIEWS.liked = pg => {
  const st = pg.state || (pg.state = { q: '', sort: 'recent' });
  const all = U.liked.slice().reverse().map(r => L.byRel.get(r)).filter(Boolean);
  if (st.sort === 'title') all.sort((a, b) => collator.compare(a.title, b.title));
  if (st.sort === 'artist') all.sort((a, b) => collator.compare(a.artist, b.artist));
  if (st.sort === 'album') all.sort((a, b) => collator.compare(albumOf(a).title, albumOf(b).title));
  const allCtx = pageCtx(pg, 'liked', '', 'Liked Songs', all.map(t => t.id), 'liked');
  const ctx = pageCtx(pg, 'liked', '', 'Liked Songs', [], 'liked');   // the filtered view you tap into
  pg.el.classList.add('liked-page');
  let h = topbar('Liked Songs', allCtx) + '<div class="wash"></div>' + heroHtml({ cover: `<div class="cover-glyph liked-art">${ic('heart-f')}</div>`, title: 'Liked Songs', sub: count(all.length, 'song') })
    + `<div class="actions">${dlBtn(allCtx)}<button class="ib" data-act="liked-sort" aria-label="Sort">${ic('sort')}</button><span class="flex1"></span>${shuffleBtn()}${playBtn(allCtx)}</div>`;
  if (all.length > 8) h += `<div class="filter-in">${ic('search')}<input type="search" placeholder="Find in Liked Songs" value="${esc(st.q)}" autocomplete="off" aria-label="Find in Liked Songs"></div>`;
  h += `<div class="rows" data-ctx="${ctx.rid}"></div>`;
  if (!all.length) h += emptyHtml('heart', 'Songs you like will appear here', 'Save songs by tapping the heart icon.');
  pg.el.innerHTML = h;
  const list = pg.el.querySelector('.rows');
  let dispose = null;
  const draw = () => {
    const nq = norm(st.q.trim());
    const ts = nq ? all.filter(t => t.s.includes(nq)) : all;
    ctx.ids = ts.map(t => t.id);
    if (dispose) dispose();
    list.innerHTML = nq && !ts.length ? `<p class="list-foot">No liked songs match “${esc(st.q)}”.</p>` : '';
    dispose = chunked(pg, list, ts.length, i => trackRow(ts[i], i));
  };
  draw();
  afterRender(pg);
  const input = pg.el.querySelector('.filter-in input');
  if (input) input.addEventListener('input', debounce(() => { st.q = input.value; draw(); }, 120));
};
VIEWS.mix = pg => {
  const m = getMix(pg.params.id);
  if (!m) { VIEWS.missing(pg); return; }
  const ctx = pageCtx(pg, 'mix', m.id, m.name, m.ids.filter(id => L.tracks[id]), 'mix:' + m.id);
  let h = topbar(m.name, ctx) + '<div class="wash"></div>' + heroHtml({ cover: mixCover(m), title: m.name, desc: m.desc, sub: `Made for ${esc(U.name || 'you')} • ${count(ctx.ids.length, 'song')}` })
    + `<div class="actions"><button class="ib" data-act="mix-save" data-id="${esc(m.id)}" aria-label="Save as playlist">${ic('add')}</button>${dlBtn(ctx)}<button class="ib" data-act="more-ctx" data-k="mix" data-id="${esc(m.id)}" aria-label="More options">${ic('more-v')}</button><span class="flex1"></span>${shuffleBtn()}${playBtn(ctx)}</div>`
    + `<div class="rows" data-ctx="${ctx.rid}"></div>`;
  pg.el.innerHTML = h;
  chunked(pg, pg.el.querySelector('.rows'), ctx.ids.length, i => trackRow(L.tracks[ctx.ids[i]], i));
  afterRender(pg);
  if (S.dynColor) {
    const n = parseInt(m.cover.m1.slice(1), 16);
    pg.el.style.setProperty('--c', tone([n >> 16, (n >> 8) & 255, n & 255], .3, .25));
  }
};
VIEWS.downloads = pg => {
  const ts = [...Off.set].map(r => L.byRel.get(r)).filter(Boolean).sort((a, b) => collator.compare(a.artist, b.artist) || a.albumId - b.albumId || a.no - b.no);
  const ctx = pageCtx(pg, 'list', 'downloads', 'Downloads', ts.map(t => t.id), 'downloads');
  const busy = Off.queue.length + Off.active.size;
  let h = topbar('Downloads', ctx) + '<div class="wash" style="--c:13,107,59"></div>'
    + heroHtml({ cover: `<div class="cover-glyph dl-art">${ic('dl-f')}</div>`, title: 'Downloads', sub: `${count(ts.length, 'song')} available offline${busy ? ` • ${busy} downloading` : ''}` })
    + `<div class="storage-bar"><i id="st-used" style="width:0"></i></div><div class="storage-leg"><span id="st-txt">Checking storage…</span></div>`
    + `<div class="actions">${busy ? '<button class="pill-btn" data-act="dl-cancel-all">Cancel downloads</button>' : ''}${ts.length ? '<button class="pill-btn" data-act="dl-remove-all">Remove all</button>' : ''}<span class="flex1"></span>${ts.length ? shuffleBtn() + playBtn(ctx) : ''}</div>`;
  if (!ts.length) h += emptyHtml('dl', 'No downloads yet', 'Tap the download button on any album or playlist to listen without a connection.');
  h += '<div class="rows" data-ctx="' + ctx.rid + '"></div>';
  pg.el.innerHTML = h;
  chunked(pg, pg.el.querySelector('.rows'), ts.length, i => trackRow(ts[i], i));
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => {
    const u = e.usage || 0, q = e.quota || 1;
    const bar = pg.el.querySelector('#st-used'), txt = pg.el.querySelector('#st-txt');
    if (bar) bar.style.width = clamp(u / q * 100, 1, 100) + '%';
    if (txt) txt.textContent = `${(u / 1e9).toFixed(2)} GB used of ${(q / 1e9).toFixed(0)} GB available to this app`;
  }).catch(() => {});
};
VIEWS.list = pg => {
  const kind = pg.params.kind;
  const defs = {
    'recent-albums': ['Recently added', () => L.newestAlbums.map(id => itAlbum(L.albums[id]))],
    singles: ['Singles & EPs', () => L.newestAlbums.filter(id => ['Single', 'EP'].includes(L.albums[id].type)).map(id => itAlbum(L.albums[id]))],
    comps: ['Compilations & DJ mixes', () => L.newestAlbums.filter(id => L.albums[id].comp || COMP_RE.test(L.albums[id].name)).map(id => itAlbum(L.albums[id]))],
    artists: ['All artists', () => L.azArtists.map(id => itArtist(L.artists[id]))],
    albums: ['All albums', () => L.azAlbums.map(id => itAlbum(L.albums[id]))],
    mixes: ['Made for you', () => buildMixes().map(itMix)],
  };
  const d = defs[kind];
  if (!d) { VIEWS.missing(pg); return; }
  const items = d[1]();
  const grid = kind === 'mixes';
  pg.el.innerHTML = topbar(d[0]) + `<div class="hero" style="padding-bottom:6px"><h1 class="hero-title">${esc(d[0])}</h1><div class="hero-sub">${nf(items.length)} items</div></div><div class="${grid ? 'lib-grid' : 'rows'}"></div>`;
  chunked(pg, pg.el.querySelector(grid ? '.lib-grid' : '.rows'), items.length, i => grid ? cardHtml(items[i]) : rowHtml(items[i], true), 50);
};

/* Settings, equaliser & profile */
const setRow = ({ act, title, sub, val, tog, chev, danger, attrs: extra = '' }) => `<div class="set-row" ${act ? `data-act="${act}"` : ''} ${extra} role="button"><div class="meta"><div class="t"${danger ? ' style="color:var(--danger)"' : ''}>${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>${val != null ? `<span class="val"${val.attr || ''}>${esc(val.text != null ? val.text : val)}</span>` : ''}${tog != null ? `<span class="tog${tog ? ' on' : ''}" role="switch" aria-checked="${!!tog}"></span>` : ''}${chev ? ic('back', 'chev') : ''}</div>`;
VIEWS.settings = pg => {
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim().toLowerCase();
  const eqLabel = S.eqOn ? (EQ_PRESETS[S.eqPreset] ? EQ_PRESETS[S.eqPreset][0] : 'Custom') : 'Off';
  let h = topbar('Settings') + `<div class="hero" style="padding-bottom:0"><h1 class="hero-title">Settings</h1></div>`;
  h += `<div class="set-sec">Account</div><div class="set-row" data-act="nav" data-view="profile">${avatarHtml()}<div class="meta"><div class="t">${esc(U.token ? U.name || U.username : 'Not logged in')}</div><div class="s">${U.token ? 'View profile' : 'Log in to sync likes, playlists and history'}</div></div>${ic('back', 'chev')}</div>`;
  if (U.token && !U.passwordLogin) h += setRow({ act: 'change-pw', title: 'Set a password', sub: 'You sign in with Discord. Add a password to sign in without it too.', chev: true });
  if (U.token) h += setRow({ act: 'devices-signed', title: 'Signed-in devices', sub: "Sign out devices you don't use", chev: true })
    + setRow({ act: 'export-data', title: 'Download your data', sub: 'Your profile, likes, playlists and history', chev: true })
    + setRow({ act: 'delete-account', title: 'Delete account', sub: 'Permanently remove your account', chev: true });
  if (U.token && (featOn('discord_login') || featOn('discord_presence'))) {
    h += `<div class="set-sec">Discord</div>`
      + (featOn('discord_login') ? setRow({ act: U.discord ? 'discord-unlink' : 'discord-link', title: U.discord ? `Connected as @${U.discord.username}` : 'Connect Discord', sub: U.discord ? 'Tap to disconnect' : 'Sign in with Discord too', chev: true }) : '')
      + (featOn('discord_presence') ? setRow({ act: 'presence-setup', title: 'Show what I play on Discord', sub: U.presence ? 'On, using the helper on your computer' : 'Needs a small helper on your computer', chev: true }) : '');
  }
  if (socialOn()) {
    const ss = Social.me.settings || {};
    h += `<div class="set-sec">Friends</div>`
      + setRow({ act: 'set-share-activity', title: 'Share what I listen to', sub: 'Friends see what you play and played recently', tog: ss.share_activity !== false })
      + setRow({ act: 'set-discoverable', title: 'Let people find me by name', sub: 'When off, only your exact username finds you', tog: ss.discoverable !== false })
      + setRow({ act: 'blocked-list', title: 'Blocked people', sub: count((Social.me.blocked || []).length, 'person', 'people') + ' blocked', chev: true });
  }
  if (chatOn()) {
    const labels = { ready: 'On for this phone', none: 'Not turned on yet', locked: 'Locked on this phone', unsupported: 'Needs an HTTPS connection', off: '…' };
    h += `<div class="set-sec">Private messages</div>`
      + setRow({ act: 'nav', attrs: 'data-view="messages"', title: 'End-to-end encryption', sub: labels[E2EE.state] || '', chev: true })
      + (E2EE.state === 'ready' ? setRow({ act: 'rk-show', title: 'Recovery key', sub: 'Unlocks your messages on a new device', chev: true }) + setRow({ act: 'rk-new', title: 'Make a new recovery key', sub: 'The old one stops working', chev: true }) : '')
      + (E2EE.state === 'ready' || E2EE.state === 'locked' ? setRow({ act: 'e2ee-reset', title: 'Reset private messages', sub: "Earlier messages can't be read afterwards", danger: true }) : '');
  }
  if (U.token && SITE.features && (SITE.features.subsonic || SITE.features.scrobbling)) h += `<div class="set-sec">Other apps</div>`
    + (SITE.features.scrobbling ? setRow({ act: 'scrobbling', title: 'Scrobbling', sub: 'ListenBrainz or Last.fm', chev: true }) : '')
    + (SITE.features.subsonic ? setRow({ act: 'subsonic', title: 'Subsonic-compatible apps', sub: 'Symfonium, Substreamer, play:Sub and more', chev: true }) : '');
  h += `<div class="set-sec">Playback</div>`
    + setRow({ act: 'set-autoplay', title: 'Autoplay', sub: 'Keep listening to similar songs when your music ends', tog: S.autoplay })
    + (feat('smart') ? setRow({ act: 'set-smart', title: 'Smart transitions', sub: 'Skip silence between songs and let albums flow', tog: S.smart !== false })
      + (IOS ? '' : setRow({ act: 'set-matchvol', title: 'Match volume between songs', sub: 'Bring loud recordings down to the level of the rest', tog: !!S.matchVol })) : '')
    + setRow({ act: 'sleep', title: 'Sleep timer', sub: 'Pause playback after a set time', val: { text: sleepLabel(), attr: ' data-sleep-val' } })
    + setRow({ act: 'devices', title: 'Connect to a device', sub: 'Move playback between your phones and computers', chev: true });
  h += `<div class="set-sec">Audio</div>`
    + (SITE.features && SITE.features.transcoding
      ? setRow({ act: 'quality', attrs: 'data-cell=""', title: 'Streaming quality on Wi-Fi', sub: 'Downloads are always lossless', val: QUALITIES[S.quality] || QUALITIES.original, chev: true })
        + setRow({ act: 'quality', attrs: 'data-cell="1"', title: 'Streaming quality on mobile data', sub: 'Smaller streams save data and start faster', val: S.cellQuality ? QUALITIES[S.cellQuality] : 'Same as Wi-Fi', chev: true })
      : '')
    + setRow({ act: 'nav', attrs: 'data-view="eq"', title: 'Equalizer', sub: 'Fine-tune the sound with presets or your own curve', val: eqLabel, chev: true })
    + setRow({ act: 'set-boost', title: 'Volume boost', sub: 'Louder output for quiet tracks or weak speakers', val: Math.round(S.boost * 100) + '%' })
    + setRow({ act: 'set-normalize', title: 'Volume normalization', sub: 'Even out loudness between songs', tog: S.normalize });
  h += `<div class="set-sec">Appearance</div><div class="swatches">${ACCENTS.map(c => `<button class="sw${c === accent ? ' on' : ''}" style="background:${c}" data-act="set-accent" data-c="${c}" aria-label="Accent ${c}"></button>`).join('')}<label class="sw custom" aria-label="Custom colour"><input type="color" value="${/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1ed760'}"></label></div>`
    + setRow({ act: 'set-dyncolor', title: 'Colourful pages', sub: 'Tint pages and the player with album artwork colours', tog: S.dynColor });
  h += `<div class="set-sec">Storage</div>`
    + setRow({ act: 'nav', attrs: 'data-view="downloads"', title: 'Downloads', sub: `${count(Off.set.size, 'song')} saved for offline listening`, chev: true })
    + setRow({ act: 'dl-remove-all', title: 'Remove all downloads', danger: true })
    + setRow({ act: 'clear-cache', title: 'Clear cached data', sub: 'Refetch the library and artwork colours. Downloads are kept.' });
  h += `<div class="set-sec">About</div>`
    + setRow({ act: 'rename-device', title: 'Device name', sub: 'How this phone appears in Connect', val: Connect.name })
    + setRow({ title: 'Library', val: `${nf(L.tracks.length)} songs` })
    + setRow({ title: 'Version', val: `Axdio ${SITE.app_version || '—'}` })
    + setRow({ act: 'desktop-site', title: 'Switch to desktop site', chev: true });
  if (U.token) h += `<div class="sheet-foot" style="padding-top:28px"><button class="btn light" data-act="logout">Log out</button></div>`;
  h += `<a class="set-credit" href="${esc(CREDIT.url)}" target="_blank" rel="noopener">${esc(CREDIT.text)}</a>`;
  pg.el.innerHTML = h;
  const color = pg.el.querySelector('input[type=color]');
  color.addEventListener('change', () => setAccent(color.value));
};
VIEWS.eq = pg => {
  pg.el.innerHTML = topbar('Equalizer') + `<div class="hero" style="padding-bottom:4px"><h1 class="hero-title">Equalizer</h1></div>`
    + setRow({ act: 'eq-toggle', title: 'Equalizer', sub: 'Applies to everything you play on this device', tog: S.eqOn })
    + `<div class="chips">${Object.entries(EQ_PRESETS).map(([k, [l]]) => `<button class="chip${S.eqPreset === k ? ' on' : ''}" data-act="eq-preset" data-p="${k}">${l}</button>`).join('')}${S.eqPreset === 'custom' ? '<button class="chip on">Custom</button>' : ''}</div>`
    + `<div class="eq-wrap${S.eqOn ? '' : ' disabled'}"><svg class="eq-svg" viewBox="0 0 320 190" preserveAspectRatio="none"></svg><div class="eq-labels">${EQ_BANDS.map(f => `<span>${f >= 1000 ? f / 1000 + 'k' : f}</span>`).join('')}</div></div>`
    + `<p class="list-foot">Drag the points to shape the sound. Effects use Web Audio, which can interrupt background playback on some iPhones.</p>`
    + `<div class="set-sec">Volume boost</div><div class="seg">${[1, 1.5, 2, 3, 4, 6].map(v => `<button class="${S.boost === v ? 'on' : ''}" data-act="boost" data-v="${v}">${v * 100}%</button>`).join('')}</div>`
    + setRow({ act: 'set-normalize', title: 'Volume normalization', sub: 'Even out loudness between songs', tog: S.normalize });
  const svg = pg.el.querySelector('.eq-svg');
  const W = 320, Hh = 190, pad = 16, xs = EQ_BANDS.map((_, i) => pad + i * (W - 2 * pad) / (EQ_BANDS.length - 1));
  const yOf = g => Hh / 2 - g / 12 * (Hh / 2 - 14);
  const draw = () => {
    const pts = S.eq.map((g, i) => [xs[i], yOf(g)]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
    }
    svg.innerHTML = [0, .25, .5, .75, 1].map(f => `<line class="grid${f === .5 ? ' zero' : ''}" x1="0" x2="${W}" y1="${14 + f * (Hh - 28)}" y2="${14 + f * (Hh - 28)}"/>`).join('')
      + `<path class="area" d="${d} L${xs[xs.length - 1]},${Hh} L${xs[0]},${Hh} Z"/><path class="curve" d="${d}"/>`
      + pts.map(p => `<circle class="knob" cx="${p[0]}" cy="${p[1]}" r="9"/>`).join('');
  };
  draw();
  let band = -1;
  const setFrom = e => {
    const r = svg.getBoundingClientRect(), y = (e.clientY - r.top) / r.height * Hh;
    setEqBand(band, Math.round(clamp((Hh / 2 - y) / (Hh / 2 - 14) * 12, -12, 12) * 2) / 2);
    draw();
  };
  svg.addEventListener('pointerdown', e => {
    if (!S.eqOn) return;
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    band = xs.reduce((b, v, i) => Math.abs(v - x) < Math.abs(xs[b] - x) ? i : b, 0);
    svg.setPointerCapture(e.pointerId);
    $$('[data-act="eq-preset"]', pg.el).forEach(b => b.classList.remove('on'));
    setFrom(e);
  });
  svg.addEventListener('pointermove', e => { if (band >= 0) setFrom(e); });
  const end = () => { if (band >= 0) { band = -1; saveS(); } };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
};
VIEWS.profile = pg => {
  if (!U.token) {
    const reg = SITE.registration || 'open';
    const st = pg.state || (pg.state = { mode: (pg.params && pg.params.mode) || 'login' });
    if (reg === 'closed') st.mode = 'login';
    const r = st.mode === 'register';
    pg.el.innerHTML = topbar('Account') + `<div class="prof-hero">${avatarHtml('lg')}<h1>${r ? 'Create your account' : 'Welcome back'}</h1><div class="muted">${r && reg === 'invite' ? 'Sign-ups here need an invite code from the admin.' : 'Sync liked songs, playlists and history across devices.'}</div></div>`
      + `<div class="auth-card">${reg !== 'closed' ? `<div class="seg" style="margin:0 0 6px"><button class="${r ? '' : 'on'}" data-act="auth-mode" data-m="login">Log in</button><button class="${r ? 'on' : ''}" data-act="auth-mode" data-m="register">Sign up</button></div>` : ''}${discordButton(r ? 'Sign up with Discord' : 'Continue with Discord')}`
      + `<form id="auth-form" novalidate>${r ? '<label class="lbl" for="au-name">Display name</label><input class="input" id="au-name" autocomplete="nickname">' : ''}<label class="lbl" for="au-user">Username</label><input class="input" id="au-user" autocomplete="username" autocapitalize="off" spellcheck="false" required><label class="lbl" for="au-pass">Password</label><input class="input" id="au-pass" type="password" autocomplete="${r ? 'new-password' : 'current-password'}" required>`
      + (r && reg === 'invite' ? `<label class="lbl" for="au-invite">Invite code</label><input class="input" id="au-invite" value="${esc(pendingInvite())}" autocapitalize="characters" spellcheck="false" placeholder="ABCD-1234">` : '')
      + `<div class="form-err" id="au-err" role="alert"></div><button class="btn primary block" type="submit">${r ? 'Sign up' : 'Log in'}</button></form>`
      + (reg === 'closed' ? '<p class="muted" style="margin-top:14px;font-size:13px;text-align:center">Accounts on this server are created by the admin.</p>' : '') + '</div>';
    const form = pg.el.querySelector('#auth-form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const u = form.querySelector('#au-user').value.trim(), p = form.querySelector('#au-pass').value, n = form.querySelector('#au-name'), inv = form.querySelector('#au-invite');
      const err = form.querySelector('#au-err'), btn = form.querySelector('button[type=submit]');
      if (!u || !p) { err.textContent = 'Enter your username and password.'; return; }
      if (r && p.length < minPassword()) { err.textContent = `Use at least ${minPassword()} characters for your password.`; return; }
      btn.disabled = true; err.textContent = '';
      try {
        const who = await signIn(u, p, r, n ? n.value.trim() : '', inv ? inv.value.trim().toUpperCase() : undefined);
        toast(`Welcome, ${who}!`);
        refreshAll();
        Social.start();
        if (window.AX.Party) window.AX.Party.start();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    return;
  }
  const plays = U.history.reduce((s, h) => s + h.count, 0);
  let h = topbar(U.name || U.username) + `<div class="wash"></div><div class="prof-hero">${feat('avatars') ? `<button class="prof-av" data-act="edit-profile" aria-label="Edit profile">${avatarHtml('lg')}</button>` : avatarHtml('lg')}<h1>${esc(U.name || U.username)}</h1><div class="muted">@${esc(U.username)}</div>`
    + `<div class="prof-stats"><div><b>${nf(Object.keys(U.playlists).length)}</b><span>PLAYLISTS</span></div><div><b>${nf(U.liked.length)}</b><span>LIKED</span></div><div><b>${nf(U.follows.length)}</b><span>FOLLOWING</span></div><div><b>${nf(plays)}</b><span>PLAYS</span></div></div>`
    + `<div style="display:flex;gap:10px;margin-top:10px"><button class="pill-btn" data-act="edit-profile">Edit profile</button>${socialOn() ? `<button class="pill-btn soc" data-act="nav" data-view="friends">Friends${(Social.me.friends || []).length ? ' · ' + Social.me.friends.length : ''}<span class="soc-badge" data-b="req"></span></button>` : ''}<button class="pill-btn" data-act="change-pw">Change password</button></div></div>`;
  const tops = topArtists(10);
  h += shelf('Top artists this month', tops.map(itArtist), { kicker: 'Only visible to you' });
  const recentIds = uniq(U.history.map(x => L.byRel.get(x.rel_path)).filter(Boolean).map(t => t.id)).slice(0, 5);
  if (recentIds.length) { const ctx = pageCtx(pg, 'list', 'history', 'Recently played', recentIds); h += `<div class="sec-h"><h2>Recently played</h2><button class="more" data-act="nav" data-view="recent">Show all</button></div>${trackList(ctx)}`; }
  const pls = Object.keys(U.playlists);
  if (pls.length) h += `<div class="sec-h"><h2>Playlists</h2></div>` + pls.map(n => rowHtml(itPlaylist(n), true)).join('');
  const followed = U.follows.map(k => L.artistByKey.get(k)).filter(Boolean);
  h += shelf('Following', followed.map(itArtist));
  h += `<div class="sheet-foot" style="padding-top:28px"><button class="btn light" data-act="logout">Log out</button></div>`;
  pg.el.innerHTML = h;
  // The header takes its colour from the profile photo, else from the top artist.
  if (U.avatar && S.dynColor) dominant(U.avatar).then(c => { if (c) pg.el.style.setProperty('--c', tone(c, .3, .25)); });
  else if (tops[0]) paint(pg, tops[0].cover);
};

/* ======================================================================
   9b. Friends, activity, collaborative playlists & private messages
       (data, polling and encryption live in web/app/social.js)
   ====================================================================== */
const { Social, Chat, E2EE, REACTIONS, attachment, attachTrack, attachAlbum, attachArtist, personAvatar, ago, agoText, previewText, Collab, itCollab } = window.AX;
const socialOn = () => !!U.token && feat('social');
const chatOn = () => socialOn() && feat('chat');
const collabOn = () => socialOn() && feat('collab');
const cardOf = name => Social.cards.get(name) || { username: name, display_name: name, avatar: '' };
const firstName = s => String(s || '').split(' ')[0];
const unreadCount = () => Chat.ready ? Chat.unreadTotal() : (Social.pulse && Social.pulse.unread) || 0;
const chatBtn = () => chatOn() ? `<button class="hb soc" data-act="nav" data-view="messages" aria-label="Messages">${ic('chat')}<span class="soc-badge" data-b="chat"></span></button>` : '';
function socialBadges() {
  const n = unreadCount(), r = (Social.me.incoming || []).length;
  $$('.soc-badge[data-b="chat"]').forEach(b => { b.textContent = n > 99 ? '99+' : n || ''; });
  $$('.soc-badge[data-b="req"]').forEach(b => { b.textContent = r || ''; });
}
const lastUnread = new Map();
function onSocial(what, data) {
  socialBadges();
  const pg = curPage();
  if (what === 'link-request') { linkRequestDialog(data); return; }
  if (what === 'thread') { if (pg && pg.view === 'thread' && pg.params.c === data) updateThread(pg); return; }
  if (what === 'chats') {
    if (!Chat.seenOnce) { Chat.seenOnce = true; Chat.list.forEach(c => lastUnread.set(c.id, c.unread || 0)); }
    else for (const c of Chat.list) {
      if (c.unread > (lastUnread.get(c.id) || 0) && c.preview && !c.preview.mine && !(pg && pg.view === 'thread' && pg.params.c === c.id) && !document.hidden)
        toast(`${Chat.title(c)}: ${previewText(c)}`, { action: 'Open', onAction: () => afterLayers(() => openPage('thread', { c: c.id })) });
      lastUnread.set(c.id, c.unread || 0);
    }
    if (pg && pg.view === 'thread') updateThread(pg);
    markDirty(['messages'], true);
    return;
  }
  const views = { friends: ['friends', 'user', 'profile', 'home', 'settings'], activity: ['home', 'friends'], e2ee: ['messages', 'thread', 'settings'] }[what];
  if (views) markDirty(views, true);
}

/* --- Home: what friends are playing --- */
function friendsShelf() {
  if (!socialOn()) return '';
  if (now() - Social.activityAt > 60000) Social.loadActivity();
  const items = Social.activity.filter(a => a.now && L.byRel.get(a.now.rel)).slice(0, 12);
  if (!items.length) return '';
  return `<div class="sec-h"><h2>Friends are listening to</h2><button class="more" data-act="nav" data-view="friends">See all</button></div><div class="shelf">${items.map(a => {
    const t = L.byRel.get(a.now.rel);
    return `<div class="card fr-card" data-act="fa-play" data-rel="${esc(t.rel)}"><div class="card-img">${img(coverUrl(t.rel))}</div><span class="fr-av">${personAvatar(a)}${a.now.live ? '<i class="live"></i>' : ''}</span><div class="card-t ell">${esc(t.title)}</div><div class="card-s ell">${esc(firstName(a.display_name))} • ${a.now.live ? 'now' : ago(a.now.t * 1000)}</div></div>`;
  }).join('')}</div>`;
}

/* --- Friends --- */
function personRow(c, tail, sub) {
  return `<div class="row pr-row"><div class="pr-hit" data-act="open-user" data-u="${esc(c.username)}">${personAvatar(c, 'pr-av')}<div class="meta"><div class="t">${esc(c.display_name)}</div><div class="s"><span>${sub || '@' + esc(c.username)}</span></div></div></div>${tail || ''}</div>`;
}
function stateTail(c, state) {
  const u = esc(c.username), b = (a, label, cls = 'ghost') => `<button class="btn ${cls} sm" data-act="friend-act" data-a="${a}" data-u="${u}">${label}</button>`;
  if (state === 'friend') return `<button class="row-act" data-act="friend-more" data-u="${u}" aria-label="More">${ic('more-v', 'md')}</button>`;
  if (state === 'incoming') return `<div class="pr-btns">${b('accept', 'Accept', 'light')}<button class="row-act" data-act="friend-act" data-a="decline" data-u="${u}" aria-label="Decline">${ic('close', 'md')}</button></div>`;
  if (state === 'outgoing') return b('cancel', 'Requested');
  if (state === 'blocked') return b('unblock', 'Unblock');
  return b('request', 'Add', 'light');
}
VIEWS.friends = pg => {
  if (!socialOn()) { pg.el.innerHTML = topbar('Friends') + `<div style="padding-top:calc(var(--sat) + 70px)">${emptyHtml('people', 'Friends', U.token ? 'Friends are turned off on this server.' : 'Log in to add friends and see what they play.')}</div>`; return; }
  const st = pg.state || (pg.state = { tab: pg.params.tab || 'friends', q: '', seq: 0 });
  const inc = Social.me.incoming || [], out = Social.me.outgoing || [], friends = Social.friends();
  const tabs = [['friends', 'Friends'], ['requests', `Requests${inc.length ? ' · ' + inc.length : ''}`], ['find', 'Find people']];
  let h = topbar('Friends') + `<div class="hero" style="padding-bottom:4px"><h1 class="hero-title">Friends</h1></div><div class="chips">${tabs.map(([k, l]) => `<button class="chip${st.tab === k ? ' on' : ''}" data-act="fr-tab" data-t="${k}">${l}</button>`).join('')}</div><div class="rows">`;
  if (st.tab === 'friends') {
    const act = new Map(Social.activity.map(a => [a.username, a.now]));
    const parties = new Map(Social.activity.filter(a => a.party).map(a => [a.username, a.party]));
    if (now() - Social.activityAt > 60000) Social.loadActivity();
    h += friends.length ? friends.map(c => { const n = act.get(c.username), t = n && L.byRel.get(n.rel), pty = parties.get(c.username);
      return personRow(c, pty ? `<button class="btn primary sm" data-act="party-join" data-id="${esc(pty.id)}">Join</button>` : stateTail(c, 'friend'),
        pty ? `In ${esc(pty.name)}` : n && t ? `${n.live ? '▶ ' : ''}${esc(t.title)} • ${esc(t.artist)}` : ''); }).join('')
      : emptyHtml('people', 'No friends yet', 'Find people on this server by their name or username.', '<button class="btn light" data-act="fr-tab" data-t="find">Find people</button>');
  } else if (st.tab === 'requests') {
    if (inc.length) h += `<div class="set-sec">Waiting for you</div>` + inc.map(c => personRow(c, stateTail(c, 'incoming'))).join('');
    if (out.length) h += `<div class="set-sec">Sent</div>` + out.map(c => personRow(c, stateTail(c, 'outgoing'))).join('');
    if (!inc.length && !out.length) h += `<p class="list-foot">No requests right now.</p>`;
  } else h += `<div class="filter-in" style="margin:6px 16px 10px">${ic('search')}<input type="search" id="fr-q" placeholder="Name or username" autocomplete="off" autocapitalize="off" value="${esc(st.q)}"></div><div id="fr-res"></div>`;
  pg.el.innerHTML = h + '</div>';
  const q = pg.el.querySelector('#fr-q');
  if (q) {
    const draw = async () => {
      const box = pg.el.querySelector('#fr-res'), s = ++st.seq; st.q = q.value.trim();
      if (st.q.length < 2) { box.innerHTML = '<p class="list-foot">Type at least two letters.</p>'; return; }
      const users = await Social.search(st.q).catch(() => []);
      if (s !== st.seq) return;
      box.innerHTML = users.length ? users.map(c => personRow(c, stateTail(c, c.state))).join('') : '<p class="list-foot">No one found. People can hide from search; you can still find them by their exact username.</p>';
    };
    q.addEventListener('input', debounce(draw, 250));
    draw();
    pg.afterShow = () => q.focus();
  }
};
VIEWS.user = pg => {
  const u = String(pg.params.u || '').toLowerCase();
  if (!socialOn() || !u) { VIEWS.missing(pg); return; }
  pg.el.innerHTML = topbar('') + `<div style="padding-top:calc(var(--sat) + 90px);text-align:center"><span class="spin-sm"></span></div>`;
  Social.profile(u).then(pr => {
    if (!pg.el.isConnected) return;
    const state = pr.state;
    const tops = (pr.top_artists || []).map(n => L.artistByKey.get(String(n).toLowerCase())).filter(a => a && a.trackIds.length);
    const recent = uniq((pr.recent || []).map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id)).slice(0, 10);
    let h = topbar(pr.display_name) + `<div class="wash"></div><div class="prof-hero">${personAvatar(pr, 'lg')}<h1>${esc(pr.display_name)}</h1><div class="muted">@${esc(pr.username)} • ${count(pr.friends || 0, 'friend')}${pr.mutual ? ` • ${count(pr.mutual, 'mutual friend')}` : ''}</div><div style="display:flex;gap:10px;margin-top:14px">`
      + (state === 'friend' ? `<button class="pill-btn on" data-act="friend-more" data-u="${esc(u)}">Friends</button>${chatOn() ? `<button class="pill-btn" data-act="dm" data-u="${esc(u)}">Message</button>` : ''}` : stateTail(pr, state)) + `</div></div>`;
    if (pr.now) { const t = L.byRel.get(pr.now.rel); if (t) h += `<div class="sec-h"><h2>${pr.now.live ? 'Listening now' : 'Last played'}</h2></div><div class="rows">${trackRow(t, 0, { sub: `${t.artist} • ${pr.now.live ? 'now' : agoText(pr.now.t * 1000)}` })}</div>`; }
    if (window.AX.ChatMedia) h += `<div class="axm-blend-wrap">${window.AX.ChatMedia.blendHtml(pr)}</div>`;
    h += shelf('Top artists', tops.map(itArtist), { kicker: 'From their listening' });
    if (recent.length) { const ctx = pageCtx(pg, 'list', 'user:' + u, `${pr.display_name}'s recent songs`, recent); h += `<div class="sec-h"><h2>Recently played</h2></div>${trackList(ctx)}`; }
    const shared = (pr.playlists || []).map(x => Collab.get(x.id)).filter(Boolean);
    if (shared.length) h += `<div class="sec-h"><h2>Playlists you make together</h2></div>` + shared.map(p => rowHtml(itCollab(p), true)).join('');
    if (state !== 'friend' && !pr.now) h += `<p class="list-foot" style="text-align:center">${state === 'outgoing' ? 'Your friend request is waiting.' : `Add ${esc(firstName(pr.display_name))} as a friend to see what they listen to.`}</p>`;
    pg.el.innerHTML = h;
    afterRender(pg);
    if (tops[0]) paint(pg, tops[0].cover);
  }).catch(e => { if (pg.el.isConnected) pg.el.innerHTML = topbar('Profile') + `<div style="padding-top:calc(var(--sat) + 70px)">${emptyHtml('person', "Couldn't open this profile", e.message)}</div>`; });
};
async function friendAct(a, u) {
  try {
    const st = await Social.act(a, u);
    haptic(10);
    toast({ request: st === 'friend' ? "You're now friends" : 'Request sent', accept: "You're now friends", decline: 'Request declined', cancel: 'Request cancelled', remove: 'Friend removed', block: 'Blocked', unblock: 'Unblocked' }[a]);
    const pg = curPage(); if (pg && pg.view === 'friends' && pg.state.tab === 'find') renderPage(pg, true);
  } catch (e) { toast(e.message); }
}
function friendSheet(u) {
  const c = cardOf(u);
  openSheet(sheetHead(personAvatar(c, 'pr-av'), c.display_name, '@' + u) + '<div class="sheet-body">' + si('profile', 'person', 'View profile')
    + (chatOn() ? si('dm', 'chat', 'Message') : '') + (chatOn() && E2EE.state === 'ready' ? si('safety', 'shield', 'Verify security code') : '')
    + si('remove', 'minus-c', 'Remove friend') + si('block', 'block', 'Block', { danger: true }) + '</div>', {
    profile: thenNav(() => openPage('user', { u })),
    dm: (b, close) => close().then(() => openDM(u)),
    safety: (b, close) => close().then(() => safetySheet(u)),
    remove: async (b, close) => { await close(); if (await confirmDlg({ title: `Remove ${c.display_name}?`, text: "You'll stop seeing each other's activity. Chats and shared playlists stay.", ok: 'Remove' })) friendAct('remove', u); },
    block: async (b, close) => { await close(); if (await confirmDlg({ title: `Block ${c.display_name}?`, text: "They won't be able to find you, add you or message you.", ok: 'Block', danger: true })) friendAct('block', u); },
  });
}
async function openDM(u) {
  try { const c = await Chat.dm(u); afterLayers(() => openPage('thread', { c: c.id })); } catch (e) { toast(e.message); }
}

/* --- Private messages --- */
const groupAvatar = c => `<span class="gav">${Chat.others(c).slice(0, 2).map(m => personAvatar(Chat.card(c, m))).join('')}</span>`;
const convAvatar = c => c.kind === 'dm' ? personAvatar(Chat.card(c, Chat.peer(c))) : groupAvatar(c);
function e2eeGate(st) {
  const site = esc(SITE.site_title || 'Axdio');
  if (st === 'unsupported') return `<div class="gate">${ic('lock')}<h1>Private messages need HTTPS</h1><p>Encryption only works on a secure connection. Open ${site} at its https:// address.</p></div>`;
  if (st === 'none') return `<div class="gate">${ic('lock')}<h1>Private messages</h1><p>Chat with friends and send each other music. Messages are end-to-end encrypted: only the people in a conversation can read them. The server and its admins only see scrambled data.</p><button class="btn primary block" data-act="e2ee-setup">Turn on private messages</button></div>`;
  if (st === 'locked') return `<div class="gate">${ic('lock')}<h1>Unlock your messages</h1><p>Private messages are set up on another of your devices. Bring your keys to this phone:</p>
    <button class="gate-opt" data-act="e2ee-link">${ic('devices')}<span><b>Approve from another device</b><small>Confirm a code on a device where messages already work.</small></span></button>
    <button class="gate-opt" data-act="e2ee-unlock">${ic('key')}<span><b>Use your recovery key</b><small>The 32-character key you saved.</small></span></button>
    <button class="gate-reset" data-act="e2ee-reset">Lost both? Start over</button></div>`;
  return `<div class="gate"><span class="spin-sm"></span></div>`;
}
VIEWS.messages = pg => {
  if (!chatOn()) { pg.el.innerHTML = topbar('Messages') + `<div style="padding-top:calc(var(--sat) + 70px)">${emptyHtml('chat', 'Messages', U.token ? 'Messages are turned off on this server.' : 'Log in to message your friends.')}</div>`; return; }
  let h = `<div class="topbar"><button class="tb-btn" data-act="back" aria-label="Back">${ic('back')}</button><div class="tb-title">Messages</div><span class="flex1"></span>${E2EE.state === 'ready' ? `<button class="tb-btn" data-act="new-chat" aria-label="New message">${ic('edit')}</button>` : ''}</div>`;
  if (E2EE.state !== 'ready') { pg.el.innerHTML = h + e2eeGate(E2EE.state); if (E2EE.state === 'off') E2EE.init(); return; }
  if (!Chat.ready) Chat.refresh();
  h += `<div class="hero" style="padding-bottom:8px"><h1 class="hero-title">Messages</h1></div><div class="rows ml">`;
  h += !Chat.ready ? '<div class="row"><div class="row-art sk" style="border-radius:50%"></div><div class="meta"><div class="sk" style="height:14px;width:60%"></div></div></div>'.repeat(4)
    : Chat.list.length ? Chat.list.map(c => `<div class="row ml-row${c.unread ? ' unread' : ''}" data-act="open-chat" data-c="${c.id}"><div class="ml-av">${convAvatar(c)}</div><div class="meta"><div class="t">${esc(Chat.title(c))}</div><div class="s"><span>${esc(previewText(c))}</span></div></div><div class="ml-end"><span class="ml-t">${c.preview ? ago(c.preview.ts) : ''}</span>${c.unread ? `<span class="ml-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div></div>`).join('')
    : emptyHtml('chat', 'No messages yet', 'Messages here are end-to-end encrypted. Start a chat with a friend, or make a group.', '<button class="btn light" data-act="new-chat">New message</button>');
  pg.el.innerHTML = h + '</div>';
};
const dayLabel = ms => { const d = new Date(ms), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1); return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
const timeLabel = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const linkify = s => s.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
function attCard(a) {
  if (a.k === 'missing') return `<div class="att missing">${ic('note')}<div class="att-meta"><b>${esc(a.title || 'Something')}</b><span>${esc(a.sub || '')} • not in this library</span></div></div>`;
  const cover = a.k === 'track' ? img(coverUrl(a.t.rel)) : a.k === 'album' ? img(coverUrl(a.al.cover)) : a.k === 'artist' ? img(coverUrl(a.ar.cover)) : plCover(Collab.rels(a.id));
  return `<div class="att${a.k === 'artist' ? ' round' : ''}" data-act="att-open" data-k="${a.k}" data-id="${esc(a.id)}"><div class="att-art">${cover}</div><div class="att-meta"><b>${esc(a.title)}</b><span>${esc(a.sub)}</span></div><button class="att-play" data-act="att-play" data-k="${a.k}" data-id="${esc(a.id)}" aria-label="Play">${ic('play')}</button></div>`;
}
function reactChips(r) {
  if (!r || !r.size) return '';
  const by = new Map();
  r.forEach((e, u) => { if (!by.has(e)) by.set(e, []); by.get(e).push(u); });
  return `<div class="reacts">${[...by].map(([e, us]) => `<span class="rc${us.includes(U.username) ? ' me' : ''}">${e}${us.length > 1 ? `<small>${us.length}</small>` : ''}</span>`).join('')}</div>`;
}
function msgHtml(c, th, m, grouped) {
  const who = Chat.card(c, m.from);
  let inner;
  if (m.deleted) inner = `<div class="bub gone">${m.mine ? 'You unsent a message' : 'Message unsent'}</div>`;
  else if (m.err) inner = `<div class="bub gone">${ic('lock', 'sm')} This message can't be decrypted</div>`;
  else { const a = attachment(m.body.a), CM = window.AX.ChatMedia; inner = (m.body.f && CM ? CM.html(c.id, m) : '') + (a ? attCard(a) : '') + (m.body.t ? `<div class="bub">${linkify(esc(m.body.t))}</div>` : ''); }
  return `<div class="msg${m.mine ? ' mine' : ''}${grouped ? ' grouped' : ''}" data-m="${m.id}"${m.deleted || m.err ? '' : ` data-sa-msg="1"`}>${m.mine ? '' : grouped ? '<span class="mt-av"></span>' : `<span class="mt-av">${personAvatar(who)}</span>`}<div class="msg-col">${!m.mine && !grouped && c.kind === 'group' ? `<div class="msg-who">${esc(who.display_name)}</div>` : ''}<div class="msg-body">${inner}</div>${reactChips(th.reacts.get(m.id))}${m.trust === 'unknown' && !m.err ? '<span class="unv">Unverified sender</span>' : ''}</div></div>`;
}
function msgsHtml(c, th) {
  if (!th.loaded) return '<div class="mt-loading"><span class="spin-sm"></span></div>';
  let h = th.more ? '<div class="mt-older"><button class="btn ghost sm" data-act="chat-older">Load earlier messages</button></div>'
    : `<div class="mt-start">${convAvatar(c)}<h2>${esc(Chat.title(c))}</h2><p>${ic('lock', 'sm')} End-to-end encrypted. Only ${c.kind === 'dm' ? 'the two of you' : 'people in this group'} can read these messages.</p></div>`;
  let prevFrom = '', prevTs = 0, prevDay = '', lost = 0;
  const flush = () => { if (lost) { h += `<div class="mt-note">${ic('lock', 'sm')} ${count(lost, 'earlier message')} can't be read on this device</div>`; lost = 0; } };
  for (const m of th.msgs) {
    if (m.expires && m.expires <= Date.now()) continue;
    if (m.err === 'keys') { lost++; continue; }
    flush();
    const day = new Date(m.ts).toDateString();
    if (day !== prevDay) { h += `<div class="mt-day">${dayLabel(m.ts)} • ${timeLabel(m.ts)}</div>`; prevDay = day; prevFrom = ''; }
    else if (m.ts - prevTs > 30 * 60e3) { h += `<div class="mt-day">${timeLabel(m.ts)}</div>`; prevFrom = ''; }
    h += msgHtml(c, th, m, m.from === prevFrom && m.ts - prevTs < 5 * 60e3);
    prevFrom = m.from; prevTs = m.ts;
  }
  flush();
  if (c.kind === 'dm') {
    const peer = Chat.peer(c), mine = th.msgs.filter(m => m.mine && !m.deleted), last = mine[mine.length - 1];
    if (last && th.msgs[th.msgs.length - 1] === last && (c.reads || {})[peer] >= last.seq) h += '<div class="mt-seen">Seen</div>';
  }
  return h + (window.AX.ChatMedia ? window.AX.ChatMedia.pendingHtml(c.id) : '');
}
VIEWS.thread = pg => {
  const cid = pg.params.c, c = Chat.byId.get(cid);
  if (E2EE.state !== 'ready' || !chatOn()) { pg.el.innerHTML = topbar('Messages') + e2eeGate(E2EE.state); return; }
  if (!c) { pg.el.innerHTML = topbar('Messages') + (Chat.ready ? `<div style="padding-top:calc(var(--sat) + 70px)">${emptyHtml('chat', "This conversation isn't available", '')}</div>` : '<div class="mt-loading" style="padding-top:120px"><span class="spin-sm"></span></div>'); if (!Chat.ready) Chat.refresh(); return; }
  pg.el.classList.add('chat');
  const who = c.kind === 'dm' ? `data-act="open-user" data-u="${esc(Chat.peer(c))}"` : 'data-act="group-info"';
  pg.el.innerHTML = `<div class="topbar chat-top"><button class="tb-btn" data-act="back" aria-label="Back">${ic('back')}</button><div class="ct-who" ${who}><span class="ct-av">${convAvatar(c)}</span><div class="ct-t"><b class="ell" data-ct="title"></b><span class="ell" data-ct="sub"></span></div></div>`
    + `${c.kind === 'dm' ? `<button class="tb-btn" data-act="safety" data-u="${esc(Chat.peer(c))}" aria-label="Verify security code">${ic('shield')}</button>` : `<button class="tb-btn" data-act="group-info" aria-label="Group info">${ic('group')}</button>`}<button class="tb-btn" data-act="chat-more" aria-label="More">${ic('more-v')}</button></div>`
    + `<div class="mt-banner"></div><div class="mt-body"></div><form class="composer"><button type="button" class="tb-btn" data-act="chat-attach" aria-label="Share what's playing">${ic('note')}</button>${window.AX.ChatMedia ? window.AX.ChatMedia.buttons('tb-btn') : ''}<textarea rows="1" maxlength="4000" placeholder="Message" enterkeyhint="send"></textarea><button class="send" type="submit" aria-label="Send">${ic('send')}</button></form>`;
  const body = pg.el.querySelector('.mt-body'), input = pg.el.querySelector('textarea'), form = pg.el.querySelector('.composer');
  if (window.AX.ChatMedia) window.AX.ChatMedia.mount(form, cid, pg.el);
  pg.stick = true;
  body.addEventListener('scroll', () => {
    pg.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const th = Chat.thread(cid);
    if (body.scrollTop < 60 && th.more && th.loaded && !th.busy) { const h0 = body.scrollHeight; Chat.older(cid).then(() => { body.scrollTop = body.scrollHeight - h0 + body.scrollTop; }); }
  }, { passive: true });
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
  input.addEventListener('input', grow);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value; if (!text.trim()) return;
    input.value = ''; grow(); pg.stick = true; haptic(5);
    try { await Chat.send(cid, text); } catch (err) { toast(err.message); input.value = text; grow(); }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !IOS && !/Android/.test(navigator.userAgent)) { e.preventDefault(); form.requestSubmit(); } });
  // Long-press a message to react or unsend.
  let lp = 0;
  body.addEventListener('touchstart', e => { const m = e.target.closest('[data-sa-msg]'); if (!m) return; lp = setTimeout(() => { haptic(15); msgSheet(cid, m.dataset.m); }, 450); }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(t => body.addEventListener(t, () => clearTimeout(lp), { passive: true }));
  body.addEventListener('contextmenu', e => { const m = e.target.closest('[data-sa-msg]'); if (m) { e.preventDefault(); msgSheet(cid, m.dataset.m); } });
  const th = Chat.thread(cid);
  if (!th.loaded) Chat.load(cid).catch(e => toast(e.message));
  Chat.open = cid;
  pg.cleanup.push(() => { if (Chat.open === cid) Chat.open = ''; });
  updateThread(pg);
};
async function updateThread(pg) {
  const cid = pg.params.c, c = Chat.byId.get(cid), body = pg.el.querySelector('.mt-body');
  if (!c || !body) return;
  Chat.open = cid;
  const th = Chat.thread(cid);
  pg.el.querySelector('[data-ct="title"]').textContent = Chat.title(c);
  pg.el.querySelector('[data-ct="sub"]').textContent = c.kind === 'dm' ? '@' + Chat.peer(c) : count(c.st.members.length, 'member');
  pg.el.querySelector('textarea').placeholder = `Message ${c.kind === 'dm' ? firstName(Chat.title(c)) : Chat.title(c)}`;
  body.innerHTML = msgsHtml(c, th);
  if (window.AX.ChatMedia) window.AX.ChatMedia.hydrate(body);
  if (pg.stick) body.scrollTop = body.scrollHeight;
  const bits = [];
  for (const m of Chat.others(c)) {
    const pin = await E2EE.pin(m);
    if (pin && pin.changed && !pin.changed.seen) bits.push(`<div class="mt-warn">${ic('shield', 'sm')}<span class="flex1">${esc(Chat.card(c, m).display_name)}'s security code changed.</span><button class="btn ghost sm" data-act="safety" data-u="${esc(m)}">Check</button></div>`);
  }
  const problem = await Chat.sendProblem(c);
  if (problem && problem !== 'locked' && !bits.length) bits.push(`<div class="mt-warn">${ic('lock', 'sm')}<span class="flex1">${esc(problem)}</span></div>`);
  if (!pg.el.isConnected) return;
  pg.el.querySelector('.mt-banner').innerHTML = (window.AX.ChatMedia ? window.AX.ChatMedia.banner(c) : '') + bits.join('');
  pg.el.querySelector('.composer').classList.toggle('off', !!problem);
  pg.el.querySelector('textarea').disabled = !!problem;
  if (th.loaded && curPage() === pg && !document.hidden) Chat.markRead(cid);
}
function msgSheet(cid, mid) {
  const th = Chat.thread(cid), m = th.msgs.find(x => x.id === mid); if (!m) return;
  const mine = (th.reacts.get(mid) || new Map()).get(U.username);
  const sh = openSheet(`<div class="react-row">${REACTIONS.map(e => `<button class="${e === mine ? 'on' : ''}" data-sa="react" data-e="${e}">${e}</button>`).join('')}</div><div class="sheet-body">`
    + (m.body && m.body.t ? si('copy', 'copy', 'Copy text') : '') + (m.mine ? si('unsend', 'trash', 'Unsend', { danger: true }) : '') + `<p class="list-foot" style="text-align:center">${esc(new Date(m.ts).toLocaleString())}</p></div>`, {
    react: (b, close) => { close(); Chat.react(cid, mid, b.dataset.e).catch(e => toast(e.message)); },
    copy: (b, close) => { close(); navigator.clipboard.writeText(m.body.t).then(() => toast('Copied')).catch(() => {}); },
    unsend: async (b, close) => { await close(); if (await confirmDlg({ title: 'Unsend this message?', text: "It's removed for everyone in the chat.", ok: 'Unsend' })) Chat.unsend(cid, mid).catch(e => toast(e.message)); },
  });
  return sh;
}
function chatSheet(c) {
  const dm = c.kind === 'dm', peer = Chat.peer(c), admin = !dm && c.st.admin === U.username;
  openSheet(sheetHead(convAvatar(c), Chat.title(c), dm ? '@' + peer : count(c.st.members.length, 'member')) + '<div class="sheet-body">'
    + (dm ? si('profile', 'person', 'View profile') : si('info', 'group', 'Group info') + si('rename', 'edit', 'Rename group') + si('add', 'person-add', 'Add people'))
    + (E2EE.state === 'ready' && dm ? si('safety', 'shield', 'Verify security code') : '')
    + (window.AX.ChatMedia ? si('ttl', 'timer', c.ttl ? `Disappearing messages: ${window.AX.ChatMedia.ttlName(c.ttl)}` : 'Disappearing messages') + (feat('party') && window.AX.Party ? si('party', 'party', 'Start a listening party here') : '') : '')
    + si('clear', 'trash', 'Clear chat') + (dm ? si('block', 'block', 'Block', { danger: true }) : si('leave', 'logout', 'Leave group', { danger: true })) + '</div>', {
    profile: thenNav(() => openPage('user', { u: peer })),
    info: (b, close) => close().then(() => groupSheet(c.id)),
    rename: (b, close) => close().then(() => renameGroup(c.id)),
    add: (b, close) => close().then(() => addPeople(c.id)),
    safety: (b, close) => close().then(() => safetySheet(peer)),
    ttl: (b, close) => close().then(() => window.AX.ChatMedia.ttlDialog(c.id)),
    party: (b, close) => close().then(() => window.AX.ChatMedia.partyInvite(c.id)),
    clear: async (b, close) => { await close(); if (await confirmDlg({ title: 'Clear this chat?', text: 'Messages disappear from your devices. Everyone else keeps theirs.', ok: 'Clear' })) { await Chat.hide(c.id); goBack(); } },
    block: async (b, close) => { await close(); if (await confirmDlg({ title: `Block ${Chat.title(c)}?`, text: "They won't be able to message you or find you.", ok: 'Block', danger: true })) { await friendAct('block', peer); goBack(); } },
    leave: async (b, close) => { await close(); if (await confirmDlg({ title: 'Leave this group?', text: admin ? "You're the admin; whoever joined next becomes admin." : "You won't get its messages anymore.", ok: 'Leave', danger: true })) { await Chat.leave(c.id).catch(e => toast(e.message)); goBack(); } },
  });
}
function friendPickerSheet({ title, ok, exclude = [], withName = false }) {
  const friends = Social.friends().filter(f => !exclude.includes(f.username));
  if (!friends.length) { toast(exclude.length ? 'All your friends are already here' : 'Add friends first'); if (!exclude.length) openPage('friends', { tab: 'find' }); return Promise.resolve(null); }
  return new Promise(resolve => {
    let result = null;
    const sh = openSheet(`<div class="sheet-title">${esc(title)}</div><div class="filter-in" style="margin:0 16px 8px">${ic('search')}<input type="search" placeholder="Search friends" autocomplete="off"></div><div class="sheet-body">${friends.map(f => `<div class="pick" data-sa="pick" data-u="${esc(f.username)}" data-n="${esc(norm(f.display_name + ' ' + f.username))}">${personAvatar(f, 'pr-av')}<div class="meta"><div class="t">${esc(f.display_name)}</div><div class="s"><span>@${esc(f.username)}</span></div></div><span class="tick">${ic('check')}</span></div>`).join('')}</div>`
      + `<div class="sheet-foot" style="flex-direction:column;gap:10px">${withName ? '<input class="input" id="gp-name" maxlength="100" placeholder="Group name (optional)" hidden>' : ''}<button class="btn primary block" data-sa="ok" disabled>${esc(ok)}</button></div>`, {
      pick: b => {
        b.classList.toggle('on'); haptic(5);
        const n = sh.el.querySelectorAll('.pick.on').length;
        sh.el.querySelector('[data-sa="ok"]').disabled = !n;
        const name = sh.el.querySelector('#gp-name'); if (name) name.hidden = n < 2;
      },
      ok: (b, close) => { result = { users: [...sh.el.querySelectorAll('.pick.on')].map(p => p.dataset.u), name: (sh.el.querySelector('#gp-name') || {}).value || '' }; close(); },
      onClose: () => resolve(result),
    }, { tall: true });
    const q = sh.el.querySelector('input[type=search]');
    q.addEventListener('input', () => { const n = norm(q.value); sh.el.querySelectorAll('.pick').forEach(p => { p.hidden = !!n && !p.dataset.n.includes(n); }); });
  });
}
async function newChat() {
  if (E2EE.state !== 'ready') { openPage('messages'); return; }
  const r = await friendPickerSheet({ title: 'New message', ok: 'Chat', withName: true });
  if (!r) return;
  try {
    if (r.users.length === 1) { await openDM(r.users[0]); return; }
    const c = await Chat.group(r.users, r.name.trim());
    openPage('thread', { c: c.id });
  } catch (e) { toast(e.message); }
}
async function sendTo(att) {
  if (!chatOn()) return;
  if (E2EE.state !== 'ready') { toast('Turn on private messages first'); afterLayers(() => openPage('messages')); return; }
  const convs = Chat.list.slice(0, 8);
  const friends = Social.friends().filter(f => !convs.some(c => c.kind === 'dm' && Chat.peer(c) === f.username));
  const row = (key, avatar, name, sub) => `<div class="pick" data-sa="pick" data-k="${esc(key)}">${avatar}<div class="meta"><div class="t">${esc(name)}</div><div class="s"><span>${esc(sub)}</span></div></div><span class="tick">${ic('check')}</span></div>`;
  const a = attachment(att);
  const sh = openSheet(`<div class="sheet-title">Send to…</div><div class="sheet-body">${a ? `<div style="padding:0 16px 8px">${attCard(a)}</div>` : ''}${convs.map(c => row('c:' + c.id, `<span class="pr-av">${convAvatar(c)}</span>`, Chat.title(c), c.kind === 'dm' ? 'Chat' : 'Group')).join('')}${friends.map(f => row('u:' + f.username, personAvatar(f, 'pr-av'), f.display_name, '@' + f.username)).join('')}</div>`
    + `<div class="sheet-foot" style="flex-direction:column;gap:10px"><input class="input" id="st-msg" maxlength="1000" placeholder="Add a message (optional)"><button class="btn primary block" data-sa="send" disabled>Send</button></div>`, {
    pick: b => { b.classList.toggle('on'); sh.el.querySelector('[data-sa="send"]').disabled = !sh.el.querySelector('.pick.on'); haptic(5); },
    send: async (b, close) => {
      const keys = [...sh.el.querySelectorAll('.pick.on')].map(p => p.dataset.k), text = sh.el.querySelector('#st-msg').value;
      close();
      let sent = 0;
      for (const k of keys) {
        try { const cid = k.startsWith('c:') ? k.slice(2) : (await Chat.dm(k.slice(2))).id; await Chat.send(cid, text, { a: att }); sent++; } catch (e) { toast(e.message); }
      }
      if (sent) toast(sent === 1 ? 'Sent' : `Sent to ${sent} chats`);
    },
  }, { tall: true });
}
function groupSheet(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const admin = c.st.admin;
  openSheet(`<div class="sheet-title">${esc(Chat.title(c))}</div><div class="sheet-body">${c.st.members.map(m => { const card = Chat.card(c, m); return `<div class="pick" ${m === U.username ? '' : `data-sa="member" data-u="${esc(m)}"`}>${personAvatar(card, 'pr-av')}<div class="meta"><div class="t">${esc(m === U.username ? 'You' : card.display_name)}</div><div class="s"><span>${m === admin ? 'Admin' : '@' + esc(m)}</span></div></div></div>`; }).join('')}`
    + si('add', 'person-add', 'Add people') + si('rename', 'edit', 'Rename group') + si('leave', 'logout', 'Leave group', { danger: true }) + '</div>', {
    member: (b, close) => {
      const u = b.dataset.u;
      close().then(() => openSheet(sheetHead(personAvatar(cardOf(u), 'pr-av'), cardOf(u).display_name, '@' + u) + '<div class="sheet-body">' + si('profile', 'person', 'View profile')
        + (E2EE.state === 'ready' ? si('safety', 'shield', 'Verify security code') : '') + (admin === U.username ? si('remove', 'minus-c', 'Remove from group', { danger: true }) : '') + '</div>', {
        profile: thenNav(() => openPage('user', { u })),
        safety: (x, cl) => cl().then(() => safetySheet(u)),
        remove: async (x, cl) => { await cl(); if (await confirmDlg({ title: `Remove ${cardOf(u).display_name}?`, text: "They won't see new messages.", ok: 'Remove', danger: true })) Chat.removeMember(cid, u).catch(e => toast(e.message)); },
      }));
    },
    add: (b, close) => close().then(() => addPeople(cid)),
    rename: (b, close) => close().then(() => renameGroup(cid)),
    leave: async (b, close) => { await close(); if (await confirmDlg({ title: 'Leave this group?', ok: 'Leave', danger: true })) { await Chat.leave(cid).catch(e => toast(e.message)); goBack(); } },
  }, { tall: true });
}
async function addPeople(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const r = await friendPickerSheet({ title: 'Add people', ok: 'Add', exclude: c.st.members });
  if (r) for (const u of r.users) { try { await Chat.addMember(cid, u); } catch (e) { toast(e.message); } }
}
async function renameGroup(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const name = await promptDlg({ title: 'Name this group', value: c.st.name || '', ok: 'Save' });
  if (name) Chat.rename(cid, name).then(() => toast('Group renamed')).catch(e => toast(e.message));
}
async function safetySheet(user) {
  if (E2EE.state !== 'ready') return;
  const sn = await E2EE.safetyNumber(user), pin = await E2EE.pin(user), name = cardOf(user).display_name;
  if (!sn) { toast(`${name} hasn't turned on private messages yet`); return; }
  const g = sn.split(' ');
  openSheet(`<div class="sheet-title">Verify security code</div><div class="sheet-body" style="padding:0 20px 8px"><p class="muted" style="font-size:14px;line-height:1.45">Compare these numbers with ${esc(name)}'s screen, in person or on a call. If they match, nobody has swapped the keys protecting your chats.</p><div class="sn">${[0, 3, 6, 9].map(i => `<div>${g.slice(i, i + 3).map(x => `<span>${x}</span>`).join('')}</div>`).join('')}</div>${pin.verified ? `<p class="sn-ok">${ic('shield', 'sm')} Verified</p>` : ''}</div><div class="sheet-foot"><button class="btn ${pin.verified ? 'ghost' : 'primary'} block" data-sa="mark">${pin.verified ? 'Clear verification' : 'Mark as verified'}</button></div>`, {
    mark: async (b, close) => {
      await E2EE.setPin(user, pin.verified ? { verified: false } : { verified: true, changed: pin.changed ? Object.assign({}, pin.changed, { ok: true, seen: true }) : undefined });
      close(); toast(pin.verified ? 'Verification cleared' : `${name} is verified`);
      const pg = curPage(); if (pg && pg.view === 'thread') updateThread(pg);
    },
  });
}
const PRESENCE_STEPS = `<ol class="steps"><li><b>Get Python</b> if the computer doesn't have it yet. It's free at <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">python.org</a>.</li><li><b>Download the helper</b> on the computer where you use the Discord app. It's made for your account.</li><li><b>Open it once.</b> On Windows, double-click it. On a Mac or Linux, run <code>python3 ~/Downloads/axdio-discord.py</code> in Terminal. A window says when it's done.</li></ol><p class="steps-done">That's all. It runs in the background and starts by itself whenever you sign in to the computer. While Discord is open, your status shows the song, artist, album, artwork and time left.</p>`;
function presenceSheet() {
  const sh = openSheet(`<div class="sheet-title">Show what you play on Discord</div><div class="sheet-body" style="padding:0 20px 8px"><p class="muted" style="font-size:14px;line-height:1.45">Discord only lets programs on your own computer change your status, so this uses a small helper. It's easiest to open these settings on that computer and download it there.</p>${PRESENCE_STEPS}<p class="muted" id="pr-state" style="font-size:13px"></p></div>`
    + `<div class="sheet-foot" style="flex-direction:column;gap:10px"><button class="btn primary block" data-sa="get">Download the helper</button>${U.presence ? '<button class="btn ghost block" data-sa="off">Turn off</button>' : ''}</div>`, {
    get: async b => { b.disabled = true; try { await presenceSetup(); toast('Helper downloaded. Move it to your computer and open it there once.'); markDirty(['settings'], true); } catch (e) { toast(e.message); } b.disabled = false; },
    off: async (b, close) => { try { await presenceOff(); close(); toast('Discord status turned off'); markDirty(['settings'], true); } catch (e) { toast(e.message); } },
  });
  presenceInfo().then(d => { const s = sh.el.querySelector('#pr-state'); if (s && d.enabled) s.textContent = d.seen ? `Your helper last checked in ${agoText(d.seen * 1000).toLowerCase()}.` : "Your helper hasn't checked in yet."; }).catch(() => {});
}
function recoverySheet(rk, first) {
  return new Promise(resolve => {
    const sh = openSheet(`<div class="sheet-title">${first ? 'Save your recovery key' : 'Your recovery key'}</div><div class="sheet-body" style="padding:0 20px 8px"><p class="muted" style="font-size:14px;line-height:1.45">This key unlocks your messages on a new device when none of your other devices can approve it. Nobody else has it, not even the server's admins.</p><div class="rk">${esc(rk.slice(0, 19))}<br>${esc(rk.slice(20))}</div><div style="display:flex;gap:10px;justify-content:center;margin-top:14px"><button class="btn ghost sm" data-sa="copy">${ic('copy', 'sm')} Copy</button><button class="btn ghost sm" data-sa="save">${ic('dl', 'sm')} Save file</button></div><p class="muted" style="font-size:12.5px;margin-top:16px;text-align:center">Keep it somewhere safe, like a password manager.</p></div><div class="sheet-foot"><button class="btn primary block" data-sa="done">${first ? "I've saved it" : 'Done'}</button></div>`, {
      copy: () => navigator.clipboard.writeText(rk).then(() => toast('Recovery key copied')).catch(() => toast("Couldn't copy it")),
      save: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`${SITE.site_title || 'Axdio'} recovery key for @${U.username}\n\n${rk}\n\nKeep this private. It unlocks your private messages on a new device.\n`], { type: 'text/plain' })); a.download = 'recovery-key.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
      done: (b, close) => close(),
      onClose: () => resolve(true),
    });
    return sh;
  });
}
async function e2eeSetup(reset) {
  try { const rk = await E2EE.setup(reset); await recoverySheet(rk, true); toast('Private messages are on'); markDirty(['messages', 'settings'], true); }
  catch (e) { toast(e.message); }
}
function unlockSheet() {
  const sh = openSheet(`<div class="sheet-title">Use your recovery key</div><div class="sheet-body" style="padding:0 16px 8px"><input class="input mono" id="rk-in" placeholder="XXXX-XXXX-XXXX-…" autocomplete="off" autocapitalize="characters" spellcheck="false"><div class="form-err" id="rk-err"></div></div><div class="sheet-foot"><button class="btn primary block" data-sa="go">Unlock</button></div>`, {
    go: async (b, close) => {
      b.disabled = true; sh.el.querySelector('#rk-err').textContent = '';
      try { await E2EE.unlock(sh.el.querySelector('#rk-in').value); close(); toast('Messages unlocked'); markDirty(['messages', 'thread', 'settings'], true); }
      catch (e) { sh.el.querySelector('#rk-err').textContent = e.message; b.disabled = false; }
    },
  });
  setTimeout(() => sh.el.querySelector('#rk-in').focus(), 300);
}
async function linkSheet() {
  let p;
  try { p = await E2EE.requestLink(); } catch (e) { toast(e.message); return; }
  let timer = 0, open = true;
  const sh = openSheet(`<div class="sheet-title">Approve from another device</div><div class="sheet-body" style="padding:0 20px 16px;text-align:center"><p class="muted" style="font-size:14px;line-height:1.45">Open ${esc(SITE.site_title || 'Axdio')} on a device where your messages work. Approve the prompt there if it shows this code:</p><div class="link-code">${esc(p.code)}</div><p class="muted link-wait"><span class="spin-sm"></span> Waiting for approval…</p></div>`, {
    onClose: () => { open = false; clearTimeout(timer); E2EE.cancelLink(); },
  });
  const tick = async () => {
    if (!open) return;
    try {
      const st = await E2EE.checkLink();
      if (st === 'approved') { open = false; sh.close(); toast('Messages unlocked'); markDirty(['messages', 'thread', 'settings'], true); return; }
      if (st !== 'pending') { sh.el.querySelector('.link-wait').textContent = st === 'denied' ? 'The request was declined.' : 'The request expired. Try again.'; return; }
    } catch (e) { sh.el.querySelector('.link-wait').textContent = e.message; return; }
    timer = setTimeout(tick, 2000);
  };
  timer = setTimeout(tick, 2000);
}
function linkRequestDialog(l) {
  dialog(`<h3>Link a new device?</h3><p><b>${esc(l.device || 'A device')}</b> wants to read and send your private messages. Approve only if you're signing in there yourself and it shows:</p><div class="link-code">${esc(l.code)}</div><div class="btns"><button class="btn ghost" data-dv="cancel">Decline</button><button class="btn primary" data-dv="ok">Approve</button></div>`)
    .then(ok => (ok ? E2EE.approve(l).then(() => toast('Device approved')) : E2EE.deny(l).then(() => toast('Request declined'))).catch(e => toast(e.message)));
}

/* --- Collaborative playlists --- */
function peopleText(p) {
  const label = [p.owner, ...p.collaborators].map(n => n === U.username ? 'You' : firstName(Collab.person(p, n).display_name));
  return label.length <= 3 ? label.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${label.slice(0, 2).join(', ')} and ${label.length - 2} others`;
}
VIEWS.cpl = pg => {
  const pl = Collab.get(pg.params.id);
  if (!pl) { pg.el.innerHTML = topbar('Playlist') + `<div style="padding-top:calc(var(--sat) + 70px)">${emptyHtml('people', "This playlist isn't available", 'It may have been deleted, or you were taken off it.')}</div>`; return; }
  const st = pg.state || (pg.state = { edit: false });
  const ids = Collab.ids(pl.id), rels = pl.tracks.map(t => t.r), owner = Collab.owns(pl), byRel = new Map(pl.tracks.map(t => [t.r, t]));
  const ctx = pageCtx(pg, 'playlist', 'cpl:' + pl.id, pl.name, ids, 'cpl:' + pl.id);
  ctx.cplId = pl.id;
  const by = `<div class="hero-by"><span class="stack">${[pl.owner, ...pl.collaborators].slice(0, 4).map(n => personAvatar(Collab.person(pl, n))).join('')}</span>${esc(peopleText(pl))}</div>`;
  let h = topbar(pl.name, ctx) + '<div class="wash"></div>' + heroHtml({ cover: plCover(rels), title: pl.name, by, sub: `Collaborative • ${count(ids.length, 'song')}` });
  h += `<div class="actions">${dlBtn(ctx)}<button class="ib" data-act="cpl-add" aria-label="Add songs">${ic('pl-add')}</button>${owner ? `<button class="ib" data-act="cpl-invite" aria-label="Invite friends">${ic('person-add')}</button>` : ''}<button class="ib${st.edit ? ' lit' : ''}" data-act="pl-edit" aria-label="Edit playlist">${ic('edit')}</button><button class="ib" data-act="more-ctx" data-k="cpl" data-id="${esc(pl.id)}" aria-label="More options">${ic('more-v')}</button><span class="flex1"></span>${ids.length ? shuffleBtn() + playBtn(ctx) : ''}</div>`;
  const who = t => { const it = byRel.get(t.rel), c = it && Collab.person(pl, it.by); return c ? `${it.by === U.username ? 'You' : firstName(c.display_name)} • ${t.artist}` : t.artist; };
  if (!ids.length) h += emptyHtml('people', 'Add the first songs', 'Everyone on this playlist can add, remove and reorder songs.', '<button class="btn light" data-act="cpl-add">Add songs</button>');
  else if (st.edit) h += `<div class="rows" data-ctx="${ctx.rid}" data-sortable>${ids.map((id, i) => trackRow(L.tracks[id], i, { drag: true, sub: who(L.tracks[id]), tail: `<button class="row-act" data-act="cpl-remove" data-t="${id}" aria-label="Remove">${ic('minus-c', 'md')}</button>` })).join('')}</div>`;
  else h += `<div class="rows" data-ctx="${ctx.rid}">${ids.map((id, i) => trackRow(L.tracks[id], i, { sub: who(L.tracks[id]) })).join('')}</div>`;
  pg.el.innerHTML = h;
  afterRender(pg);
  if (ids.length) paint(pg, L.tracks[ids[0]].rel);
  const sortable = pg.el.querySelector('[data-sortable]');
  if (sortable) dragSort(sortable, '.trk', '.page', (from, to) => { Collab.move(pl.id, ids, from, to); renderPage(pg, true); });
};
async function inviteSheet({ personal, cid }) {
  const pl = cid ? Collab.get(cid) : null;
  const r = await friendPickerSheet({ title: personal ? `Make “${personal}” collaborative` : 'Invite friends', ok: 'Invite', exclude: pl ? [pl.owner, ...pl.collaborators] : [] });
  if (!r) return;
  try {
    if (personal) {
      const p = await Collab.fromPersonal(personal, r.users);
      toast('Your friends can now add songs too');
      const pg = curPage(); if (pg && pg.view === 'playlist' && pg.params.name === personal) goBack();
      afterLayers(() => openPage('cpl', { id: p.id }));
    } else { await Collab.op(cid, { op: 'invite', users: r.users }); toast(r.users.length === 1 ? 'Invited' : `Invited ${r.users.length} friends`); }
  } catch (e) { toast(e.message); }
}
async function newCollab() {
  const name = await promptDlg({ title: 'Name your collaborative playlist', value: `Our Playlist #${Collab.list.length + 1}`, ok: 'Next' });
  if (!name) return;
  const r = await friendPickerSheet({ title: 'Invite friends', ok: 'Create' });
  if (!r) return;
  try { const p = await Collab.create(name, [], r.users); openPage('cpl', { id: p.id }); } catch (e) { toast(e.message); }
}
function addToCollabSheet(id) {
  const pl = Collab.get(id); if (!pl) return;
  const html = `<div class="sheet-title">Add to ${esc(pl.name)}</div><div class="filter-in" style="margin:0 16px 10px">${ic('search')}<input type="search" placeholder="Search songs" autocomplete="off"></div><div class="sheet-body" id="ca-body"></div>`;
  const sh = openSheet(html, { add: b => { if (Collab.add(id, [+b.dataset.t])) { b.classList.add('on'); b.innerHTML = ic('check-c', 'md'); toast('Added'); } } }, { tall: true });
  const input = sh.el.querySelector('input'), body = sh.el.querySelector('#ca-body');
  const draw = () => {
    const q = input.value.trim(), have = new Set(Collab.rels(id));
    const list = q ? (searchAll(q) || { songs: [] }).songs.slice(0, 30) : shuffled(L.tracks.map(t => t.id), rng(dayKey())).slice(0, 20);
    body.innerHTML = `<div class="rows">${list.map((tid, i) => trackRow(L.tracks[tid], i, { tail: `<button class="row-act${have.has(L.tracks[tid].rel) ? ' on' : ''}" data-sa="add" data-t="${tid}" aria-label="Add">${ic(have.has(L.tracks[tid].rel) ? 'check-c' : 'add', 'md')}</button>` })).join('')}</div>`;
  };
  input.addEventListener('input', debounce(draw, 150));
  draw();
}

/* ======================================================================
   10. Sheets, dialogs & toasts
   ====================================================================== */
function openLayer(el, entryClose) {
  byId('layers').appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  const entry = { kind: 'layer', close: () => { el.classList.remove('open'); setTimeout(() => el.remove(), 320); if (entryClose) entryClose(); } };
  H.push(entry);
  return entry;
}
function openSheet(html, handlers = {}, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="scrim"></div><div class="sheet${opts.tall ? ' tall' : ''}" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const entry = openLayer(wrap, handlers.onClose);
  const close = () => H.closeEntry(entry);
  wrap.querySelector('.scrim').addEventListener('click', close);
  wrap.addEventListener('click', e => {
    const b = e.target.closest('[data-sa]');
    if (b && handlers[b.dataset.sa]) { e.stopPropagation(); haptic(5); handlers[b.dataset.sa](b, close); }
  });
  dragToClose(wrap.querySelector('.sheet'), '.sheet-body', close);
  return { el: wrap, close, entry };
}
const si = (sa, icon, label, o = {}) => `<button class="si${o.on ? ' on' : ''}${o.danger ? ' danger' : ''}" data-sa="${sa}">${ic(icon)}<span>${esc(label)}</span>${o.note ? `<span class="note">${esc(o.note)}</span>` : ''}</button>`;
const sheetHead = (cover, title, sub) => `<div class="sheet-head"><div class="row-art">${cover}</div><div class="meta"><div class="t">${esc(title)}</div><div class="s"><span>${esc(sub)}</span></div></div></div>`;
// Close every open overlay, then run fn (e.g. navigate somewhere).
const thenNav = fn => () => afterLayers(fn);

function trackSheet(t, o = {}) {
  const liked = U.likedSet.has(t.rel), dl = Off.state(t.rel);
  const al = albumOf(t), ar = artistOf(t);
  const html = sheetHead(img(coverUrl(t.rel)), t.title, t.artist) + '<div class="sheet-body">'
    + si('like', liked ? 'heart-f' : 'heart', liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', { on: liked })
    + si('pl', 'pl-add', 'Add to playlist')
    + (o.plName || o.cplId ? si('pl-rm', 'minus-c', 'Remove from this playlist') : '')
    + si('queue', 'queue', 'Add to queue')
    + si('next', 'next', 'Play next')
    + si('dl', dl === 'done' ? 'dl-f' : 'dl', dl === 'done' ? 'Remove download' : dl === 'busy' ? 'Cancel download' : 'Download', { on: dl === 'done' })
    + si('radio', 'radio', 'Go to song radio')
    + si('album', 'album', 'View album')
    + si('artist', 'person', 'View artist')
    + si('share', 'share', 'Share')
    + (chatOn() ? si('send', 'send', 'Send to a friend') : '')
    + (o.player ? si('sleep', 'moon', 'Sleep timer', { note: sleepLabel() }) + si('eq', 'tune', 'Equalizer') : '')
    + '</div>';
  openSheet(html, {
    like: (b, close) => { close(); toggleLike(t); },
    pl: (b, close) => close().then(() => playlistPicker([t.id])),
    'pl-rm': (b, close) => { close(); if (o.cplId) { Collab.remove(o.cplId, [t.rel]); toast('Removed'); } else { removeFromPlaylist(o.plName, [t.rel]); toast(`Removed from ${o.plName}`); } },
    send: (b, close) => close().then(() => sendTo(attachTrack(t))),
    queue: (b, close) => { close(); addToQueue([t.id]); },
    next: (b, close) => { close(); addToQueue([t.id], true); },
    dl: (b, close) => { close(); if (dl === 'done') { Off.remove([t.rel]); toast('Removed from downloads'); } else if (dl === 'busy') Off.cancel([t.rel]); else { Off.enqueue([t.rel]); toast('Downloading'); } },
    radio: thenNav(() => openPage('mix', { id: 'radio:' + t.rel })),
    album: thenNav(() => openPage('album', { id: al.id })),
    artist: thenNav(() => openPage('artist', { id: ar.id })),
    share: (b, close) => { close(); share(t.title, `${t.title} by ${t.artist}`, trackLink(t)); },
    sleep: (b, close) => close().then(sleepSheet),
    eq: thenNav(() => openPage('eq')),
  });
}
function ctxSheet(k, id) {
  let cover, title, sub, ids, items = '', h = {};
  if (k === 'album') {
    const al = L.albums[+id]; if (!al) return;
    cover = img(coverUrl(al.cover)); title = al.title; sub = `${al.type} • ${albumArtist(al)}`; ids = al.trackIds;
    const saved = U.saved.includes(al.key);
    items = si('save', saved ? 'check-c' : 'add', saved ? 'Remove from Your Library' : 'Add to Your Library', { on: saved })
      + (al.artistId >= 0 ? si('artist', 'person', 'View artist') : '');
    h.save = (b, close) => { close(); toggleSaveAlbum(al); };
    h.artist = thenNav(() => openPage('artist', { id: al.artistId }));
    h.share = (b, close) => { close(); share(al.title, `${al.title} by ${albumArtist(al)}`, albumLink(al)); };
    if (chatOn()) { items += si('send', 'send', 'Send to a friend'); h.send = (b, close) => close().then(() => sendTo(attachAlbum(al))); }
  } else if (k === 'artist') {
    const ar = L.artists[+id]; if (!ar) return;
    cover = img(coverUrl(ar.cover)); title = ar.name; sub = 'Artist'; ids = ar.trackIds;
    const f = U.follows.includes(ar.key);
    items = si('follow', f ? 'check-c' : 'person-add', f ? 'Unfollow' : 'Follow', { on: f }) + si('radio', 'radio', 'Go to artist radio') + si('discog', 'album', 'View discography');
    h.follow = (b, close) => { close(); toggleFollow(ar); };
    h.radio = thenNav(() => openPage('mix', { id: 'artist-radio:' + ar.key }));
    h.discog = thenNav(() => openPage('discog', { key: ar.key }));
    h.share = (b, close) => { close(); share(ar.name, ar.name, artistLink(ar)); };
    if (chatOn()) { items += si('send', 'send', 'Send to a friend'); h.send = (b, close) => close().then(() => sendTo(attachArtist(ar))); }
  } else if (k === 'playlist') {
    const rels = U.playlists[id]; if (!rels) return;
    cover = plCover(rels); title = id; sub = `Playlist • ${count(rels.length, 'song')}`; ids = rels.map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
    items = si('rename', 'edit', 'Rename playlist') + si('add', 'pl-add', 'Add songs') + (collabOn() ? si('invite', 'person-add', 'Invite collaborators') : '') + si('delete', 'trash', 'Delete playlist', { danger: true });
    h.invite = (b, close) => close().then(() => inviteSheet({ personal: id }));
    h.rename = (b, close) => close().then(() => renamePlaylist(id));
    h.add = (b, close) => close().then(() => addSongsSheet(id));
    h.delete = (b, close) => close().then(() => deletePlaylist(id));
  } else if (k === 'cpl') {
    const pl = Collab.get(id); if (!pl) return;
    const owner = Collab.owns(pl);
    cover = plCover(Collab.rels(id)); title = pl.name; sub = `Collaborative • ${count(pl.tracks.length, 'song')}`; ids = Collab.ids(id);
    items = si('add', 'pl-add', 'Add songs') + (owner ? si('invite', 'person-add', 'Invite friends') + si('rename', 'edit', 'Rename playlist') : '')
      + (chatOn() ? si('send', 'send', 'Send to a friend') : '') + (owner ? si('delete', 'trash', 'Delete playlist', { danger: true }) : si('leave', 'logout', 'Leave playlist', { danger: true }));
    h.add = (b, close) => close().then(() => addToCollabSheet(id));
    h.invite = (b, close) => close().then(() => inviteSheet({ cid: id }));
    h.rename = async (b, close) => { await close(); const n = await promptDlg({ title: 'Rename playlist', value: pl.name, ok: 'Save' }); if (n) Collab.op(id, { op: 'rename', name: n }).catch(() => {}); };
    h.send = (b, close) => close().then(() => sendTo({ k: 'cpl', id, title: pl.name }));
    h.delete = async (b, close) => { await close(); if (await confirmDlg({ title: `Delete ${pl.name}?`, text: 'It disappears for everyone on it.', ok: 'Delete', danger: true })) { await Collab.op(id, { op: 'delete' }).catch(() => {}); const pg = curPage(); if (pg && pg.view === 'cpl') goBack(); } };
    h.leave = async (b, close) => { await close(); if (await confirmDlg({ title: `Leave ${pl.name}?`, text: "It won't be in your library anymore.", ok: 'Leave', danger: true })) { await Collab.op(id, { op: 'leave' }).catch(() => {}); const pg = curPage(); if (pg && pg.view === 'cpl') goBack(); } };
  } else if (k === 'mix') {
    const m = getMix(id); if (!m) return;
    cover = mixCover(m); title = m.name; sub = m.desc; ids = m.ids;
    items = si('save', 'add', 'Save as playlist');
    h.save = (b, close) => close().then(() => saveMixAsPlaylist(m));
  } else if (k === 'liked') {
    cover = `<div class="cover-glyph liked-art">${ic('heart-f')}</div>`; title = 'Liked Songs'; sub = count(U.liked.length, 'song');
    ids = U.liked.map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  }
  const s = Off.summary(ids);
  items += si('queue', 'queue', 'Add to queue') + si('pl', 'pl-add', 'Add to playlist')
    + si('dl', s.total && s.done === s.total ? 'dl-f' : 'dl', s.total && s.done === s.total ? 'Remove download' : s.busy ? 'Cancel download' : 'Download', { on: s.total && s.done === s.total })
    + (h.share ? si('share', 'share', 'Share') : '');
  h.queue = (b, close) => { close(); addToQueue(ids.slice()); };
  h.pl = (b, close) => close().then(() => playlistPicker(ids.slice()));
  h.dl = (b, close) => { close(); toggleCtxDownload(makeCtx(k, id, title, ids)); };
  openSheet(sheetHead(cover, title, sub) + `<div class="sheet-body">${items}</div>`, h);
}
function playlistPicker(ids) {
  const names = Object.keys(U.playlists);
  const single = ids.length === 1 ? L.tracks[ids[0]] : null;
  const inAll = name => { const set = new Set(U.playlists[name]); return ids.every(id => set.has(L.tracks[id].rel)); };
  const pickRow = (sa, name, cover, sub, on) => `<div class="pick${on ? ' on' : ''}" data-sa="${sa}" data-n="${esc(name)}"><div class="row-art">${cover}</div><div class="meta"><div class="t">${esc(name)}</div><div class="s"><span>${esc(sub)}</span></div></div><span class="tick">${ic('check')}</span></div>`;
  const html = `<div class="sheet-title">Add to playlist</div><div class="sheet-foot" style="padding-top:0"><button class="btn light" data-sa="new">New playlist</button></div><div class="sheet-body">`
    + (single ? pickRow('liked', 'Liked Songs', `<div class="cover-glyph liked-art">${ic('heart-f')}</div>`, count(U.liked.length, 'song'), U.likedSet.has(single.rel)) : '')
    + names.map(n => pickRow('toggle', n, plCover(U.playlists[n]), count(U.playlists[n].length, 'song'), inAll(n))).join('')
    + Collab.list.map(p => { const set = new Set(Collab.rels(p.id)); return pickRow('ctoggle', p.name, plCover(Collab.rels(p.id)), `Collaborative • ${count(p.tracks.length, 'song')}`, ids.every(id => set.has(L.tracks[id].rel))).replace('data-n=', `data-c="${esc(p.id)}" data-n=`); }).join('')
    + (names.length || Collab.list.length ? '' : '<p class="list-foot" style="text-align:center">You have no playlists yet.</p>') + '</div>';
  openSheet(html, {
    new: (b, close) => close().then(() => createPlaylist(ids)),
    liked: b => { toggleLike(single); b.classList.toggle('on', U.likedSet.has(single.rel)); },
    ctoggle: b => {
      const id = b.dataset.c, p = Collab.get(id); if (!p) return;
      if (b.classList.contains('on')) { Collab.remove(id, ids.map(i => L.tracks[i].rel)); b.classList.remove('on'); toast(`Removed from ${p.name}`); }
      else { const n = Collab.add(id, ids); b.classList.add('on'); toast(n ? `Added to ${p.name}` : `Already in ${p.name}`); }
      haptic(10);
    },
    toggle: b => {
      const n = b.dataset.n;
      if (inAll(n)) { removeFromPlaylist(n, ids.map(id => L.tracks[id].rel)); b.classList.remove('on'); toast(`Removed from ${n}`); }
      else { const added = addToPlaylist(n, ids); b.classList.add('on'); toast(added ? `Added to ${n}` : `Already in ${n}`); }
      haptic(10);
    },
  }, { tall: names.length > 6 });
}
async function createPlaylist(ids = [], suggested) {
  const base = suggested || `My Playlist #${Object.keys(U.playlists).length + 1}`;
  const name = await promptDlg({ title: 'Give your playlist a name', value: base, ok: 'Create' });
  if (!name) return;
  const err = plCreate(name, ids);
  if (err) { toast(err); return; }
  toast(ids.length ? `Added to ${name}` : `Created ${name}`);
  afterLayers(() => openPage('playlist', { name }));   // close the player first if it's open
}
function renamePages(from, to) { for (const tab of Object.keys(T.stacks)) T.stacks[tab].forEach(pg => { if (pg.view === 'playlist' && pg.params.name === from) pg.params.name = to; }); }
async function renamePlaylist(name) {
  const nn = await promptDlg({ title: 'Rename playlist', value: name, ok: 'Save' });
  if (!nn || nn === name) return;
  renamePages(name, nn);
  const err = plRename(name, nn);
  if (err) { renamePages(nn, name); toast(err); }
}
async function deletePlaylist(name) {
  if (!(await confirmDlg({ title: `Delete ${name}?`, text: 'This removes the playlist from Your Library on all your devices.', ok: 'Delete', danger: true }))) return;
  const pg = curPage();
  if (pg && pg.view === 'playlist' && pg.params.name === name) goBack();
  plDelete(name);
  toast(`Deleted ${name}`);
}
async function saveMixAsPlaylist(m) { await createPlaylist(m.ids.slice(), m.name); }
function addSongsSheet(name) {
  const html = `<div class="sheet-title">Add to ${esc(name)}</div><div class="filter-in" style="margin-bottom:10px">${ic('search')}<input type="search" placeholder="Search songs" autocomplete="off" aria-label="Search songs"></div><div class="sheet-body" id="as-body"></div>`;
  const sh = openSheet(html, {
    add: b => { const id = +b.dataset.t; const n = addToPlaylist(name, [id]); b.innerHTML = ic('check-c', 'md'); b.classList.add('liked'); if (n) toast(`Added to ${name}`); haptic(10); },
  }, { tall: true });
  const input = sh.el.querySelector('input'), body = sh.el.querySelector('#as-body');
  const row = id => { const t = L.tracks[id], has = U.playlists[name].includes(t.rel); return `<div class="trk" data-t="${id}"><div class="row-art">${img(coverUrl(t.rel))}</div><div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span>${esc(t.artist)}</span></div></div><button class="row-act${has ? ' liked' : ''}" data-sa="add" data-t="${id}" aria-label="Add">${ic(has ? 'check-c' : 'add', 'md')}</button></div>`; };
  const draw = () => {
    const res = searchAll(input.value);
    let ids;
    if (res) ids = res.songs.slice(0, 60);
    else {
      const seeds = U.playlists[name].map(r => L.byRel.get(r)).filter(Boolean).slice(-4).map(t => t.id);
      ids = seeds.length ? uniq(seeds.flatMap(id => radioIds(id, 10).slice(1))).slice(0, 30) : U.liked.slice().reverse().map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id).slice(0, 30);
      if (!ids.length) ids = shuffled(L.tracks.map(t => t.id)).slice(0, 30);
    }
    body.innerHTML = (res ? '' : '<div class="q-sec">Suggested</div>') + ids.map(row).join('');
  };
  input.addEventListener('input', debounce(draw, 120));
  draw();
}
function sortSheet(current, opts, onPick) {
  openSheet(`<div class="sheet-title">Sort by</div><div class="sheet-body">${opts.map(([k, l]) => si('p', current === k ? 'check' : 'blank', l, { on: current === k }).replace('data-sa="p"', `data-sa="p" data-k="${k}"`)).join('')}</div>`, {
    p: (b, close) => { close(); onPick(b.dataset.k); },
  });
}
function qualitySheet(cell) {
  const cur = cell ? S.cellQuality : (S.quality || 'original');
  const opts = (cell ? [['', 'Same as Wi-Fi']] : []).concat(Object.entries(QUALITIES));
  openSheet(`<div class="sheet-title">${cell ? 'Quality on mobile data' : 'Quality on Wi-Fi'}</div><div class="sheet-body">${opts.map(([k, l]) => si('q', cur === k ? 'check' : 'blank', l, { on: cur === k }).replace('data-sa="q"', `data-sa="q" data-q="${k}"`)).join('')}</div>`, {
    q: (b, close) => { close(); setQuality(b.dataset.q, cell); },
  });
}
function sleepSheet() {
  const opts = [[5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['eot', 'End of song']];
  openSheet(`<div class="sheet-title">Sleep timer${SL.end || SL.eot ? `<div class="kicker" style="margin-top:4px;font-weight:600;color:var(--accent)">${esc(sleepLabel())}</div>` : ''}</div><div class="sheet-body">${opts.map(([v, l]) => `<button class="si" data-sa="set" data-v="${v}">${ic('moon')}<span>${l}</span></button>`).join('')}${SL.end || SL.eot ? si('off', 'close', 'Turn off timer', { danger: true }) : ''}</div>`, {
    set: (b, close) => { close(); setSleep(b.dataset.v === 'eot' ? 'eot' : +b.dataset.v); },
    off: (b, close) => { close(); setSleep(0); },
  });
}
function boostSheet() {
  openSheet(`<div class="sheet-title">Volume boost</div><div class="sheet-body">${[1, 1.5, 2, 3, 4, 6].map(v => si('v', S.boost === v ? 'check' : 'volume', v === 1 ? '100% (off)' : `${v * 100}%`, { on: S.boost === v }).replace('data-sa="v"', `data-sa="v" data-v="${v}"`)).join('')}<p class="list-foot">Very high boost can distort loud songs.</p></div>`, {
    v: (b, close) => { close(); setBoost(+b.dataset.v); },
  });
}
async function devicesSheet() {
  const sh = openSheet(`<div class="dev-hero">${ic('phone')}<div><small>Current device</small><b>${esc(Connect.name)}</b></div></div><div class="sheet-title" style="text-align:left;padding-bottom:4px">Select a device</div><div class="sheet-body" id="dev-list"><div class="list-foot">Looking for devices…</div></div>`, {
    dev: async (b, close) => {
      if (b.dataset.me) { toast('Already playing on this device'); return; }
      b.classList.add('busy');
      if (await Connect.transfer(b.dataset.id, b.dataset.name)) close(); else b.classList.remove('busy');
    },
  });
  const box = sh.el.querySelector('#dev-list');
  const devs = await Connect.list();
  if (!devs) { box.innerHTML = '<div class="list-foot">Couldn’t reach the server.</div>'; return; }
  const others = devs.filter(d => d.id !== Connect.id);
  box.innerHTML = others.length ? others.map(d => `<div class="dev" data-sa="dev" data-id="${esc(d.id)}" data-name="${esc(d.name)}">${ic(/desktop|pc|mac|win|linux/i.test(d.name) ? 'pc' : 'phone')}<div class="meta"><div class="t">${esc(d.name)}</div><div class="s">${d.state && d.state.playing ? 'Playing' : d.is_active ? 'Available' : 'Idle'}${d.state && d.state.rel_path && L.byRel.get(d.state.rel_path) ? ' • ' + esc(L.byRel.get(d.state.rel_path).title) : ''}</div></div></div>`).join('')
    : `<div class="list-foot">No other devices found. Open ${esc(SITE.site_title || 'the player')} on another phone or computer${U.token ? ' signed in to the same account' : ''}.</div>`;
}
function editProfileSheet() {
  const photos = feat('avatars');
  let blob = null, removed = false, preview = '';
  const sh = openSheet(`<div class="sheet-title">Edit profile</div><div class="sheet-body" style="padding:0 16px 16px">`
    + (photos ? `<div class="ep-m"><button class="ph-pick" data-sa="pick" aria-label="Change photo"><span class="ph-img"></span><span class="ph-cam">${ic('edit')}</span></button><div class="ep-btns"><button class="ep-link" data-sa="pick">Change photo</button><button class="ep-link" data-sa="remove">Remove</button></div></div>` : '')
    + `<label class="lbl" for="ep-name">Name</label><input class="input" id="ep-name" maxlength="32" value="${esc(U.name)}" autocomplete="nickname"><div class="form-err" id="ep-err"></div><button class="btn primary block" data-sa="save">Save</button></div>`, {
    pick: async () => {
      const file = await pickImage(); if (!file) return;
      try {
        blob = await squarePhoto(file);
        if (preview) URL.revokeObjectURL(preview);
        preview = URL.createObjectURL(blob); removed = false; face();
      } catch (e) { sh.el.querySelector('#ep-err').textContent = e.message; }
    },
    remove: () => { blob = null; preview = ''; removed = true; face(); },
    save: async (b, close) => {
      const name = sh.el.querySelector('#ep-name').value.trim(), err = sh.el.querySelector('#ep-err');
      b.disabled = true; err.textContent = '';
      try {
        if (blob) await uploadAvatar(blob);
        else if (removed && U.avatar) await removeAvatar();
        if (name !== U.name) await updateProfile(name);
        if (preview) URL.revokeObjectURL(preview);
        close(); toast('Profile updated'); refreshAll();
      } catch (e) { err.textContent = e.message; b.disabled = false; }
    },
  });
  function face() {
    const box = sh.el.querySelector('.ph-img'); if (!box) return;
    box.innerHTML = avatarHtml('xl');
    const av = box.querySelector('.avatar');
    if (preview) av.innerHTML = `<img src="${preview}" alt="">`;
    else if (removed) av.textContent = av.dataset.i;
    sh.el.querySelector('[data-sa="remove"]').hidden = !(preview || (U.avatar && !removed));
  }
  face();
}
function sessionsSheet() {
  const sh = openSheet(`<div class="sheet-title">Signed-in devices</div><div class="sheet-body" style="padding:0 16px 16px"><div class="sess-list"><p class="muted">Loading…</p></div><button class="btn light block" data-sa="others" style="margin-top:16px">Sign out everywhere else</button></div>`, {
    others: b => revoke('others', b),
    one: b => revoke(b.dataset.id, b),
  });
  const list = sh.el.querySelector('.sess-list');
  const load = () => listSessions().then(l => {
    list.innerHTML = l.map(x => `<div class="sess-row"><div class="meta"><div class="t">${esc(x.device || 'Device signed in earlier')}</div><div class="s">${x.created ? 'Signed in ' + new Date(x.created * 1000).toLocaleDateString() : 'Sign-in date unknown'}</div></div>${x.current ? '<span class="sess-this">This device</span>' : `<button class="btn ghost sm" data-sa="one" data-id="${esc(x.id)}">Sign out</button>`}</div>`).join('');
  }).catch(e => { list.innerHTML = `<p class="muted">${esc(e.message)}</p>`; });
  async function revoke(id, b) {
    b.disabled = true;
    try { const r = await revokeSession(id); toast(r.removed ? `Signed out ${count(r.removed, 'device')}` : 'No other devices were signed in'); load(); }
    catch (e) { toast(e.message); b.disabled = false; }
  }
  load();
}
function subsonicSheet() {
  const sh = openSheet('<div class="sheet-title">Use other apps</div><div class="sheet-body ss-box" style="padding:0 16px 16px"><p class="muted">Loading…</p></div>', {
    copy: b => navigator.clipboard.writeText(b.dataset.v).then(() => toast('Copied'), () => toast("Couldn't copy")),
    create: b => act('create', b), revoke: b => act('revoke', b),
  });
  const box = sh.el.querySelector('.ss-box');
  const code = (label, v, copy = true) => `<label class="lbl">${label}</label><div class="ss-code"><code>${esc(v)}</code>${copy ? `<button class="btn ghost sm" data-sa="copy" data-v="${esc(v)}">Copy</button>` : ''}</div>`;
  const draw = (d, fresh) => {
    box.innerHTML = '<p class="muted" style="margin-bottom:14px">Add a Subsonic server in apps like Symfonium (Android) or Substreamer and play:Sub (iPhone):</p>'
      + code('Server address', d.server) + code('Username', d.username)
      + (fresh ? code('App password (shown only now)', fresh) + '<p class="muted" style="font-size:13px">Save it in the app now. You can make a new one any time.</p>'
        : `<label class="lbl">App password</label><p class="muted" style="font-size:13px">${d.has_password ? `Created ${new Date(d.created * 1000).toLocaleDateString()}. Make a new one if you lost it.` : 'Apps use an app password instead of your real one.'}</p>`)
      + `<button class="btn primary block" data-sa="create" style="margin-top:16px">${d.has_password ? 'Make a new app password' : 'Create app password'}</button>`
      + (d.has_password ? '<button class="btn ghost block" data-sa="revoke" style="margin-top:10px">Turn off app access</button>' : '');
  };
  async function act(a, b) {
    b.disabled = true;
    try { const d = await subsonicPassword(a); draw(d, d.password); if (a === 'revoke') toast('App access turned off'); }
    catch (e) { toast(e.message); b.disabled = false; }
  }
  subsonicInfo().then(d => draw(d)).catch(e => { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; });
}
function scrobblingSheet() {
  const sh = openSheet('<div class="sheet-title">Scrobbling</div><div class="sheet-body ss-box" style="padding:0 16px 16px"><p class="muted">Loading…</p></div>', {
    'lb-on': b => act(() => connectListenBrainz(sh.el.querySelector('#lb-token').value.trim()), b, 'ListenBrainz connected'),
    'lb-off': b => act(() => disconnectScrobbler('listenbrainz'), b, 'Disconnected'),
    'lf-off': b => act(() => disconnectScrobbler('lastfm'), b, 'Disconnected'),
  });
  const box = sh.el.querySelector('.ss-box');
  const draw = d => {
    const lb = d.listenbrainz, lf = d.lastfm;
    box.innerHTML = '<p class="muted" style="margin-bottom:14px">Songs count after half of them (or 4 minutes) has played.</p><label class="lbl">ListenBrainz</label>'
      + (lb.connected ? `<div class="ss-code"><code>${esc(lb.user || 'Connected')}</code><button class="btn ghost sm" data-sa="lb-off">Disconnect</button></div>`
        : '<input class="input" id="lb-token" placeholder="Paste your ListenBrainz user token" autocomplete="off" spellcheck="false"><button class="btn primary block" data-sa="lb-on" style="margin:10px 0 16px">Connect ListenBrainz</button>')
      + '<label class="lbl">Last.fm</label>'
      + (lf.connected ? `<div class="ss-code"><code>${esc(lf.user || 'Connected')}</code><button class="btn ghost sm" data-sa="lf-off">Disconnect</button></div>`
        : lf.available ? '<a class="btn light block" href="/api/user/scrobbling/lastfm/connect">Connect Last.fm</a>' : '<p class="muted" style="font-size:13px">Last.fm isn\'t set up on this server yet.</p>')
      + (d.last_error ? `<p style="color:var(--danger);font-size:13px;margin-top:12px">Last attempt failed: ${esc(d.last_error)}</p>` : '');
  };
  async function act(fn, b, msg) {
    b.disabled = true;
    try { draw(await fn()); toast(msg); } catch (e) { toast(e.message); b.disabled = false; }
  }
  scrobbleInfo().then(draw).catch(e => { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; });
}
function deleteAccountSheet() {
  const sh = openSheet(`<div class="sheet-title">Delete your account?</div><div class="sheet-body" style="padding:0 16px 16px"><p class="muted" style="margin-bottom:14px">Your likes, playlists and listening history are deleted from ${esc(SITE.site_title || 'this server')} for good.</p><label class="lbl" for="da-pw">Password</label><input class="input" id="da-pw" type="password" autocomplete="current-password"><div class="form-err" id="da-err" role="alert"></div><button class="btn danger block" data-sa="go" style="margin-top:14px">Delete account</button></div>`, {
    go: async (b, close) => {
      const pw = sh.el.querySelector('#da-pw').value, err = sh.el.querySelector('#da-err');
      if (!pw) { err.textContent = 'Enter your password to confirm.'; return; }
      b.disabled = true;
      try { await deleteAccount(pw); close(); toast('Your account was deleted'); refreshAll(); }
      catch (e) { err.textContent = e.message; b.disabled = false; }
    },
  });
}
function changePasswordSheet() {
  const fresh = !U.passwordLogin;
  const sh = openSheet(`<div class="sheet-title">${fresh ? 'Set a password' : 'Change password'}</div><div class="sheet-body" style="padding:0 16px 16px">${fresh ? '<p class="muted" style="font-size:14px">Then you can sign in with a password as well as Discord.</p>' : '<label class="lbl" for="cp-old">Current password</label><input class="input" id="cp-old" type="password" autocomplete="current-password">'}<label class="lbl" for="cp-new">New password</label><input class="input" id="cp-new" type="password" autocomplete="new-password"><label class="lbl" for="cp-new2">Confirm new password</label><input class="input" id="cp-new2" type="password" autocomplete="new-password"><div class="form-err" id="cp-err"></div><button class="btn primary block" data-sa="save">Update password</button></div>`, {
    save: async (b, close) => {
      const g = id => (sh.el.querySelector(id) || {}).value || '', err = sh.el.querySelector('#cp-err');
      if (g('#cp-new').length < minPassword()) { err.textContent = `Use at least ${minPassword()} characters.`; return; }
      if (g('#cp-new') !== g('#cp-new2')) { err.textContent = "The new passwords don't match."; return; }
      b.disabled = true;
      try { await api('/api/user/change_password', { old_password: g('#cp-old'), new_password: g('#cp-new') }); U.passwordLogin = true; close(); toast(fresh ? 'Password set' : 'Password updated'); markDirty(['settings'], true); }
      catch (e) { err.textContent = e.message; b.disabled = false; }
    },
  });
}
function dialog(html, onReady) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-wrap';
    wrap.innerHTML = `<div class="scrim"></div><div class="dialog" role="alertdialog" aria-modal="true">${html}</div>`;
    let result = null;
    const entry = openLayer(wrap, () => resolve(result));
    const finish = v => { result = v; H.closeEntry(entry); };
    wrap.querySelector('.scrim').addEventListener('click', () => finish(null));
    wrap.addEventListener('click', e => { const b = e.target.closest('[data-dv]'); if (b) finish(b.dataset.dv === 'ok' ? (onReady ? onReady.value() : true) : null); });
    if (onReady) onReady.init(wrap, finish);
  });
}
function promptDlg({ title, value = '', ok = 'OK' }) {
  let input;
  return dialog(`<h3>${esc(title)}</h3><input class="field" maxlength="60" value="${esc(value)}" aria-label="${esc(title)}"><div class="btns"><button class="btn ghost" data-dv="cancel">Cancel</button><button class="btn primary" data-dv="ok">${esc(ok)}</button></div>`, {
    init(wrap, finish) {
      input = wrap.querySelector('input');
      input.focus(); input.select();
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); } });
    },
    value: () => input.value.trim() || null,
  });
}
function confirmDlg({ title, text, ok = 'OK', danger }) {
  return dialog(`<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}<div class="btns"><button class="btn ghost" data-dv="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-dv="ok">${esc(ok)}</button></div>`);
}
let toastTimer = 0;
function toast(msg, o = {}) {
  const host = byId('toast');
  host.innerHTML = `<div class="tst"><b>${esc(msg)}</b>${o.action ? `<button type="button">${esc(o.action)}</button>` : ''}</div>`;
  const el = host.firstChild;
  const hide = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  if (o.action) el.querySelector('button').addEventListener('click', () => { hide(); o.onAction(); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, o.ms || (o.action ? 3800 : 2400));
}
/* ======================================================================
   11. Overlays: full player, lyrics & queue
   ====================================================================== */
const el = {
  mini: byId('mini'), miniArt: byId('mini-art'), miniT: byId('mini-t'), miniS: byId('mini-s'), miniLike: byId('mini-like'), miniProg: byId('mini-prog'), miniSlide: byId('mini-slide'),
  player: byId('player'), fpScroll: byId('fp-scroll'), fpArt: byId('fp-art'), fpTitle: byId('fp-title'), fpArtist: byId('fp-artist'), fpLike: byId('fp-like'),
  fpRange: byId('fp-range'), fpCur: byId('fp-cur'), fpDur: byId('fp-dur'), fpFromK: byId('fp-from-k'), fpFromN: byId('fp-from-n'), fpCards: byId('fp-cards'), fpDev: byId('fp-dev'),
  lyrics: byId('lyrics'), lyBody: byId('ly-body'), lyRange: byId('ly-range'), lyCur: byId('ly-cur'), lyDur: byId('ly-dur'), lyT: byId('ly-t'), lyS: byId('ly-s'),
  queue: byId('queue'), qBody: byId('q-body'), qFrom: byId('q-from'),
};
const overlay = { player: null, lyrics: null, queue: null };
function openOverlay(name) {
  if (overlay[name]) return;
  const node = el[name];
  node.classList.add('open'); node.setAttribute('aria-hidden', 'false');
  if (name === 'player') { document.body.classList.add('fp-open'); requestAnimationFrame(fitTitle); renderCards(); themePlayer(); }
  if (name === 'queue') renderQueue();
  if (name === 'lyrics') { renderLyrics(); requestAnimationFrame(() => syncLyrics(true)); }
  overlay[name] = { kind: 'layer', close: () => {
    overlay[name] = null;
    node.classList.remove('open', 'dragging'); node.style.transform = ''; node.setAttribute('aria-hidden', 'true');
    if (name === 'player') { document.body.classList.remove('fp-open'); setThemeColor('#121212'); fpViz(); }
  } };
  H.push(overlay[name]);
  if (name === 'player') fpViz();
}
const closeOverlay = name => { if (overlay[name]) H.closeEntry(overlay[name]); };
// Visuals painted from the cover and driven by the music (web/app/immersive.js); they run only while Now Playing is open.
let fpScene = null;
function fpViz() {
  const Vis = window.AX.Vis;
  if (!Vis) return;
  if (!fpScene) fpScene = Vis.mount(byId('fp-viz'), { art: el.fpArt, len: .2 });
  const on = Vis.on && !!overlay.player;
  el.player.classList.toggle('viz', on); byId('fp-viz-btn').classList.toggle('on', Vis.on);
  if (on) { const t = curTrack(); fpScene.setTrack(t ? coverUrl(t.rel) : ''); fpScene.start(); } else fpScene.stop();
}
function themePlayer() {
  const t = curTrack();
  if (!t) return;
  if (!S.dynColor) { ['--pc', '--lc'].forEach(v => document.documentElement.style.removeProperty(v)); el.mini.style.removeProperty('--mc'); return; }
  const src = coverUrl(t.rel);
  dominant(src).then(c => {
    if (!c || curTrack() !== t) return;
    const root = document.documentElement.style;
    root.setProperty('--pc', tone(c, .3, .3));
    root.setProperty('--lc', tone(c, .4, .45, .75));
    el.mini.style.setProperty('--mc', tone(c, .26, .25));
    if (overlay.player) setThemeColor(`rgb(${tone(c, .3, .3)})`);
  });
}
function fitTitle() {
  const box = el.fpTitle, span = box.firstElementChild;
  box.classList.remove('marquee');
  const over = span.scrollWidth - box.clientWidth;
  if (over > 4) { box.style.setProperty('--shift', `-${over + 48}px`); box.style.setProperty('--dur', `${Math.max(6, (over + 48) / 28)}s`); box.classList.add('marquee'); }
}
// AX.UI.track — core has already marked playing rows, like buttons, the tab title and the media session.
function onTrackChange(t) {
  el.mini.classList.toggle('hide', !t);
  if (!t) return;
  const al = albumOf(t), src = coverUrl(t.rel);
  el.miniArt.src = src; el.miniT.textContent = t.title; el.miniS.textContent = t.artist; el.miniS.classList.remove('remote');
  el.fpArt.src = src; el.fpTitle.firstElementChild.textContent = t.title; el.fpArtist.textContent = t.artist;
  if (fpScene && fpScene.running) fpScene.setTrack(src);
  el.lyT.textContent = t.title; el.lyS.textContent = t.artist;
  const c = P.ctx;
  const kind = { album: 'Playing from album', artist: 'Playing from artist', playlist: 'Playing from playlist', liked: 'Playing from playlist', mix: 'Playing from mix', search: 'Playing from search', library: 'Playing from', list: 'Playing from' }[c && c.type] || 'Now playing';
  el.fpFromK.textContent = P.fromQueue ? 'Playing from queue' : kind;
  el.fpFromN.textContent = c ? c.name : al.title;
  themePlayer();
  if (overlay.player) { requestAnimationFrame(fitTitle); renderCards(); }
}
function showRemote(name) {
  el.miniS.textContent = `Playing on ${name}`; el.miniS.classList.add('remote');
  el.fpDev.innerHTML = `${ic('pc', 'sm')}<span class="ell">Playing on ${esc(name)}</span>`;
}
let lastSec = -1, scrubbing = false;
function updateProgress(force) {
  const dur = (P.pending ? P.dur : audio.duration) || P.dur || 0;
  const cur = P.pending ? P.pending.t : audio.currentTime || 0;
  const f = dur ? clamp(cur / dur, 0, 1) : 0;
  el.miniProg.style.transform = `scaleX(${f})`;
  if (!scrubbing && (overlay.player || overlay.lyrics || force)) {
    [el.fpRange, el.lyRange].forEach(r => { r.value = Math.round(f * 1000); r.style.setProperty('--pct', f * 100 + '%'); });
  }
  const sec = Math.floor(cur);
  if (sec !== lastSec || force) {
    lastSec = sec;
    if (!scrubbing) { el.fpCur.textContent = el.lyCur.textContent = fmt(cur); }
    el.fpDur.textContent = el.lyDur.textContent = fmt(dur);
  }
}
function bindRange(r) {
  r.addEventListener('input', () => {
    scrubbing = true;
    const dur = (P.pending ? P.dur : audio.duration) || 0, v = r.value / 1000;
    r.style.setProperty('--pct', v * 100 + '%');
    el.fpCur.textContent = el.lyCur.textContent = fmt(v * dur);
  });
  r.addEventListener('change', () => {
    const dur = (P.pending ? P.dur : audio.duration) || 0;
    seek(r.value / 1000 * dur);
    scrubbing = false;
    updateProgress(true);
  });
}
bindRange(el.fpRange); bindRange(el.lyRange);

function renderCards() {
  const t = curTrack(); if (!t) { el.fpCards.innerHTML = ''; return; }
  const ar = artistOf(t);
  const up = (P.queue.length ? P.queue.slice(0, 3) : upcoming(3).map(u => u.id)).map(id => L.tracks[id]).filter(Boolean);
  el.fpCards.innerHTML = `<div class="fp-card lyr-card" data-act="open-lyrics"><div class="fp-card-h"><span>Lyrics</span><button data-act="open-lyrics">${ic('mic', 'sm')}Show lyrics</button></div><div class="lyr-peek"><div class="lyr-lines" id="lyr-peek"></div></div></div>`
    + (up.length ? `<div class="fp-card next-card"><div class="fp-card-h"><span>Next in queue</span><button data-act="open-queue">Open queue</button></div><div style="padding:6px 0 8px">${up.map(u => `<div class="row" data-act="open-queue"><div class="row-art">${img(coverUrl(u.rel))}</div><div class="meta"><div class="t">${esc(u.title)}</div><div class="s"><span>${esc(u.artist)}</span></div></div></div>`).join('')}</div></div>` : '')
    + `<div class="fp-card about-card" data-act="open-cur-artist"><div class="about-img">${img(coverUrl(ar.cover))}<span>About the artist</span></div><div class="about-body"><div class="flex1"><b>${esc(ar.name)}</b><div class="muted" style="font-size:13px;margin-top:3px">${count(ar.trackIds.length, 'song')} • ${count(ar.albumIds.length, 'release')}</div></div><button class="pill-btn${U.follows.includes(ar.key) ? ' on' : ''}" data-act="follow" data-id="${ar.id}" data-follow="${ar.id}">${U.follows.includes(ar.key) ? 'Following' : 'Follow'}</button></div></div>`;
  renderLyricsPeek();
}

/* Lyrics (loading & timing live in core; this renders them) */
let lyTouchedAt = 0;
function renderLyrics() {
  const box = el.lyBody;
  box.classList.toggle('lyr-plain', !LY.synced);
  box.innerHTML = LY.state === 'ok' ? LY.lines.map((l, i) => `<div class="ll" data-ly="${i}">${esc(l.text) || '&nbsp;'}</div>`).join('') : `<div class="lyr-msg">${esc(lyMsg())}</div>`;
  renderLyricsPeek();
}
function renderLyricsPeek() {
  const peek = byId('lyr-peek'); if (!peek) return;
  const card = peek.closest('.fp-card');
  if (card) card.hidden = LY.state === 'none';
  peek.innerHTML = LY.state === 'ok' ? LY.lines.map((l, i) => `<div class="ll${!LY.synced ? ' on' : ''}" data-ly="${i}">${esc(l.text) || '&nbsp;'}</div>`).join('') : `<div class="lyr-msg">${esc(lyMsg())}</div>`;
  LY.idx = -1;
  syncLyrics(true);
}
// AX.UI.lyricLine — core found the active line; highlight it and keep it in view.
function lyricLine(i, force) {
  [el.lyBody, byId('lyr-peek')].forEach(box => {
    if (!box) return;
    $$('.ll', box).forEach((n, k) => { n.classList.toggle('on', k === i); n.classList.toggle('past', k < i); });
  });
  const line = i >= 0 ? el.lyBody.querySelector(`[data-ly="${i}"]`) : null;
  if (overlay.lyrics && line && now() - lyTouchedAt > 3500) el.lyBody.scrollTo({ top: line.offsetTop - el.lyBody.clientHeight * .32, behavior: force ? 'auto' : 'smooth' });
  const peek = byId('lyr-peek');
  if (peek) { const pl = i >= 0 ? peek.querySelector(`[data-ly="${i}"]`) : null; peek.style.transform = `translateY(${pl ? -Math.max(0, pl.offsetTop - 70) : 0}px)`; }
}
el.lyBody.addEventListener('touchstart', () => { lyTouchedAt = now(); }, { passive: true });
el.lyBody.addEventListener('click', e => { const l = e.target.closest('.ll'); if (l && LY.synced) { seek(LY.lines[+l.dataset.ly].t); lyTouchedAt = 0; if (audio.paused) play(); } });

/* Queue */
function refreshQueue() { if (overlay.queue) renderQueue(); if (overlay.player) renderCards(); }
function renderQueue() {
  const t = curTrack();
  el.qFrom.textContent = P.ctx ? `Playing from ${P.ctx.name}` : '';
  if (!t) { el.qBody.innerHTML = emptyHtml('queue', 'Your queue is empty', 'Play something to get started.'); return; }
  const qrow = (id, idx, kind, removable) => { const x = L.tracks[id]; return `<div class="trk" data-q="${kind}" data-qi="${idx}" data-t="${id}"><div class="row-art">${img(coverUrl(x.rel))}</div><div class="meta"><div class="t">${esc(x.title)}</div><div class="s"><span class="dl-slot" data-dl="${id}">${dlBadge(x.rel)}</span><span>${esc(x.artist)}</span></div></div>${removable ? `<button class="row-act" data-act="q-remove" data-qi="${idx}" aria-label="Remove">${ic('minus-c', 'md')}</button><div class="drag-h" data-drag aria-label="Reorder">${ic('drag')}</div>` : ''}</div>`; };
  let h = `<div class="q-sec">Now playing</div><div class="trk playing" data-act="close-queue" data-t="${t.id}"><div class="row-art">${img(coverUrl(t.rel))}${EQB}</div><div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span>${esc(t.artist)}</span></div></div></div>`;
  if (P.queue.length) h += `<div class="q-sec"><span>Next in queue</span><button data-act="q-clear">Clear queue</button></div><div class="rows" id="q-user">${P.queue.map((id, i) => qrow(id, i, 'user', true)).join('')}</div>`;
  const up = upcoming(60);
  if (up.length) h += `<div class="q-sec"><span>Next from: ${esc(P.ctx.name)}</span></div><div class="rows">${up.map(u => qrow(u.id, u.pos, 'ctx', false)).join('')}</div>`;
  else if (S.autoplay) h += `<div class="list-foot">${ic('radio', 'sm')} Autoplay will keep similar music going after this.</div>`;
  el.qBody.innerHTML = h;
  const userList = byId('q-user');
  if (userList) dragSort(userList, '.trk', '.q-body', queueMove);
}
el.qBody.addEventListener('click', e => {
  if (e.target.closest('[data-act]')) return;
  const row = e.target.closest('.trk[data-q]'); if (!row) return;
  e.stopPropagation();
  const i = +row.dataset.qi;
  if (row.dataset.q === 'user') queueJump(i); else ctxJump(i);
  haptic();
}, true);

/* ======================================================================
   12. Actions, gestures, Connect & boot
   ====================================================================== */
const ACT = {
  back: goBack,
  tab: b => switchTab(b.dataset.tab),
  nav: b => { if (b.dataset.view === curPage().view) return; openPage(b.dataset.view, {}); },
  open: b => {
    const k = b.dataset.k, id = b.dataset.id;
    const pg = curPage();
    if (pg && pg.view === 'find') {
      const key = k === 'album' ? L.albums[+id] && L.albums[+id].key : k === 'artist' ? L.artists[+id] && L.artists[+id].key : k === 'track' ? L.tracks[+id] && L.tracks[+id].rel : id;
      if (key != null) rememberSearch(k, key);
    }
    openItem(k, id);
  },
  discog: b => openPage('discog', { key: L.artists[+b.dataset.id].key }),
  'play-ctx': b => {
    const ctx = CTX.get(b.dataset.pc); if (!ctx) return;
    haptic();
    if (ctxPlaying(ctx)) togglePlay(); else playCtx(ctx, -1);
  },
  toggle: togglePlay,
  next: () => { haptic(); next(); },
  prev,
  shuffle: () => setShuffle(!P.shuffle),
  repeat: cycleRepeat,
  'shuffle-all': () => { haptic(); shuffleAll(); },
  like: b => toggleLike(L.tracks[+b.dataset.t], b),
  'like-cur': b => toggleLike(curTrack(), b),
  more: b => {
    const row = b.closest('[data-ctx]'), ctx = row && CTX.get(row.dataset.ctx);
    trackSheet(L.tracks[+b.dataset.t], { plName: ctx && ctx.plName, cplId: ctx && ctx.cplId });
  },
  'more-cur': () => { const t = curTrack(); if (t) trackSheet(t, { player: true }); },
  'more-ctx': b => ctxSheet(b.dataset.k, b.dataset.id),
  'open-player': () => { if (curTrack()) { haptic(); openOverlay('player'); } },
  'close-player': () => closeOverlay('player'),
  viz: () => { if (!window.AX.Vis) return; haptic(); window.AX.Vis.toggle(); fpViz(); toast(window.AX.Vis.on ? 'Visuals on' : 'Visuals off'); },
  'open-lyrics': () => openOverlay('lyrics'),
  'close-lyrics': () => closeOverlay('lyrics'),
  'open-queue': () => openOverlay('queue'),
  'party': () => afterLayers(() => openPage('party')),
  'party-join': b => window.AX.Party && window.AX.Party.join('', b.dataset.id),
  'close-queue': () => closeOverlay('queue'),
  'open-cur-artist': () => { const t = curTrack(); if (t) afterLayers(() => openPage('artist', { id: t.artistId })); },
  'open-ctx': () => {
    const c = P.ctx; if (!c) return;
    const k = c.recent || '';
    if (k.startsWith('album:')) { const al = L.albumByKey.get(k.slice(6)); if (al) afterLayers(() => openPage('album', { id: al.id })); }
    else if (k.startsWith('artist:')) { const ar = L.artistByKey.get(k.slice(7)); if (ar) afterLayers(() => openPage('artist', { id: ar.id })); }
    else if (k.startsWith('playlist:')) afterLayers(() => openPage('playlist', { name: k.slice(9) }));
    else if (k.startsWith('mix:')) afterLayers(() => openPage('mix', { id: k.slice(4) }));
    else if (k === 'liked') afterLayers(() => openPage('liked'));
    else if (k === 'downloads') afterLayers(() => openPage('downloads'));
  },
  devices: devicesSheet,
  sleep: sleepSheet,
  'share-cur': () => { const t = curTrack(); if (t) share(t.title, `${t.title} by ${t.artist}`, trackLink(t)); },
  'dl-ctx': b => { const ctx = CTX.get(b.dataset.dlc); if (ctx) toggleCtxDownload(ctx); },
  'save-album': b => toggleSaveAlbum(L.albums[+b.dataset.id]),
  follow: b => toggleFollow(L.artists[+b.dataset.id]),
  'artist-more': () => { const pg = curPage(); pg.state.more = !pg.state.more; renderPage(pg, true); },
  'discog-filter': b => { const pg = curPage(); pg.state.f = b.dataset.f; renderPage(pg, true); },
  'find-filter': b => { const pg = curPage(); if (pg.view === 'find') { pg.state.f = b.dataset.f; pg.rerunSearch(); pg.el.scrollTop = 0; } },
  'forget-search': b => { forgetSearch(b.dataset.sk, b.dataset.skey); curPage().rerunSearch(); },
  'clear-searches': () => { clearSearches(); curPage().rerunSearch(); },
  'new-playlist': () => {
    if (!collabOn() || !Social.friends().length) { createPlaylist([]); return; }
    openSheet(`<div class="sheet-title">Create</div><div class="sheet-body">${si('pl', 'note', 'Playlist', { note: 'Just for you' })}${si('cpl', 'people', 'Collaborative playlist', { note: 'With friends' })}</div>`, {
      pl: (b, close) => close().then(() => createPlaylist([])), cpl: (b, close) => close().then(newCollab),
    });
  },
  'lib-filter': b => { const pg = curPage(); pg.state.f = pg.state.f === b.dataset.f ? '' : b.dataset.f; renderPage(pg); },
  'lib-sort': () => sortSheet(S.libSort, Object.entries(SORTS), k => { S.libSort = k; saveS(); markDirty(['library'], true); }),
  'lib-view': () => { S.libView = S.libView === 'grid' ? 'list' : 'grid'; saveS(); markDirty(['library'], true); },
  'lib-search': () => { const pg = curPage(); pg.state.searching = !pg.state.searching; pg.state.q = ''; pg.state.focus = pg.state.searching; renderPage(pg); },
  'liked-sort': () => { const pg = curPage(); sortSheet(pg.state.sort, [['recent', 'Recently added'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album']], k => { pg.state.sort = k; renderPage(pg); }); },
  'pl-add': () => addSongsSheet(curPage().params.name),
  'pl-add-one': b => { const n = curPage().params.name; addToPlaylist(n, [+b.dataset.t]); toast(`Added to ${n}`); haptic(10); },
  'pl-edit': () => { const pg = curPage(); pg.state.edit = !pg.state.edit; renderPage(pg, true); },
  'pl-remove': b => { const pg = curPage(), t = L.tracks[+b.dataset.t]; removeFromPlaylist(pg.params.name, [t.rel]); toast(`Removed from ${pg.params.name}`, { action: 'Undo', onAction: () => addToPlaylist(pg.params.name, [t.id]) }); },
  'mix-save': b => { const m = getMix(b.dataset.id); if (m) saveMixAsPlaylist(m); },
  'q-clear': queueClear,
  'q-remove': b => { queueRemove(+b.dataset.qi); haptic(); },
  'dl-remove-all': async () => { if (Off.set.size && await confirmDlg({ title: 'Remove all downloads?', text: `${count(Off.set.size, 'song')} will be removed from this device.`, ok: 'Remove', danger: true })) { await Off.removeAll(); toast('All downloads removed'); } },
  'dl-cancel-all': () => { Off.cancel([...Off.queue, ...Off.active.keys()]); toast('Downloads cancelled'); markDirty(['downloads'], true); },
  'set-autoplay': () => { S.autoplay = !S.autoplay; saveS(); markDirty(['settings'], true); },
  'set-smart': () => { S.smart = S.smart === false; saveS(); window.AX.SM.refresh(); markDirty(['settings'], true); },
  'set-matchvol': () => { S.matchVol = !S.matchVol; saveS(); window.AX.SM.refresh(); markDirty(['settings'], true); },
  'set-normalize': toggleNormalize,
  'set-dyncolor': () => { S.dynColor = !S.dynColor; saveS(); if (!S.dynColor) $$('.page').forEach(p => p.style.removeProperty('--c')); themePlayer(); refreshAll(); },
  'set-boost': boostSheet,
  boost: b => setBoost(+b.dataset.v),
  'set-accent': b => setAccent(b.dataset.c),
  'eq-toggle': toggleEq,
  'eq-preset': b => setEqPreset(b.dataset.p),
  'rename-device': async () => { const n = await promptDlg({ title: 'Device name', value: Connect.name, ok: 'Save' }); if (n) { Connect.rename(n); markDirty(['settings'], true); } },
  'clear-cache': async () => { if (!(await confirmDlg({ title: 'Clear cached data?', text: 'The library will be downloaded again. Your downloads, likes and playlists are kept.', ok: 'Clear' }))) return; try { await caches.delete(META_CACHE); } catch (e) { /* ignore */ } location.reload(); },
  'desktop-site': () => { document.cookie = 'axdio_view=desktop; path=/; max-age=31536000; samesite=lax'; location.href = '/'; },
  logout: async () => { if (await confirmDlg({ title: 'Log out?', text: 'Downloads stay on this device.', ok: 'Log out' })) { Social.stop(); signOut(); } },
  'fa-play': b => { const t = L.byRel.get(b.dataset.rel); if (t) playTrackAlone(t.id); },
  'discord-link': () => discordLink(),
  'discord-unlink': async () => { if (await confirmDlg({ title: 'Disconnect Discord?', text: "You won't be able to sign in with Discord until you connect it again.", ok: 'Disconnect' })) { try { await discordUnlink(); toast('Discord disconnected'); markDirty(['settings'], true); } catch (e) { toast(e.message); } } },
  'presence-setup': () => presenceSheet(),
  'open-user': b => openPage('user', { u: b.dataset.u }),
  'friend-act': b => friendAct(b.dataset.a, b.dataset.u),
  'friend-more': b => friendSheet(b.dataset.u),
  dm: b => openDM(b.dataset.u),
  'fr-tab': b => { const pg = curPage(); pg.state.tab = b.dataset.t; renderPage(pg); },
  'blocked-list': () => {
    const list = Social.me.blocked || [];
    openSheet(`<div class="sheet-title">Blocked people</div><div class="sheet-body">${list.length ? list.map(c => `<div class="pick">${personAvatar(c, 'pr-av')}<div class="meta"><div class="t">${esc(c.display_name)}</div><div class="s"><span>@${esc(c.username)}</span></div></div><button class="btn ghost sm" data-sa="unblock" data-u="${esc(c.username)}">Unblock</button></div>`).join('') : '<p class="list-foot" style="text-align:center">Nobody is blocked.</p>'}</div>`,
      { unblock: async b => { await friendAct('unblock', b.dataset.u); b.closest('.pick').remove(); } });
  },
  'set-share-activity': () => Social.setting('share_activity', !(Social.me.settings || {}).share_activity).then(() => markDirty(['settings'], true)).catch(e => toast(e.message)),
  'set-discoverable': () => Social.setting('discoverable', !(Social.me.settings || {}).discoverable).then(() => markDirty(['settings'], true)).catch(e => toast(e.message)),
  'open-chat': b => openPage('thread', { c: b.dataset.c }),
  'new-chat': () => newChat(),
  'chat-older': () => Chat.older(curPage().params.c),
  'chat-more': () => { const c = Chat.byId.get(curPage().params.c); if (c) chatSheet(c); },
  'chat-attach': () => { const t = curTrack(); if (!t) { toast('Play something first, then share it here'); return; } Chat.send(curPage().params.c, '', { a: attachTrack(t) }).catch(e => toast(e.message)); },
  'att-open': b => {
    const k = b.dataset.k, id = b.dataset.id;
    if (k === 'track') { const t = L.tracks[+id]; if (t) openPage('album', { id: t.albumId }); } else if (k === 'album') openPage('album', { id: +id }); else if (k === 'artist') openPage('artist', { id: +id }); else if (k === 'cpl') openPage('cpl', { id });
  },
  'att-play': b => { const k = b.dataset.k, id = b.dataset.id; if (k === 'track') { playTrackAlone(+id); return; } const ctx = itemCtx(k, id); if (ctx) playCtx(ctx, -1); },
  safety: b => safetySheet(b.dataset.u),
  'group-info': () => groupSheet(curPage().params.c),
  'e2ee-setup': () => e2eeSetup(false),
  'e2ee-unlock': () => unlockSheet(),
  'e2ee-link': () => linkSheet(),
  'e2ee-reset': async () => { if (await confirmDlg({ title: 'Reset private messages?', text: "New keys for your account: messages sent before can't be read on any of your devices, and friends see that your security code changed.", ok: 'Reset', danger: true })) e2eeSetup(true); },
  'rk-show': () => { const rk = E2EE.recoveryKey(); if (rk) recoverySheet(rk, false); else toast("This phone doesn't have your recovery key. Make a new one instead."); },
  'rk-new': async () => { if (await confirmDlg({ title: 'Make a new recovery key?', text: 'The old one stops working.', ok: 'Make new key' })) { try { recoverySheet(await E2EE.newRecoveryKey(), true); } catch (e) { toast(e.message); } } },
  'cpl-add': () => addToCollabSheet(curPage().params.id),
  'cpl-invite': () => inviteSheet({ cid: curPage().params.id }),
  'cpl-remove': b => { const pg = curPage(), t = L.tracks[+b.dataset.t]; Collab.remove(pg.params.id, [t.rel]); toast('Removed', { action: 'Undo', onAction: () => Collab.add(pg.params.id, [t.id]) }); },
  'edit-profile': editProfileSheet,
  'change-pw': changePasswordSheet,
  quality: b => qualitySheet(!!b.dataset.cell),
  'devices-signed': sessionsSheet,
  subsonic: subsonicSheet,
  scrobbling: scrobblingSheet,
  'delete-account': deleteAccountSheet,
  'export-data': () => exportMyData().then(() => toast('Downloading your data'), e => toast(e.message)),
  'auth-mode': b => { const pg = curPage(); pg.state.mode = b.dataset.m; renderPage(pg); },
};

/* Gestures: long-press menus, swipe-to-queue, swipe-to-skip, drag-to-close */
const G = { row: null, x0: 0, y0: 0, dx: 0, mode: '', lp: 0, lpAt: 0 };
function longPress(target) {
  const t = target.dataset.t != null && target.classList.contains('trk') ? L.tracks[+target.dataset.t] : null;
  if (t && !target.dataset.q) { const list = target.closest('[data-ctx]'), ctx = list && CTX.get(list.dataset.ctx); trackSheet(t, { plName: ctx && ctx.plName, cplId: ctx && ctx.cplId }); return; }
  const k = target.dataset.k;
  if (k === 'album' || k === 'artist' || k === 'playlist' || k === 'mix' || k === 'liked') ctxSheet(k, target.dataset.id);
  else if (k === 'track') trackSheet(L.tracks[+target.dataset.id]);
}
const PRESSABLE = '.trk[data-t], .row[data-k], .card[data-k], .qt[data-k], .top-res[data-k]';
document.addEventListener('touchstart', e => {
  if (e.touches.length > 1) return;
  const row = e.target.closest(PRESSABLE);
  if (!row || e.target.closest('button, input, [data-drag], .sheet .trk')) { G.row = null; return; }
  G.row = row; G.x0 = e.touches[0].clientX; G.y0 = e.touches[0].clientY; G.dx = 0; G.mode = '';
  clearTimeout(G.lp);
  G.lp = setTimeout(() => { G.mode = 'lp'; G.lpAt = now(); haptic(18); longPress(row); }, 480);
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!G.row || G.mode === 'lp') return;
  const dx = e.touches[0].clientX - G.x0, dy = e.touches[0].clientY - G.y0;
  if (!G.mode && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    clearTimeout(G.lp);
    const canSwipe = G.row.classList.contains('trk') && !G.row.closest('#queue, #layers') && dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.4;
    G.mode = canSwipe ? 'swipe' : 'scroll';
    if (canSwipe) { G.row.style.contentVisibility = 'visible'; G.row.insertAdjacentHTML('afterbegin', `<div class="swipe-hint">${ic('queue')}</div>`); }
  }
  if (G.mode === 'swipe') {
    const was = G.dx >= 90;
    G.dx = Math.max(0, Math.min(dx, 160));
    G.row.style.transform = `translateX(${G.dx}px)`;
    if (!was && G.dx >= 90) haptic(12);
  }
}, { passive: true });
function endTouch() {
  clearTimeout(G.lp);
  if (G.mode === 'swipe' && G.row) {
    const row = G.row, done = G.dx >= 90;
    row.style.transition = 'transform .25s var(--ease)'; row.style.transform = '';
    setTimeout(() => { row.style.transition = ''; row.style.contentVisibility = ''; const h = row.querySelector('.swipe-hint'); if (h) h.remove(); }, 260);
    if (done) addToQueue([+row.dataset.t]);
    G.lpAt = now();
  }
  G.row = null; G.mode = '';
}
document.addEventListener('touchend', endTouch, { passive: true });
document.addEventListener('touchcancel', endTouch, { passive: true });
document.addEventListener('contextmenu', e => {
  const row = e.target.closest(PRESSABLE);
  if (!row) return;
  e.preventDefault();
  if (now() - G.lpAt > 800) { G.lpAt = now(); longPress(row); }
});
// Capture phase: the click synthesised after a long-press or swipe must not reach whatever just opened under the finger.
document.addEventListener('click', e => {
  if (now() - G.lpAt < 650) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a && !a.closest('[data-sa]')) {
    const fn = ACT[a.dataset.act];
    if (fn) { e.preventDefault(); fn(a, e); }
    return;
  }
  const row = e.target.closest('.trk[data-t]');
  if (row && !row.closest('#layers, #queue')) playRow(row);
});
function playRow(row) {
  const id = +row.dataset.t, t = L.tracks[id]; if (!t) return;
  if (!navigator.onLine && !Off.set.has(t.rel)) { toast("This song isn't downloaded"); return; }
  const list = row.closest('[data-ctx]'), ctx = list && CTX.get(list.dataset.ctx);
  if (!ctx) { playTrackAlone(id); return; }
  if (P.cur === id && ctxPlaying(ctx)) { togglePlay(); return; }
  haptic();
  if (ctx.type === 'search') rememberSearch('track', t.rel);
  playCtx(ctx, +row.dataset.i);
}
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
  else if (e.key === 'Escape') goBack();
});

// Drag a panel down to dismiss it (full player, lyrics, queue, sheets).
function dragToClose(panel, scrollSel, onClose, filter) {
  let y0 = 0, x0 = 0, dy = 0, t0 = 0, active = false, decided = false;
  const scroller = () => (scrollSel ? panel.querySelector(scrollSel) : null);
  panel.addEventListener('touchstart', e => {
    if (e.touches.length > 1 || e.target.closest('input[type=range], [data-drag], .shelf, .eq-svg') || (filter && !filter(e))) { active = false; return; }
    const sc = scroller();
    if (sc && sc.scrollTop > 0 && sc.contains(e.target)) { active = false; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; t0 = now(); active = true; decided = false;
  }, { passive: true });
  panel.addEventListener('touchmove', e => {
    if (!active) return;
    const d = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (!decided) {
      if (Math.abs(d) < 8 && Math.abs(dx) < 8) return;
      decided = true;
      if (d <= 0 || Math.abs(dx) > Math.abs(d)) { active = false; return; }
      panel.classList.add('dragging');
    }
    dy = Math.max(0, d);
    e.preventDefault();
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    panel.classList.remove('dragging');
    if (!decided) return;
    const v = dy / Math.max(1, now() - t0);
    if (dy > 140 || (dy > 40 && v > .6)) { panel.style.transform = ''; onClose(); }
    else panel.style.transform = '';
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}
dragToClose(el.player, null, () => closeOverlay('player'), () => el.fpScroll.scrollTop <= 0);
dragToClose(el.lyrics, null, () => closeOverlay('lyrics'), e => !el.lyBody.contains(e.target) || el.lyBody.scrollTop <= 0);
dragToClose(el.queue, null, () => closeOverlay('queue'), e => !el.qBody.contains(e.target) || el.qBody.scrollTop <= 0);

// Horizontal swipes on the mini player and full-player artwork skip tracks.
function swipeSkip(target, moveEl) {
  let x0 = 0, y0 = 0, dx = 0, on = false, decided = false;
  target.addEventListener('touchstart', e => { if (e.target.closest('button')) { on = false; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; on = true; decided = false; }, { passive: true });
  target.addEventListener('touchmove', e => {
    if (!on) return;
    const ddx = e.touches[0].clientX - x0, ddy = e.touches[0].clientY - y0;
    if (!decided) { if (Math.abs(ddx) < 10 && Math.abs(ddy) < 10) return; decided = true; if (Math.abs(ddy) > Math.abs(ddx)) { on = false; return; } }
    dx = ddx; moveEl.style.transition = 'none'; moveEl.style.transform = `translateX(${dx}px)`; moveEl.style.opacity = String(1 - Math.min(.6, Math.abs(dx) / 300));
  }, { passive: true });
  target.addEventListener('touchend', () => {
    if (!on) return;
    on = false;
    moveEl.style.transition = ''; moveEl.style.opacity = '';
    if (Math.abs(dx) > 70) {
      G.lpAt = now();
      moveEl.style.transform = `translateX(${dx > 0 ? 40 : -40}px)`;
      setTimeout(() => { moveEl.style.transform = ''; }, 30);
      if (dx < 0) next(); else { if (audio.currentTime > 3) audio.currentTime = 0; prev(); }
    } else moveEl.style.transform = '';
  }, { passive: true });
}
swipeSkip(el.mini, el.miniSlide);
swipeSkip(el.fpArt, el.fpArt);

/* Boot */
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
    setTimeout(() => { o.style.transition = 'opacity .35s ease'; o.style.opacity = '0'; setTimeout(() => o.remove(), 360); }, Math.max(0, 1100 - (now() - this.t0)));
  },
};
if (Boot.overlay) Boot.overlay.addEventListener('click', () => Boot.done());

async function boot() {
  Boot.log('SYS', `Axdio mobile engine 3.1 — ${IOS ? 'iOS' : /Android/.test(navigator.userAgent) ? 'Android' : 'mobile'} session, ${D.els.length === 2 ? 'gapless' : 'single-deck'} audio`);
  if (history.state && history.state.axd) { H.skip++; history.go(-history.state.axd); }
  document.cookie = 'axdio_view=; path=/; max-age=0';
  showTab('home');
  await AX.boot({ platform: 'mobile', log: (type, text) => Boot.log(type, text), onLibrary: refreshAll });
  refreshAll();
  if (U.token) Social.start();
  const note = takeDiscordNote();
  if (note && note.invite) {
    const code = await promptDlg({ title: 'Invite code for this server', value: '', ok: 'Sign up' });
    if (code) { try { await discordFinish(code.toUpperCase()); toast(`Welcome, ${U.name || U.username}!`); refreshAll(); Social.start(); } catch (e) { toast(e.message); } }
  } else if (note && note.text) setTimeout(() => toast(note.text), 600);
  handleDeepLink();
  if (pendingInvite() && !U.token && SITE.registration !== 'closed' && !document.getElementById('ax-gate')) openPage('profile', { mode: 'register' });
  Boot.log('OK', 'Startup complete. Tap anywhere to continue.');
  Boot.done();
}
function handleDeepLink() {
  const q = new URLSearchParams(location.search);
  const lf = q.get('lastfm');
  if (lf) {
    toast({ connected: 'Last.fm connected', failed: "Couldn't connect Last.fm", unavailable: "Last.fm isn't set up on this server" }[lf] || 'Last.fm');
    history.replaceState(history.state, '', location.pathname);
    return;
  }
  const play = q.get('play'), album = q.get('album'), artist = q.get('artist');
  if (!play && !album && !artist) return;
  history.replaceState(history.state, '', location.pathname);
  if (play) {
    const t = L.byRel.get(play);
    if (!t) { toast("That song isn't in the library anymore"); return; }
    P.queue = [];
    stageTrack(t);
    toast(`Ready to play "${t.title}"`, { action: 'Play', onAction: play });
    return;
  }
  const al = album ? L.albumByKey.get(album) : null, ar = artist ? L.artistByKey.get(artist.toLowerCase()) : null;
  if (!al && !ar) return;
  // Deep links render as a page without a history entry (browsers ignore entries pushed before a tap).
  const pg = mkPage(al ? 'album' : 'artist', { key: al ? al.key : ar.key }, 'home');
  hidePage(curPage());
  T.stacks.home.push(pg);
  showPage(pg, 'fade');
}

// Plug this view into the engine.
Object.assign(UI, {
  party(v) { document.querySelectorAll('[data-act="party"]').forEach(b => b.classList.toggle('on', !!v)); },
  openParty() { if (!(curPage() && curPage().view === 'party')) afterLayers(() => openPage('party')); },
  track: onTrackChange, queue: refreshQueue, progress: updateProgress, lyrics: renderLyrics, lyricLine,
  remote: showRemote, dirty: markDirty, refresh: refreshAll, toast, confirm: confirmDlg, pickPlaylist: playlistPicker, social: onSocial,
});
Object.assign(window.AX, { H, T, openPage, toast });   // debug handles
boot().catch(err => {
  console.error(err);
  Boot.log('WARN', 'Startup error: ' + err.message);
  Boot.done();
});
}

// Flask caches the page template until the server restarts, so an older shell may still be served
// that neither loads core.js nor carries the data-* hooks it drives. Upgrade it in place.
(function bootstrap() {
  [['mini-pp', 'data-pp'], ['fp-pp', 'data-pp'], ['ly-pp', 'data-pp'], ['q-pp', 'data-pp'], ['fp-shuf', 'data-shuf'], ['q-shuf', 'data-shuf'],
   ['fp-rep', 'data-rep'], ['q-rep', 'data-rep'], ['fp-sleep', 'data-sleep-btn']].forEach(([id, attr]) => {
    const el = document.getElementById(id); if (el && !el.hasAttribute(attr)) el.setAttribute(attr, '');
  });
  // A page cached from an older version may not load the shared scripts yet: fetch whatever is missing first.
  const need = [!window.AX && '/web/app/core.js?v=3.2.0', !(window.AX && window.AX.Social) && '/web/app/social.js?v=1.0.0', !(window.AX && window.AX.Party) && '/web/app/party.js?v=1.0.0', !(window.AX && window.AX.Vis) && '/web/app/immersive.js?v=1.0.0', !(window.AX && window.AX.ChatMedia) && '/web/app/chatmedia.js?v=1.0.0', !(window.AX && window.AX.Rewind) && '/web/app/rewind.js?v=1.0.0'].filter(Boolean);
  const next = () => {
    const src = need.shift();
    if (!src) { axdioMobile(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = next;
    s.onerror = () => { const o = document.getElementById('axdio-loading-overlay'); if (o) o.remove(); };
    document.head.appendChild(s);
  };
  next();
})();
