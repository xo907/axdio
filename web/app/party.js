/* Axdio — Listening parties (loaded after core.js and social.js).
   Everyone in a party hears the same moment of the same song. The server keeps the party clock
   (what's playing, from where, since when); this file follows it: it loads the party's song, keeps
   the local player within a few tens of milliseconds of the party (nudging the playback rate, or
   seeking when far off), and routes the player's controls to the party while you're in one.
   Both apps show the same party panel (Party.render) and floating reactions. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Party) return;
const { UI, api, L, U, P, D, S, esc, ic, img, coverUrl, count, clamp, fmt, feat, makeCtx, load, play, pause, curTrack, trackChanged, haptic, SITE } = AX;
const on = () => !!U.token && feat('party');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const agoText = AX.agoText || (() => '');

/* ---- Server clock: the smallest-delay samples are the most accurate ---- */
const Clock = {
  samples: [], offset: 0,
  add(srvNow, t0, t1) {
    const rtt = t1 - t0;
    this.samples.push({ rtt, off: srvNow * 1000 - (t0 + t1) / 2 });
    if (this.samples.length > 12) this.samples.shift();
    this.offset = this.samples.reduce((b, s) => (s.rtt < b.rtt ? s : b)).off;
  },
  now() { return (Date.now() + this.offset) / 1000; },
};

const Party = {
  v: null, rev: -1, loopId: 0, seen: new Set(), item: null, blocked: false, lastErr: '', tab: 'queue', live: [], busy: false,
  get active() { return !!(this.v && !this.v.ended); },

  /* ---- Joining and leaving ---- */
  async refresh() {
    if (!on()) return;
    try {
      const t0 = Date.now(), d = await api('/api/party'), t1 = Date.now();
      this.live = d.live || [];
      if (d.party) { Clock.add(d.party.now, t0, t1); this.enter(d.party); }
      else if (this.v) this.left('');
      this.paint();
    } catch (e) { /* offline */ }
  },
  async create() {
    const t = curTrack();
    const queue = t ? [t.rel, ...(P.queue.length ? P.queue : (AX.upcoming(50).map(x => x.id))).map(id => L.tracks[id] && L.tracks[id].rel).filter(Boolean)] : [];
    try {
      const t0 = Date.now(), v = await api('/api/party', { queue, pos: t ? (D.a.currentTime || 0) : 0 }), t1 = Date.now();
      Clock.add(v.now, t0, t1);
      this.enter(v);
      UI.toast('Your listening party is on. Share the invite link!');
    } catch (e) { UI.toast(e.message); }
  },
  async join(code, id) {
    try {
      const t0 = Date.now(), v = await api('/api/party/join', code ? { code } : { id }), t1 = Date.now();
      Clock.add(v.now, t0, t1);
      this.enter(v);
      UI.toast(`You joined ${v.name}`);
      if (UI.openParty) UI.openParty();
    } catch (e) { UI.toast(e.message); }
  },
  async leave(end) {
    if (!this.v) return;
    const id = this.v.id;
    try { await api(`/api/party/${id}`, { op: end ? 'end' : 'leave' }); } catch (e) { /* gone already */ }
    this.left(end ? 'You ended the party' : 'You left the party');
  },
  enter(v) {
    const first = !this.v || this.v.id !== v.id;
    if (first) { this.seen = new Set((v.feed || []).map(f => f.id)); this.item = null; }
    AX.setPartyHook(HOOK);
    this.apply(v);
    if (first) this.loop(v.id);
  },
  left(msg) {
    this.loopId++;
    const wasActive = !!this.v;
    this.v = null; this.rev = -1; this.item = null; this.blocked = false;
    AX.setPartyHook(null);
    D.els.forEach(el => { el.playbackRate = 1; });
    if (wasActive && msg) UI.toast(msg);
    document.body.classList.remove('in-party');
    this.paint();
  },
  async loop(id) {
    const my = ++this.loopId;
    let fails = 0;
    while (my === this.loopId && this.v && this.v.id === id) {
      try {
        const v = await api(`/api/party/${id}/wait?rev=${this.rev}`);
        if (my !== this.loopId) return;
        fails = 0;
        this.apply(v, true);
      } catch (e) {
        if (my !== this.loopId) return;
        if (e.status === 410 || e.status === 404) { this.left('The party has ended'); return; }
        if (e.status === 401 || e.status === 403) { this.left(''); return; }
        await sleep(Math.min(10000, 1000 * ++fails));
      }
    }
  },
  async op(op, data = {}) {
    if (!this.v) return null;
    try {
      const t0 = Date.now(), v = await api(`/api/party/${this.v.id}`, { op, ...data }), t1 = Date.now();
      if (v && v.id) { Clock.add(v.now, t0, t1); this.apply(v); }
      return v;
    } catch (e) {
      if (e.status === 410) { this.left('The party has ended'); return null; }
      UI.toast(e.message);
      return null;
    }
  },

  /* ---- Following the party ---- */
  apply(v, fromWait) {
    if (v.rev < this.rev && this.v && this.v.id === v.id) return;
    const prevV = this.v;
    this.v = v; this.rev = v.rev;
    document.body.classList.add('in-party');
    // Reactions and messages that arrived since last time.
    const fresh = (v.feed || []).filter(f => !this.seen.has(f.id));
    fresh.forEach(f => this.seen.add(f.id));
    if (prevV && prevV.id === v.id) fresh.forEach(f => this.announce(f));
    this.follow();
    this.paint();
    if (fromWait && (!prevV || prevV.state.item !== v.state.item) && v.state.by && v.state.by !== U.username && v.state.rel) {
      const t = L.byRel.get(v.state.rel);
      if (t && UI.toastQuiet) UI.toastQuiet(`${this.nameOf(v.state.by)} picked "${t.title}"`);
    }
  },
  target() {
    const st = this.v.state;
    return st.playing ? st.pos + (Clock.now() - st.at) : st.pos;
  },
  partyIds() {
    const v = this.v, st = v.state;
    const ids = [], items = [];
    const cur = st.rel && L.byRel.get(st.rel);
    if (cur) { ids.push(cur.id); items.push(st.item); }
    v.queue.forEach(q => { const t = L.byRel.get(q.r); if (t) { ids.push(t.id); items.push(q.id); } });
    this.ctxItems = items;
    return ids;
  },
  follow() {
    const v = this.v, st = v.state;
    const ids = this.partyIds();
    // The party is the player's context, so the queue views show what's coming up in it.
    P.ctx = makeCtx('party', v.id, v.name, ids.length ? ids : [0]);
    P.order = P.ctx.ids.map((_, i) => i); P.pos = 0; P.fromQueue = false; P.queue = [];
    if (!st.rel) { if (!D.a.paused) pause(); UI.queue(); return; }
    const t = L.byRel.get(st.rel);
    if (!t) { UI.toast("This party's song isn't in your library view yet"); return; }
    const target = this.target();
    if (P.cur !== t.id || this.item !== st.item) {
      this.item = st.item;
      load(t.id, st.playing, target > 1.2 ? target : 0);
      if (st.playing) this.watchStart();
    } else if (st.playing && (D.a.paused || P.pending)) {
      if (Math.abs((D.a.currentTime || 0) - target) > .5) D.a.currentTime = target;
      play(); this.watchStart();
    } else if (!st.playing) {
      if (!D.a.paused) pause();
      if (isFinite(D.a.duration) && Math.abs((D.a.currentTime || 0) - target) > .4) D.a.currentTime = Math.min(target, D.a.duration - .2);
    }
    UI.queue();
  },
  // Browsers only start sound after a tap: if it didn't start, offer a button.
  watchStart() {
    clearTimeout(this._ws);
    this._ws = setTimeout(() => {
      const blocked = !!(this.v && this.v.state.playing && D.a.paused);
      if (blocked !== this.blocked) { this.blocked = blocked; this.paint(); }
    }, 1800);
  },
  listenAlong() { this.blocked = false; play(); this.follow(); this.paint(); },
  drift() {
    if (!this.active) return;
    const st = this.v.state, el = D.a;
    if (!st.playing || el.paused || P.pending || el.readyState < 3 || !isFinite(el.duration)) { if (el.playbackRate !== 1) el.playbackRate = 1; return; }
    const d = el.currentTime - this.target();
    if (Math.abs(d) > .45) { el.currentTime = clamp(this.target(), 0, el.duration - .2); el.playbackRate = 1; }
    else if (Math.abs(d) > .025) el.playbackRate = clamp(1 - d * .6, .94, 1.06);
    else if (el.playbackRate !== 1) el.playbackRate = 1;
  },
  nameOf(u) {
    const m = this.v && this.v.members.find(x => x.username === u);
    return m ? m.display_name : u === U.username ? 'You' : u;
  },

  /* ---- Reactions and messages ---- */
  announce(f) {
    if (f.kind === 'react') float(f.emoji, f.user === U.username ? '' : this.nameOf(f.user));
    else if (f.kind === 'chat' && f.user !== U.username && !this.panelOpen()) UI.toast(`${this.nameOf(f.user)}: ${f.text}`);
    else if (f.kind === 'join' && f.user !== U.username) UI.toast(`${this.nameOf(f.user)} joined the party`);
  },
  panelOpen() { return !!document.querySelector('.party-ui[data-live]'); },

  /* ---- The panel ---- */
  mounts: new Set(),
  render(el) {
    this.mounts.add(el);
    el.classList.add('party-host');
    if (!el._partyBound) { el._partyBound = true; el.addEventListener('click', e => this.click(e, el)); el.addEventListener('submit', e => this.submit(e)); el.addEventListener('input', e => this.input(e)); }
    this.draw(el);
  },
  paint() {
    for (const el of this.mounts) { if (!el.isConnected) this.mounts.delete(el); else this.draw(el); }
    if (UI.party) UI.party(this.v);
  },
  draw(el) {
    const keep = el.querySelector('#party-msg');
    const typed = keep ? keep.value : '', focused = keep && document.activeElement === keep;
    const scroll = el.querySelector('.party-feed');
    const atBottom = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    el.innerHTML = this.v ? this.inside() : this.outside();
    const box = el.querySelector('#party-msg');
    if (box) { box.value = typed; if (focused) box.focus(); }
    const feed = el.querySelector('.party-feed');
    if (feed && atBottom) feed.scrollTop = feed.scrollHeight;
  },
  outside() {
    if (!on()) return `<div class="party-ui"><div class="party-empty">${ic('people', 'xl')}<h3>Listening parties are off</h3><p>${U.token ? 'The server admin turned them off.' : 'Log in to listen together with friends.'}</p></div></div>`;
    const t = curTrack();
    const live = this.live.map(p => `<div class="party-live">${img(coverUrl(p.now && p.now.rel ? p.now.rel : ''))}<div class="flex1"><b>${esc(p.name)}</b><span>${esc(p.host.display_name)} · ${count(p.members, 'listener')}</span></div><button class="btn primary sm" data-pa="join-id" data-id="${esc(p.id)}">Join</button></div>`).join('');
    return `<div class="party-ui"><div class="party-hero"><div class="party-orb">${ic('people', 'xl')}</div><h3>Listen together</h3>
      <p>Start a party and everyone who joins hears the same song at the same moment, wherever they are. Share the queue, react, and chat along.</p>
      <button class="btn primary" data-pa="create">${ic('spark', 'sm')}Start a party${t ? ' with this song' : ''}</button></div>
      <form class="party-join" data-pf="join"><input id="party-code" maxlength="8" placeholder="Party code" autocomplete="off" autocapitalize="characters" aria-label="Party code"><button class="btn ghost sm">Join</button></form>
      ${live ? `<div class="party-sec">Your friends' parties</div>${live}` : ''}</div>`;
  },
  inside() {
    const v = this.v, st = v.state, t = st.rel ? L.byRel.get(st.rel) : null;
    const link = `${SITE.public_url || location.origin}/party/${v.code}`;
    const pos = this.target(), dur = st.dur || (t && P.cur === t.id ? D.a.duration : 0) || 0;
    const tabs = [['queue', `Up next${v.queue_len ? ` · ${v.queue_len}` : ''}`], ['chat', 'Chat'], ['people', `People · ${v.members.length}`], ...(v.is_host ? [['host', 'Settings']] : [])];
    const faces = v.members.slice(0, 7).map(m => `<span class="party-face" title="${esc(m.display_name)}">${m.avatar ? img(m.avatar) : esc((m.display_name || '?')[0].toUpperCase())}</span>`).join('');
    let body = '';
    if (this.tab === 'queue') {
      body = v.queue.length ? v.queue.map((q, i) => { const qt = L.byRel.get(q.r); if (!qt) return ''; const mine = q.by === U.username;
        return `<div class="party-q">${img(coverUrl(qt.rel))}<div class="flex1"><b>${esc(qt.title)}</b><span>${esc(qt.artist)} · added by ${esc(this.nameOf(q.by))}</span></div>
          ${v.can_control ? `<button class="icon-btn" data-pa="jump" data-id="${q.id}" title="Play now">${ic('play', 'sm')}</button>${i ? `<button class="icon-btn" data-pa="up" data-id="${q.id}" data-i="${i}" title="Move up">${ic('up', 'sm')}</button>` : ''}` : ''}
          ${v.can_control || mine ? `<button class="icon-btn" data-pa="remove" data-id="${q.id}" title="Remove">${ic('close', 'sm')}</button>` : ''}</div>`; }).join('')
        : `<div class="party-hint">${v.can_add ? 'The queue is empty. Use <b>Add to queue</b> on any song, album or playlist, or tap a song to play it for everyone.' : 'The host picks the songs in this party.'}</div>`;
    } else if (this.tab === 'chat') {
      const lines = (v.feed || []).filter(f => f.kind !== 'react').slice(-60).map(f => {
        if (f.kind === 'chat') return `<div class="party-msg${f.user === U.username ? ' mine' : ''}"><b>${esc(this.nameOf(f.user))}</b><span>${esc(f.text)}</span></div>`;
        const tr = f.rel && L.byRel.get(f.rel);
        const text = f.kind === 'join' ? `${this.nameOf(f.user)} joined` : f.kind === 'leave' ? `${this.nameOf(f.user)} left`
          : f.kind === 'play' ? `${this.nameOf(f.user)} played ${tr ? `"${tr.title}"` : 'a song'}` : f.kind === 'add' ? `${this.nameOf(f.user)} added ${f.count > 1 ? count(f.count, 'song') : tr ? `"${tr.title}"` : 'a song'}` : f.text || '';
        return `<div class="party-sys">${esc(text)}</div>`;
      }).join('');
      body = `<div class="party-feed">${lines || '<div class="party-hint">Say hi! Party chat isn\'t end-to-end encrypted and disappears when the party ends.</div>'}</div>
        <form class="party-say" data-pf="chat"><input id="party-msg" maxlength="300" placeholder="Message the party" autocomplete="off"><button class="icon-btn" aria-label="Send">${ic('send', 'sm')}</button></form>`;
    } else if (this.tab === 'people') {
      body = v.members.map(m => `<div class="party-person"><span class="party-face">${m.avatar ? img(m.avatar) : esc((m.display_name || '?')[0].toUpperCase())}</span><div class="flex1"><b>${esc(m.display_name)}${m.username === U.username ? ' (you)' : ''}</b><span>${m.host ? 'Host' : `@${esc(m.username)}`}</span></div>
        ${v.is_host && !m.host ? `<button class="btn ghost sm" data-pa="make-host" data-u="${esc(m.username)}">Make host</button><button class="icon-btn" data-pa="kick" data-u="${esc(m.username)}" title="Remove from party">${ic('close', 'sm')}</button>` : ''}</div>`).join('');
    } else {
      const tog = (k, label, sub, val) => `<label class="party-set"><div class="flex1"><b>${label}</b><span>${sub}</span></div><input type="checkbox" data-ps="${k}"${val ? ' checked' : ''}></label>`;
      body = tog('add', 'Everyone can add songs', 'Guests add to the shared queue.', v.perm.add)
        + tog('control', 'Everyone can control playback', 'Guests can pause, skip and seek for everyone.', v.perm.control)
        + tog('visible', 'Friends can see and join', 'Shows the party to friends of the people in it.', v.visible)
        + `<form class="party-say" data-pf="rename"><input id="party-name" maxlength="60" value="${esc(v.name)}" aria-label="Party name"><button class="btn ghost sm">Rename</button></form>
           <button class="btn danger block" data-pa="end" style="margin-top:14px">End the party for everyone</button>`;
    }
    return `<div class="party-ui" data-live>
      <div class="party-top"><div class="flex1"><div class="party-name">${esc(v.name)}</div><div class="party-faces">${faces}<span>${count(v.members.length, 'listener')}</span></div></div>
        <button class="btn ghost sm" data-pa="invite" data-link="${esc(link)}" title="Copy the invite link">${ic('share', 'sm')}${esc(v.code)}</button></div>
      ${this.blocked ? `<button class="party-along" data-pa="along">${ic('play', 'sm')}Tap to listen along</button>` : ''}
      <div class="party-now">${t ? img(coverUrl(t.rel)) : `<div class="party-blank">${ic('note', 'md')}</div>`}
        <div class="flex1"><b>${t ? esc(t.title) : 'Nothing playing'}</b><span>${t ? esc(t.artist) : v.can_add ? 'Add a song to get started' : 'Waiting for the host'}${t && st.by ? ` · picked by ${esc(this.nameOf(st.by))}` : ''}</span>
          ${t ? `<div class="party-bar"><i style="width:${dur ? clamp(pos / dur * 100, 0, 100) : 0}%" data-party-bar></i></div><div class="party-times"><span data-party-pos>${fmt(pos)}</span><span>${fmt(dur)}</span></div>` : ''}</div></div>
      ${v.can_control && t ? `<div class="party-ctl"><button class="icon-btn" data-pa="prev" aria-label="Previous">${ic('prev', 'md')}</button><button class="party-pp" data-pa="toggle" aria-label="${st.playing ? 'Pause' : 'Play'}">${ic(st.playing ? 'pause' : 'play', 'md')}</button><button class="icon-btn" data-pa="next" aria-label="Next">${ic('next', 'md')}</button></div>` : ''}
      <div class="party-reacts">${(v.reactions || []).map(e => `<button data-pa="react" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
      <div class="party-tabs">${tabs.map(([k, l]) => `<button class="${this.tab === k ? 'on' : ''}" data-pa="tab" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="party-body">${body}</div>
      ${v.is_host ? '' : '<button class="btn ghost block" data-pa="leave" style="margin-top:14px">Leave the party</button>'}</div>`;
  },
  async click(e, el) {
    const b = e.target.closest('[data-pa]'); if (!b || !el.contains(b)) return;
    const a = b.dataset.pa, id = b.dataset.id;
    haptic(8);
    if (a === 'create') this.create();
    else if (a === 'join-id') this.join('', id);
    else if (a === 'tab') { this.tab = b.dataset.tab; this.paint(); }
    else if (a === 'along') this.listenAlong();
    else if (a === 'invite') {
      const url = b.dataset.link;
      try { if (navigator.share && /Android|iPhone|iPad/.test(navigator.userAgent)) await navigator.share({ title: this.v.name, text: 'Listen with me on Axdio', url }); else { await navigator.clipboard.writeText(url); UI.toast('Invite link copied'); } }
      catch (x) { if (x.name !== 'AbortError') UI.toast(`Party code: ${this.v.code}`); }
    }
    else if (a === 'react') { float(b.dataset.e, ''); this.op('react', { emoji: b.dataset.e }); }
    else if (a === 'toggle') this.op(this.v.state.playing ? 'pause' : 'resume');
    else if (a === 'next') this.op('next');
    else if (a === 'prev') this.op('prev');
    else if (a === 'jump') this.op('jump', { id });
    else if (a === 'remove') this.op('remove', { id });
    else if (a === 'up') this.op('move', { id, to: Math.max(0, (+b.dataset.i) - 1) });
    else if (a === 'kick') { if (await UI.confirm({ title: `Remove ${this.nameOf(b.dataset.u)}?`, text: 'They can join again with the code.', ok: 'Remove' })) this.op('kick', { user: b.dataset.u }); }
    else if (a === 'make-host') this.op('host', { user: b.dataset.u });
    else if (a === 'leave') this.leave(false);
    else if (a === 'end') { if (await UI.confirm({ title: 'End the party?', text: 'Everyone stops listening together. The music keeps playing for you.', ok: 'End party', danger: true })) this.leave(true); }
  },
  submit(e) {
    const f = e.target.closest('[data-pf]'); if (!f) return;
    e.preventDefault();
    if (f.dataset.pf === 'join') { const c = f.querySelector('#party-code').value.trim(); if (c) this.join(c); }
    else if (f.dataset.pf === 'chat') { const i = f.querySelector('#party-msg'); const text = i.value.trim(); if (text) { i.value = ''; this.op('chat', { text }); } }
    else if (f.dataset.pf === 'rename') { const n = f.querySelector('#party-name').value.trim(); if (n) this.op('settings', { name: n }).then(r => r && UI.toast('Renamed')); }
  },
  input(e) {
    const c = e.target.closest('[data-ps]'); if (!c) return;
    this.op('settings', { [c.dataset.ps]: c.checked });
  },
};

/* ---- The player's controls, while in a party ---- */
const deny = () => { UI.toast('The host controls playback in this party'); return true; };
const HOOK = {
  toggle() { const v = Party.v; if (!v) return false; if (Party.blocked || (v.state.playing && D.a.paused)) { Party.listenAlong(); return true; } if (!v.can_control) return deny(); Party.op(v.state.playing ? 'pause' : 'resume'); return true; },
  next(auto) { const v = Party.v; if (!v) return; if (auto) return; if (!v.can_control) { deny(); return; } Party.op('next'); },
  prev() { const v = Party.v; if (!v) return; if (!v.can_control) { deny(); return; } Party.op('prev'); },
  seek(sec) { const v = Party.v; if (!v) return false; if (!v.can_control) return deny(); Party.op('seek', { pos: sec }); return true; },
  ended() {
    const v = Party.v; if (!v) return;
    // The server moves on by itself when it knows the song's length; otherwise the first app to finish tells it.
    if (!v.state.dur) Party.op('ended', { item: v.state.item });
  },
  playCtx(ctx, start) {
    const v = Party.v; if (!v) return false;
    if (ctx && ctx.type === 'party') return false;
    const id = start >= 0 ? ctx.ids[start] : ctx.ids[Math.floor(Math.random() * ctx.ids.length)];
    const t = AX.L.tracks[id]; if (!t) return true;
    if (v.can_control) { Party.op('play', { rel: t.rel }); UI.toast(`Playing "${t.title}" for everyone`); }
    else if (v.can_add) { Party.op('add', { rels: [t.rel] }).then(r => r && UI.toast('Added to the party queue')); }
    else deny();
    return true;
  },
  jump(pos) {
    const v = Party.v; if (!v) return false;
    const id = (Party.ctxItems || [])[pos];
    if (!id || id === v.state.item) return true;
    if (!v.can_control) return deny();
    Party.op('jump', { id });
    return true;
  },
  add(ids, playNext) {
    const v = Party.v; if (!v) return false;
    if (!v.can_add) { UI.toast('The host is choosing the songs in this party'); return true; }
    const rels = ids.map(id => L.tracks[id] && L.tracks[id].rel).filter(Boolean);
    Party.op('add', { rels, next: !!playNext }).then(r => r && UI.toast(rels.length === 1 ? 'Added to the party queue' : `${count(rels.length, 'song')} added to the party queue`));
    return true;
  },
};

// A song's length, once the player knows it (for songs the server hasn't measured yet).
D.els.forEach(el => el.addEventListener('loadedmetadata', () => {
  const v = Party.v;
  if (v && !v.state.dur && isFinite(el.duration) && el === D.a) Party.op('duration', { item: v.state.item, dur: el.duration });
}));
setInterval(() => Party.drift(), 400);
setInterval(() => {
  if (!Party.active) return;
  const v = Party.v, bar = document.querySelectorAll('[data-party-bar]'), posEl = document.querySelectorAll('[data-party-pos]');
  const pos = Party.target(), dur = v.state.dur || D.a.duration || 0;
  bar.forEach(b => { b.style.width = `${dur ? clamp(pos / dur * 100, 0, 100) : 0}%`; });
  posEl.forEach(p => { p.textContent = fmt(pos); });
}, 500);
// Keep the clock estimate fresh (long polls can't measure it).
setInterval(() => { if (Party.active && !document.hidden) Party.refresh(); }, 30000);

/* ---- Floating reactions ---- */
function float(emoji, who) {
  const layer = document.getElementById('party-float') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'party-float' }));
  const n = document.createElement('div');
  n.className = 'party-emoji';
  n.style.left = `${8 + Math.random() * 20}%`;
  n.style.setProperty('--dx', `${(Math.random() * 80 - 40).toFixed(0)}px`);
  n.style.setProperty('--rot', `${(Math.random() * 40 - 20).toFixed(0)}deg`);
  n.innerHTML = `<span>${esc(emoji)}</span>${who ? `<small>${esc(who)}</small>` : ''}`;
  layer.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}

/* ---- Styles (shared by both apps) ---- */
const css = `
.party-ui { --pc: var(--accent, #1ed760); display: flex; flex-direction: column; gap: 12px; }
.party-ui .flex1 { flex: 1; min-width: 0; }
.party-hero { text-align: center; padding: 18px 8px 6px; }
.party-hero h3 { font-size: 22px; margin: 12px 0 6px; }
.party-hero p { color: var(--text-2); line-height: 1.5; font-size: 14px; margin: 0 0 16px; }
.party-orb { width: 86px; height: 86px; margin: 0 auto; border-radius: 50%; display: grid; place-items: center; color: #fff;
  background: conic-gradient(from 0deg, #ff5f6d, #ffc371, #47e891, #3aa0ff, #b86bff, #ff5f6d); animation: party-spin 8s linear infinite; box-shadow: 0 10px 40px rgba(184,107,255,.35); }
.party-orb .i { width: 38px; height: 38px; animation: party-spin 8s linear infinite reverse; }
@keyframes party-spin { to { transform: rotate(360deg); } }
.party-join, .party-say { display: flex; gap: 8px; align-items: center; }
.party-join input, .party-say input { flex: 1; min-width: 0; background: var(--elev-2, #242424); border: 1px solid var(--line, rgba(255,255,255,.1)); border-radius: 999px; padding: 10px 16px; color: var(--text, #fff); font: inherit; font-size: 14px; outline: none; }
.party-join input { text-transform: uppercase; letter-spacing: .2em; text-align: center; }
.party-sec { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3, #888); margin-top: 8px; }
.party-live, .party-q, .party-person, .party-now { display: flex; align-items: center; gap: 12px; }
.party-live img, .party-q img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex: none; }
.party-live b, .party-q b, .party-person b, .party-now b { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.party-live span, .party-q span, .party-person span, .party-now span { display: block; font-size: 12.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.party-top { display: flex; align-items: center; gap: 10px; }
.party-name { font-size: 18px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.party-faces { display: flex; align-items: center; margin-top: 6px; }
.party-faces > span:last-child { margin-left: 10px; font-size: 12.5px; color: var(--text-2); }
.party-face { width: 28px; height: 28px; border-radius: 50%; background: var(--elev-3, #333); display: grid; place-items: center; font-size: 12px; font-weight: 700; overflow: hidden; border: 2px solid var(--bg, #121212); flex: none; }
.party-faces .party-face + .party-face { margin-left: -8px; }
.party-face img { width: 100%; height: 100%; object-fit: cover; }
.party-person .party-face { width: 38px; height: 38px; font-size: 15px; }
.party-now { background: linear-gradient(135deg, color-mix(in srgb, var(--pc) 22%, transparent), rgba(255,255,255,.03)); border-radius: 14px; padding: 12px; }
.party-now img, .party-blank { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; flex: none; background: var(--elev-2); display: grid; place-items: center; }
.party-bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,.15); margin-top: 10px; overflow: hidden; }
.party-bar i { display: block; height: 100%; background: var(--pc); transition: width .5s linear; }
.party-times { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); margin-top: 4px; font-variant-numeric: tabular-nums; }
.party-ctl { display: flex; justify-content: center; align-items: center; gap: 18px; }
.party-pp { width: 48px; height: 48px; border-radius: 50%; border: 0; background: #fff; color: #000; display: grid; place-items: center; cursor: pointer; }
.party-reacts { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.party-reacts button { background: var(--elev-2, #242424); border: 0; border-radius: 12px; font-size: 20px; height: 40px; cursor: pointer; transition: transform .12s; }
.party-reacts button:active { transform: scale(1.3); }
.party-tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.party-tabs button { flex: none; border: 0; border-radius: 999px; padding: 7px 12px; background: var(--elev-2, #242424); color: var(--text, #fff); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.party-tabs button.on { background: #fff; color: #000; }
.party-body { display: flex; flex-direction: column; gap: 10px; min-height: 80px; }
.party-hint, .party-sys { color: var(--text-2); font-size: 13px; line-height: 1.5; }
.party-sys { text-align: center; font-size: 12px; color: var(--text-3); }
.party-feed { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; }
.party-msg { background: var(--elev-2, #242424); border-radius: 14px; padding: 8px 12px; max-width: 88%; align-self: flex-start; font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
.party-msg b { display: block; font-size: 11.5px; color: var(--pc); margin-bottom: 2px; }
.party-msg.mine { align-self: flex-end; background: color-mix(in srgb, var(--pc) 28%, var(--elev-2, #242424)); }
.party-set { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.party-set b { display: block; font-size: 14px; }
.party-set span { display: block; font-size: 12.5px; color: var(--text-2); }
.party-set input { width: 20px; height: 20px; accent-color: var(--pc); }
.party-along { border: 0; border-radius: 999px; padding: 12px; font: inherit; font-weight: 700; background: var(--pc); color: var(--on-accent, #000); cursor: pointer; display: flex; justify-content: center; gap: 8px; align-items: center; animation: party-pulse 1.6s ease-in-out infinite; }
@keyframes party-pulse { 50% { transform: scale(1.03); box-shadow: 0 0 24px color-mix(in srgb, var(--pc) 60%, transparent); } }
#party-float { position: fixed; inset: 0; pointer-events: none; z-index: 9999; overflow: hidden; }
.party-emoji { position: absolute; bottom: 90px; display: flex; flex-direction: column; align-items: center; animation: party-rise 3.1s cubic-bezier(.2,.6,.3,1) forwards; }
.party-emoji span { font-size: 42px; filter: drop-shadow(0 4px 10px rgba(0,0,0,.4)); }
.party-emoji small { font-size: 11px; font-weight: 700; background: rgba(0,0,0,.55); color: #fff; padding: 2px 8px; border-radius: 999px; margin-top: 2px; }
@keyframes party-rise { 0% { transform: translate(0, 20px) scale(.4); opacity: 0; } 12% { transform: translate(0, 0) scale(1.15); opacity: 1; }
  100% { transform: translate(var(--dx), -55vh) rotate(var(--rot)) scale(.9); opacity: 0; } }
body.in-party [data-act="party"] { color: var(--accent); }
`;
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

/* ---- Start: rejoin after a reload, or join from an invite link (/party/CODE → /?party=CODE) ---- */
async function start() {
  const qs = new URLSearchParams(location.search), code = qs.get('party');
  if (code) { qs.delete('party'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash); }
  for (let i = 0; i < 60 && !(L.tracks.length && (U.token || i > 20)); i++) await sleep(250);
  if (!U.token) { if (code) UI.toast('Log in to join the listening party'); Party.pendingCode = code; return; }
  if (code) await Party.join(code); else await Party.refresh();
}
Party.start = () => { if (Party.pendingCode) { const c = Party.pendingCode; Party.pendingCode = null; Party.join(c); } else Party.refresh(); };
AX.Party = Party;
start();
})();
