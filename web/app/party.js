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
  keys: new Map(), plain: new Map(), keying: false, rekey: false, unread: 0, emo: false,
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
    if (prevV && prevV.id === v.id && this.tab !== 'chat') this.unread += fresh.filter(f => f.kind === 'chat' && f.user !== U.username).length;
    this.follow();
    this.syncKey();
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
    else if (f.kind === 'chat' && f.user !== U.username && !this.panelOpen()) this.reveal(f).then(t => { if (t) UI.toast(`${this.nameOf(f.user)}: ${t}`); });
    else if (f.kind === 'join' && f.user !== U.username) UI.toast(`${this.nameOf(f.user)} joined the party`);
  },
  panelOpen() { return !!document.querySelector('.party-ui[data-live]'); },

  /* ---- End-to-end encrypted chat ---- */
  // The chat key is made by the host (or the first member with private messages turned on), sealed for every member's
  // private-message key, and passed on to newcomers by whoever has it. A removed member means a new key.
  ctx(v) { return `${this.v.id}|${v}`; },
  aad(v, user) { return `axdio-pchat-v1|${this.v.id}|${v}|${user}`; },
  async syncKey() {
    const v = this.v, S2 = AX.Sealer;
    if (!v || !S2 || !S2.ready()) return;
    if (this.keying) { this.rekey = true; return; }        // look again when the current round is done
    this.keying = true; this.rekey = false;
    try {
      for (const m of v.members) if (m.keys) await AX.E2EE.pin(m.username, m.keys);
      if (!v.keyv) { if (v.is_host || !v.members.some(m => m.host && m.keys)) await this.newKey(1); return; }
      const ctx = this.ctx(v.keyv);
      if (!this.keys.has(ctx) && v.my_wrap) { this.keys.set(ctx, await S2.unwrap(v.my_wrap, ctx)); this.paint(); }
      const raw = this.keys.get(ctx);
      const need = raw ? v.members.filter(m => m.keys && !v.wrapped.includes(m.username)) : [];
      if (need.length) {
        const wraps = {};
        for (const m of need) wraps[m.username] = await S2.wrap(m.username, m.keys, raw, ctx);
        await api(`/api/party/${v.id}`, { op: 'keys', v: v.keyv, wraps }).then(nv => nv && nv.id && this.apply(nv)).catch(() => {});
      }
    } catch (e) { /* tried again on the next update */ }
    finally { this.keying = false; if (this.rekey) { this.rekey = false; setTimeout(() => this.syncKey(), 0); } }
  },
  async newKey(ver) {
    const S2 = AX.Sealer, raw = S2.newKey(), ctx = this.ctx(ver), wraps = {};
    for (const m of this.v.members) if (m.keys) wraps[m.username] = await S2.wrap(m.username, m.keys, raw, ctx);
    if (!wraps[U.username]) return;
    this.keys.set(ctx, raw);
    const nv = await api(`/api/party/${this.v.id}`, { op: 'keys', v: ver, wraps }).catch(() => null);
    if (nv && nv.id) this.apply(nv);
  },
  // A chat message's text, or null when this device can't read it (sent before it had the key).
  async reveal(f) {
    if (this.plain.has(f.id)) return this.plain.get(f.id);
    const raw = this.keys.get(this.ctx(f.v));
    if (!raw) return undefined;
    let text = null;
    try { text = (await AX.Sealer.decrypt(raw, f, this.aad(f.v, f.user))).slice(0, 300); } catch (e) { /* not for this key */ }
    this.plain.set(f.id, text);
    return text;
  },
  async say(text) {
    const v = this.v, raw = v && this.keys.get(this.ctx(v.keyv));
    if (!raw) { UI.toast(AX.E2EE && AX.E2EE.state === 'ready' ? 'Getting the chat key from the party. Try again in a moment' : 'Party chat is end-to-end encrypted: turn on private messages in Messages to join in'); return; }
    const box = await AX.Sealer.encrypt(raw, text, this.aad(v.keyv, U.username));
    const r = await this.op('chat', { v: v.keyv, iv: box.iv, ct: box.ct });
    const mine = r && (r.feed || []).find(f => f.kind === 'chat' && f.ct === box.ct);
    if (mine) { this.plain.set(mine.id, text); this.paint(); }
  },

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
    if (this.tab === 'chat') this.unread = 0;
    const face = (m, cls = '') => `<span class="party-face${cls}" title="${esc(m.display_name)}">${m.avatar ? img(m.avatar) : esc((m.display_name || '?')[0].toUpperCase())}</span>`;
    const faces = v.members.slice(0, 5).map(m => face(m)).join('') + (v.members.length > 5 ? `<span class="party-face more">+${v.members.length - 5}</span>` : '');
    const who = u => u === U.username ? 'you' : this.nameOf(u);
    const tabs = [['queue', 'Queue', v.queue_len], ['chat', 'Chat', this.unread, true], ['people', 'People', v.members.length], ...(v.is_host ? [['host', '', 0]] : [])];
    let body = '', cls = '';
    if (this.tab === 'queue') {
      cls = ' pq';
      const now = t ? `<div class="pq-label">Now playing</div><div class="pq-row now">${img(coverUrl(t.rel))}<div class="flex1"><b>${esc(t.title)}</b><span>${esc(t.artist)}${st.by ? ` · picked by ${esc(who(st.by))}` : ''}</span></div>${st.playing ? `<span class="pq-eq">${AX.EQB || ''}</span>` : ''}</div>` : '';
      const rows = v.queue.map((q, i) => { const qt = L.byRel.get(q.r); if (!qt) return ''; const mine = q.by === U.username;
        return `<div class="pq-row">${img(coverUrl(qt.rel))}<div class="flex1"><b>${esc(qt.title)}</b><span>${esc(qt.artist)} · ${esc(who(q.by))}</span></div><div class="pq-act">`
          + (v.can_control ? `<button data-pa="jump" data-id="${q.id}" title="Play now" aria-label="Play now">${ic('play', 'sm')}</button>${i ? `<button data-pa="up" data-id="${q.id}" data-i="${i}" title="Move up" aria-label="Move up">${ic('up', 'sm')}</button>` : ''}` : '')
          + (v.can_control || mine ? `<button data-pa="remove" data-id="${q.id}" title="Remove" aria-label="Remove">${ic('close', 'sm')}</button>` : '') + `</div></div>`; }).join('');
      body = now + `<div class="pq-label">Up next</div>` + (rows || `<p class="pq-empty">${v.can_add ? 'Nothing up next. Add songs with <b>Add to queue</b>, or tap any song to play it for everyone.' : 'The host picks the songs.'}</p>`);
    } else if (this.tab === 'chat') {
      cls = ' pc';
      const e2ee = !!(AX.E2EE && AX.E2EE.state === 'ready'), key = this.keys.get(this.ctx(v.keyv));
      const time = at => new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const feed = (v.feed || []).filter(f => f.kind !== 'react').slice(-80);
      const lines = feed.map((f, i) => {
        if (f.kind !== 'chat') {
          const tr = f.rel && L.byRel.get(f.rel);
          const text = f.kind === 'join' ? `${who(f.user)} joined` : f.kind === 'leave' ? `${who(f.user)} left`
            : f.kind === 'play' ? `${who(f.user)} played ${tr ? tr.title : 'a song'}` : f.kind === 'add' ? `${who(f.user)} added ${f.count > 1 ? count(f.count, 'song') : tr ? tr.title : 'a song'}` : f.text || '';
          return `<div class="pc-sys">${esc(text)}</div>`;
        }
        let text = this.plain.get(f.id);
        if (text === undefined) this.reveal(f).then(r => { if (r !== undefined) this.paint(); });
        const prev = feed[i - 1], next = feed[i + 1], mine = f.user === U.username;
        const first = !prev || prev.kind !== 'chat' || prev.user !== f.user || f.at - prev.at > 300;
        const last = !next || next.kind !== 'chat' || next.user !== f.user || next.at - f.at > 300;
        const m = v.members.find(x => x.username === f.user) || { display_name: f.user };
        const inner = text === undefined ? '<i class="party-dots"><b></b><b></b><b></b></i>' : text === null ? `<em>${ic('lock', 'sm')} Sent before you had the key</em>` : esc(text);
        return `<div class="pc-msg${mine ? ' mine' : ''}${first ? ' first' : ''}${last ? ' last' : ''}">`
          + (!mine ? `<span class="pc-av">${last ? face(m) : ''}</span>` : '')
          + `<div class="pc-col">${first && !mine ? `<span class="pc-name">${esc(m.display_name)}</span>` : ''}<div class="pc-bub">${inner}</div>${last ? `<span class="pc-time">${time(f.at)}</span>` : ''}</div></div>`;
      }).join('');
      body = `<div class="party-feed"><div class="pc-e2ee">${ic('lock', 'sm')} End-to-end encrypted</div>${lines || `<div class="pc-empty">${ic('chat', 'md')}<p>No messages yet.<br>Say hi to everyone listening.</p></div>`}</div>`
        + (!e2ee ? `<div class="pc-note">${ic('lock', 'sm')}<span>Turn on private messages (in Messages) to join the party chat.</span></div>`
          : !key ? `<div class="pc-note"><i class="party-dots"><b></b><b></b><b></b></i><span>Getting the chat key…</span></div>`
          : `<div class="pc-reacts${this.emo ? ' on' : ''}">${(v.reactions || []).map(e => `<button type="button" data-pa="react" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
             <form class="pc-say" data-pf="chat"><button type="button" class="pc-emo${this.emo ? ' on' : ''}" data-pa="emo" aria-label="Reactions">${ic('smile', 'sm')}</button><input id="party-msg" maxlength="300" placeholder="Message" autocomplete="off"><button class="pc-send" aria-label="Send">${ic('send', 'sm')}</button></form>`);
    } else if (this.tab === 'people') {
      cls = ' pp';
      body = v.members.map(m => `<div class="pp-row">${face(m)}<div class="flex1"><b>${esc(m.display_name)}${m.username === U.username ? '<small> · you</small>' : ''}</b><span>@${esc(m.username)}${m.keys ? '' : ' · can\'t read the chat'}</span></div>${m.host ? '<span class="pp-tag">Host</span>' : ''}`
        + (v.is_host && !m.host ? `<div class="pp-act"><button data-pa="make-host" data-u="${esc(m.username)}" title="Make host">Make host</button><button data-pa="kick" data-u="${esc(m.username)}" title="Remove" aria-label="Remove">${ic('close', 'sm')}</button></div>` : '') + `</div>`).join('')
        + (v.is_host ? '' : `<button class="pp-leave" data-pa="leave">Leave the party</button>`);
    } else {
      cls = ' ps';
      const tog = (k, label, sub, val) => `<label class="ps-row"><div class="flex1"><b>${label}</b><span>${sub}</span></div><input type="checkbox" class="ps-switch" data-ps="${k}"${val ? ' checked' : ''}></label>`;
      body = `<form class="ps-name" data-pf="rename"><input id="party-name" maxlength="60" value="${esc(v.name)}" aria-label="Party name"><button>Rename</button></form>`
        + tog('add', 'Guests add songs', 'Anyone can add to the queue', v.perm.add)
        + tog('control', 'Guests control playback', 'Anyone can pause, skip and seek', v.perm.control)
        + tog('visible', 'Visible to friends', 'Friends of people here can join', v.visible)
        + `<button class="pp-leave" data-pa="end">End the party for everyone</button>`;
    }
    return `<div class="party-ui" data-live>
      <div class="pt-head"><div class="flex1"><div class="pt-name"><span class="party-live-dot"></span>${esc(v.name)}</div><div class="pt-sub"><span class="pt-faces">${faces}</span>${count(v.members.length, 'listener')}</div></div>
        <button class="pt-invite" data-pa="invite" data-link="${esc(link)}" title="Copy the invite link">${ic('share', 'sm')}<code>${esc(v.code)}</code></button></div>
      ${this.blocked ? `<button class="party-along" data-pa="along">${ic('play', 'sm')}Tap to listen along</button>` : ''}
      <nav class="pt-tabs">${tabs.map(([k, label, n, hot]) => `<button class="${this.tab === k ? 'on' : ''}${k === 'host' ? ' cog' : ''}" data-pa="tab" data-tab="${k}" ${k === 'host' ? 'aria-label="Settings" title="Settings"' : ''}>${k === 'host' ? ic('gear', 'sm') : label}${n ? `<em class="${hot ? 'hot' : ''}">${n}</em>` : ''}</button>`).join('')}</nav>
      <div class="pt-body${cls}">${body}</div></div>`;
  },
  async click(e, el) {
    const b = e.target.closest('[data-pa]'); if (!b || !el.contains(b)) return;
    const a = b.dataset.pa, id = b.dataset.id;
    haptic(8);
    if (a === 'create') this.create();
    else if (a === 'join-id') this.join('', id);
    else if (a === 'tab') { this.tab = b.dataset.tab; if (this.tab === 'chat') this.unread = 0; this.paint(); }
    else if (a === 'along') this.listenAlong();
    else if (a === 'emo') { this.emo = !this.emo; this.paint(); const i = el.querySelector('#party-msg'); if (i) i.focus(); }
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
    else if (a === 'kick') { if (await UI.confirm({ title: `Remove ${this.nameOf(b.dataset.u)}?`, text: 'They can join again with the code. The chat gets a new key they don\'t have.', ok: 'Remove' })) { const r = await this.op('kick', { user: b.dataset.u }); if (r && AX.Sealer && AX.Sealer.ready() && this.v && this.v.keyv) this.newKey(this.v.keyv + 1); } }
    else if (a === 'make-host') this.op('host', { user: b.dataset.u });
    else if (a === 'leave') this.leave(false);
    else if (a === 'end') { if (await UI.confirm({ title: 'End the party?', text: 'Everyone stops listening together. The music keeps playing for you.', ok: 'End party', danger: true })) this.leave(true); }
  },
  submit(e) {
    const f = e.target.closest('[data-pf]'); if (!f) return;
    e.preventDefault();
    if (f.dataset.pf === 'join') { const c = f.querySelector('#party-code').value.trim(); if (c) this.join(c); }
    else if (f.dataset.pf === 'chat') { const i = f.querySelector('#party-msg'); const text = i.value.trim().slice(0, 300); if (text) { i.value = ''; this.say(text); } }
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
.party-ui[data-live] { height: 100%; min-height: 0; gap: 0; }
#party-mount { height: 100%; box-sizing: border-box; }
.party-hero { text-align: center; padding: 18px 8px 6px; }
.party-hero h3 { font-size: 22px; margin: 12px 0 6px; }
.party-hero p { color: var(--text-2); line-height: 1.5; font-size: 14px; margin: 0 0 16px; }
.party-orb { width: 86px; height: 86px; margin: 0 auto; border-radius: 50%; display: grid; place-items: center; color: #fff;
  background: conic-gradient(from 0deg, #ff5f6d, #ffc371, #47e891, #3aa0ff, #b86bff, #ff5f6d); animation: party-spin 8s linear infinite; box-shadow: 0 10px 40px rgba(184,107,255,.35); }
.party-orb .i { width: 38px; height: 38px; animation: party-spin 8s linear infinite reverse; }
@keyframes party-spin { to { transform: rotate(360deg); } }
.party-join { display: flex; gap: 8px; align-items: center; }
.party-join input { flex: 1; min-width: 0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); border-radius: 999px; padding: 10px 16px; color: var(--text, #fff); font: inherit; font-size: 14px; outline: none; text-transform: uppercase; letter-spacing: .2em; text-align: center; }
.party-sec { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--text-3, #888); margin-top: 8px; }
.party-live { display: flex; align-items: center; gap: 12px; }
.party-live img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex: none; }
.party-live b { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.party-live span { display: block; font-size: 12.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.party-face { width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,.1); display: grid; place-items: center; font-size: 12px; font-weight: 700; overflow: hidden; flex: none; color: #fff; }
.party-face img { width: 100%; height: 100%; object-fit: cover; }
.party-face.more { font-size: 10.5px; }
.party-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex: none; box-shadow: 0 0 0 0 rgba(239,68,68,.55); animation: party-live 1.8s ease-out infinite; }
@keyframes party-live { 70% { box-shadow: 0 0 0 7px rgba(239,68,68,0); } }
.party-along { flex: none; margin-top: 12px; border: 0; border-radius: 999px; padding: 11px; font: inherit; font-weight: 700; background: var(--pc); color: var(--on-accent, #000); cursor: pointer; display: flex; justify-content: center; gap: 8px; align-items: center; animation: party-pulse 1.6s ease-in-out infinite; }
@keyframes party-pulse { 50% { transform: scale(1.02); box-shadow: 0 0 24px color-mix(in srgb, var(--pc) 50%, transparent); } }
.party-dots { display: inline-flex; gap: 3px; vertical-align: middle; } .party-dots b { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .45; animation: party-dot 1s ease-in-out infinite; }
.party-dots b:nth-child(2) { animation-delay: .15s; } .party-dots b:nth-child(3) { animation-delay: .3s; }
@keyframes party-dot { 50% { opacity: 1; transform: translateY(-2px); } }

/* Header and tabs */
.pt-head { display: flex; align-items: center; gap: 12px; flex: none; padding: 2px 0 14px; }
.pt-name { display: flex; align-items: center; gap: 9px; font-size: 17px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 4px 0 4px 4px; margin: -4px 0 -4px -4px; }
.pt-sub { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12.5px; color: var(--text-3, #999); }
.pt-faces { display: flex; }
.pt-faces .party-face { width: 22px; height: 22px; font-size: 10px; box-shadow: 0 0 0 2px var(--bg-panel, #121212); }
.pt-faces .party-face + .party-face { margin-left: -6px; }
.pt-invite { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,.12); background: none; color: var(--text, #fff); font: inherit; cursor: pointer; transition: background .15s, border-color .15s; }
.pt-invite:hover { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.22); }
.pt-invite .i { width: 15px; height: 15px; opacity: .8; }
.pt-invite code { font: inherit; font-size: 12.5px; font-weight: 700; letter-spacing: .12em; }
.pt-tabs { display: flex; gap: 20px; flex: none; border-bottom: 1px solid rgba(255,255,255,.07); }
.pt-tabs button { position: relative; display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; padding: 10px 0 11px; color: var(--text-3, #9a9a9a); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: color .15s; }
.pt-tabs button:hover { color: var(--text, #fff); }
.pt-tabs button.on { color: var(--text, #fff); }
.pt-tabs button.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--pc); }
.pt-tabs button.cog { margin-left: auto; }
.pt-tabs button .i { width: 17px; height: 17px; }
.pt-tabs em { font-style: normal; font-size: 11px; font-weight: 600; color: var(--text-3, #888); }
.pt-tabs em.hot { min-width: 16px; height: 16px; padding: 0 5px; border-radius: 99px; background: var(--pc); color: var(--on-accent, #000); display: grid; place-items: center; font-size: 10px; font-weight: 800; }
.pt-body { flex: 1 1 auto; min-height: 180px; overflow-y: auto; padding-top: 12px; scrollbar-width: thin; }

/* Queue */
.pq-label { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3, #888); margin: 4px 0 6px; }
.pq-label + .pq-row.now { margin-bottom: 14px; }
.pq-row { display: flex; align-items: center; gap: 12px; padding: 6px 8px; margin: 0 -8px; border-radius: 10px; }
.pq-row:hover { background: rgba(255,255,255,.05); }
.pq-row img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex: none; background: rgba(255,255,255,.06); }
.pq-row b { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pq-row .flex1 > span { display: block; font-size: 12.5px; color: var(--text-3, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.pq-row.now b { color: var(--pc); }
.pq-eq { color: var(--pc); flex: none; }
.pq-act { display: flex; gap: 2px; opacity: 0; transition: opacity .15s; }
.pq-row:hover .pq-act, .pq-act:focus-within { opacity: 1; }
@media (hover: none) { .pq-act { opacity: 1; } }
.pq-act button { width: 30px; height: 30px; border: 0; border-radius: 50%; background: none; color: var(--text-2, #bbb); display: grid; place-items: center; cursor: pointer; }
.pq-act button:hover { background: rgba(255,255,255,.08); color: #fff; }
.pq-empty { font-size: 13px; line-height: 1.55; color: var(--text-3, #999); margin: 6px 0; }

/* Chat */
.pt-body.pc { display: flex; flex-direction: column; overflow: hidden; padding-top: 0; }
.party-feed { flex: 1 1 auto; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; padding: 12px 2px 8px; scrollbar-width: thin; }
.pc-e2ee { align-self: center; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--text-3, #888); margin-bottom: 14px; }
.pc-e2ee .i { width: 12px; height: 12px; }
.pc-sys { align-self: center; font-size: 11.5px; color: var(--text-3, #888); margin: 6px 0; text-align: center; }
.pc-empty { margin: auto; text-align: center; color: var(--text-3, #888); font-size: 13px; line-height: 1.5; }
.pc-empty .i { opacity: .35; margin-bottom: 6px; }
.pc-empty p { margin: 0; }
.pc-msg { display: flex; align-items: flex-end; gap: 8px; margin-top: 2px; max-width: 86%; }
.pc-msg.first { margin-top: 10px; }
.pc-msg.mine { align-self: flex-end; flex-direction: row-reverse; }
.pc-av { width: 24px; flex: none; }
.pc-av .party-face { width: 24px; height: 24px; font-size: 10px; }
.pc-col { display: flex; flex-direction: column; min-width: 0; }
.pc-msg.mine .pc-col { align-items: flex-end; }
.pc-name { font-size: 11.5px; font-weight: 600; color: var(--text-3, #999); margin: 0 0 3px 12px; }
.pc-bub { padding: 8px 13px; border-radius: 18px; background: rgba(255,255,255,.07); color: var(--text, #f2f2f2); font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
.pc-msg:not(.mine):not(.first) .pc-bub { border-top-left-radius: 6px; }
.pc-msg:not(.mine):not(.last) .pc-bub { border-bottom-left-radius: 6px; }
.pc-msg.mine .pc-bub { background: color-mix(in srgb, var(--pc) 22%, rgba(255,255,255,.04)); color: #fff; }
.pc-msg.mine:not(.first) .pc-bub { border-top-right-radius: 6px; }
.pc-msg.mine:not(.last) .pc-bub { border-bottom-right-radius: 6px; }
.pc-bub em { font-style: normal; font-size: 12.5px; color: var(--text-3, #999); display: inline-flex; align-items: center; gap: 4px; }
.pc-time { font-size: 10.5px; color: var(--text-3, #777); margin: 3px 6px 0; }
.pc-reacts { display: none; gap: 4px; padding: 6px 0 2px; overflow-x: auto; scrollbar-width: none; flex: none; }
.pc-reacts.on { display: flex; }
.pc-reacts button { flex: 1 0 32px; height: 34px; border: 0; border-radius: 10px; background: rgba(255,255,255,.05); font-size: 17px; cursor: pointer; transition: transform .12s, background .15s; }
.pc-reacts button:hover { background: rgba(255,255,255,.1); }
.pc-reacts button:active { transform: scale(1.25); }
.pc-say { display: flex; align-items: center; gap: 4px; flex: none; margin-top: 8px; padding: 4px; border-radius: 999px; background: rgba(255,255,255,.06); border: 1px solid transparent; transition: border-color .15s, background .15s; }
.pc-say:focus-within { border-color: rgba(255,255,255,.14); background: rgba(255,255,255,.08); }
.pc-say input { flex: 1; min-width: 0; border: 0; background: none; outline: none; color: var(--text, #fff); font: inherit; font-size: 14px; padding: 7px 4px; }
.pc-emo, .pc-send { width: 34px; height: 34px; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer; flex: none; }
.pc-emo { background: none; color: var(--text-3, #999); }
.pc-emo:hover, .pc-emo.on { color: #fff; background: rgba(255,255,255,.08); }
.pc-send { background: var(--pc); color: var(--on-accent, #000); }
.pc-emo .i, .pc-send .i { width: 17px; height: 17px; }
.pc-note { display: flex; align-items: center; gap: 8px; flex: none; margin-top: 8px; padding: 10px 14px; border-radius: 14px; background: rgba(255,255,255,.05); color: var(--text-3, #999); font-size: 12.5px; line-height: 1.4; }
.pc-note .i { width: 15px; height: 15px; flex: none; }

/* People */
.pp-row { display: flex; align-items: center; gap: 12px; padding: 7px 8px; margin: 0 -8px; border-radius: 10px; }
.pp-row:hover { background: rgba(255,255,255,.04); }
.pp-row .party-face { width: 36px; height: 36px; font-size: 14px; }
.pp-row b { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-row b small { font-weight: 500; color: var(--text-3, #999); }
.pp-row .flex1 > span { display: block; font-size: 12.5px; color: var(--text-3, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-tag { flex: none; font-size: 11px !important; font-weight: 700; color: var(--pc) !important; padding: 3px 9px; border-radius: 99px; background: color-mix(in srgb, var(--pc) 14%, transparent); }
.pp-act { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .15s; }
.pp-row:hover .pp-act, .pp-act:focus-within { opacity: 1; }
@media (hover: none) { .pp-act { opacity: 1; } }
.pp-act button { height: 30px; min-width: 30px; padding: 0 10px; border: 0; border-radius: 99px; background: none; color: var(--text-2, #bbb); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; display: grid; place-items: center; }
.pp-act button:hover { background: rgba(255,255,255,.08); color: #fff; }
.pp-leave { display: block; width: 100%; margin-top: 14px; padding: 11px; border: 0; border-radius: 12px; background: rgba(239,68,68,.08); color: #f87171; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; }
.pp-leave:hover { background: rgba(239,68,68,.14); }

/* Settings */
.ps-name { display: flex; gap: 6px; margin-bottom: 10px; }
.ps-name input { flex: 1; min-width: 0; background: rgba(255,255,255,.06); border: 1px solid transparent; border-radius: 10px; padding: 9px 12px; color: var(--text, #fff); font: inherit; font-size: 14px; outline: none; }
.ps-name input:focus { border-color: rgba(255,255,255,.16); }
.ps-name button { border: 0; border-radius: 10px; padding: 0 14px; background: rgba(255,255,255,.08); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.ps-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,.05); cursor: pointer; }
.ps-row b { display: block; font-size: 14px; font-weight: 600; }
.ps-row span { display: block; font-size: 12.5px; color: var(--text-3, #999); margin-top: 1px; }
.ps-switch { appearance: none; -webkit-appearance: none; width: 38px; height: 22px; border-radius: 99px; background: rgba(255,255,255,.16); position: relative; cursor: pointer; flex: none; transition: background .2s; margin: 0; }
.ps-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .2s; }
.ps-switch:checked { background: var(--pc); }
.ps-switch:checked::after { transform: translateX(16px); }

.party-page .party-ui[data-live] { height: auto; min-height: calc(100dvh - 190px); }
.party-page .pt-body.pc { min-height: 55vh; }
#party-float { position: fixed; inset: 0; pointer-events: none; z-index: 9999; overflow: hidden; }
.party-emoji { position: absolute; bottom: 90px; display: flex; flex-direction: column; align-items: center; animation: party-rise 3.1s cubic-bezier(.2,.6,.3,1) forwards; }
.party-emoji span { font-size: 42px; filter: drop-shadow(0 4px 10px rgba(0,0,0,.4)); }
.party-emoji small { font-size: 11px; font-weight: 700; background: rgba(0,0,0,.55); color: #fff; padding: 2px 8px; border-radius: 999px; margin-top: 2px; }
@keyframes party-rise { 0% { transform: translate(0, 20px) scale(.4); opacity: 0; } 12% { transform: translate(0, 0) scale(1.15); opacity: 1; }
  100% { transform: translate(var(--dx), -55vh) rotate(var(--rot)) scale(.9); opacity: 0; } }
body.in-party [data-act="party"] { color: var(--accent); }
@media (prefers-reduced-motion: reduce) { .party-live-dot, .party-dots b, .party-along, .party-orb, .party-orb .i { animation: none; } }
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
