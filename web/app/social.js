/* ==========================================================================
   Axdio social — friends, listening activity and end-to-end encrypted messages.
   Loaded after core.js; adds AX.Social, AX.Chat and AX.E2EE for the desktop
   and mobile apps, which draw them through the UI.social(what, data) hook.

   Private messages (all Web Crypto, P-256, AES-256-GCM, HKDF-SHA-256):
   - Each account has an identity: an ECDH key pair (enc) and an ECDSA key pair
     (sig), made in the browser and kept in IndexedDB. The server gets the public
     halves, and a backup of the private halves sealed with a recovery key (160
     random bits shown once to the listener, never sent). Another device gets
     the identity by entering the recovery key, or from a device that has it:
     the new device posts an ephemeral public key, both screens show a code
     derived from that key, and the approving device seals the identity to it.
   - Contacts' public keys are pinned on first sight; a change is shown, and
     safety numbers let two people check that nobody swapped keys in between.
   - A conversation has versioned 256-bit keys. Whoever makes a version wraps
     it for each member (ephemeral ECDH with the member's key, HKDF, AES-GCM)
     and signs the record. A device only sends under a version that wraps for
     exactly the current members' pinned keys; otherwise it makes a new one.
   - Group membership is a hash-chained list of events, each signed by the
     member who made it. Clients work membership out from the events and only
     trust an addition signed by a known key.
   - Messages are AES-GCM under the conversation key (bound to conversation,
     message id, sender and key version) and signed by the sender.
   The server stores all of this and can't read any of it. What it can see:
   who talks to whom, when, and how long messages are.
   ========================================================================== */
(() => {
'use strict';
const AX = window.AX;
const { UI, U, LS, K, api, feat, esc, uniq, now, L, Collab } = AX;
const hook = (what, data) => { try { if (UI.social) UI.social(what, data); } catch (e) { console.error(e); } };

/* ======================================================================
   1. Encoding and crypto helpers
   ====================================================================== */
const te = new TextEncoder(), td = new TextDecoder();
const b64u = buf => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = str => {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};
const bytes = v => typeof v === 'string' ? te.encode(v) : v;
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; }); return out; };
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const rand = n => crypto.getRandomValues(new Uint8Array(n));
// A stable JSON form (sorted keys) for everything that gets signed.
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
const subtle = () => crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' }, ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const sha = async (data, alg = 'SHA-256') => new Uint8Array(await subtle().digest(alg, bytes(data)));
async function kdf(secret, salt, info) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: te.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, plain, aad) {
  const iv = rand(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes(plain));
  return { iv: b64u(iv), ct: b64u(ct) };
}
async function unseal(key, box, aad) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(box.iv), additionalData: te.encode(aad) }, key, unb64u(box.ct)));
}
const pubCache = new Map();
function importPub(raw, alg) {
  const k = alg.name + raw;
  if (!pubCache.has(k)) pubCache.set(k, subtle().importKey('raw', unb64u(raw), alg, true, alg.name === 'ECDSA' ? ['verify'] : []));
  return pubCache.get(k);
}
async function ecdh(priv, pubRaw, salt, info) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importPub(pubRaw, ECDH) }, priv, 256);
  return kdf(new Uint8Array(bits), salt, info);
}
async function verifySig(pubRaw, sig, data) {
  try { return await subtle().verify(SIGN, await importPub(pubRaw, ECDSA), unb64u(sig), te.encode(data)); } catch (e) { return false; }
}

// Recovery keys: 20 random bytes as 32 base32 characters, shown in groups of four.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function rkEncode(b) {
  let bits = 0, val = 0, out = '';
  for (const x of b) { val = ((val & 31) << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{1,4}/g).join('-');
}
function rkDecode(str) {
  const s = String(str || '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/[^A-Z2-7]/g, '');
  if (s.length !== 32) return null;
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) { val = ((val & 255) << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}

/* ======================================================================
   2. Device storage (IndexedDB): this device's identity and pinned contacts
   ====================================================================== */
const IDB = {
  db: null,
  open() {
    if (!this.db) this.db = new Promise((res, rej) => {
      const r = indexedDB.open('axdio-e2ee', 2);
      r.onupgradeneeded = () => { ['ids', 'pins', 'dev'].forEach(s => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => { const q = fn(db.transaction(store, mode).objectStore(store)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  get(store, key) { return this.run(store, 'readonly', s => s.get(key)); },
  put(store, key, val) { return this.run(store, 'readwrite', s => s.put(val, key)); },
  del(store, key) { return this.run(store, 'readwrite', s => s.delete(key)); },
};

/* ======================================================================
   3. Identity, recovery, device linking and contact keys
   ====================================================================== */
async function bundle(encPub, sigPub) {
  const e = new Uint8Array(await subtle().exportKey('raw', encPub)), s = new Uint8Array(await subtle().exportKey('raw', sigPub));
  return { enc: b64u(e), sig: b64u(s), fp: hex(await sha(concat(te.encode('axdio-id-v1'), e, s))) };
}
async function newIdentity() {
  const enc = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const sig = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
  return { enc, sig, pub: await bundle(enc.publicKey, sig.publicKey) };
}
async function exportIdentity(id) {
  return { enc: await subtle().exportKey('jwk', id.enc.privateKey), sig: await subtle().exportKey('jwk', id.sig.privateKey) };
}
async function importIdentity(j) {
  const pub = k => { const x = Object.assign({}, k); delete x.d; delete x.key_ops; return x; };
  const enc = { privateKey: await subtle().importKey('jwk', j.enc, ECDH, true, ['deriveBits']), publicKey: await subtle().importKey('jwk', pub(j.enc), ECDH, true, []) };
  const sig = { privateKey: await subtle().importKey('jwk', j.sig, ECDSA, true, ['sign']), publicKey: await subtle().importKey('jwk', pub(j.sig), ECDSA, true, ['verify']) };
  return { enc, sig, pub: await bundle(enc.publicKey, sig.publicKey) };
}
async function makeBackup(rk, id) {
  const salt = rand(16), key = await kdf(rkDecode(rk), salt, 'axdio-backup-v1');
  return Object.assign({ salt: b64u(salt) }, await seal(key, JSON.stringify(await exportIdentity(id)), `axdio-backup-v1|${U.username}|${id.pub.fp}`));
}
async function linkCode(pubRaw) {
  const h = await sha(unb64u(pubRaw));
  return String((((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 1e6).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
}

const E2EE = {
  // off: signed out or messages turned off · unsupported: this browser can't (needs HTTPS) · none: not set up yet ·
  // locked: set up, but not on this device · ready
  state: 'off', me: null, server: null, pending: null, pins: new Map(), seenLinks: new Set(),
  set(state) { if (this.state !== state) { this.state = state; hook('e2ee', state); } },
  supported() { return !!(window.isSecureContext && window.crypto && crypto.subtle && window.indexedDB); },
  async init() {
    if (!U.token || !feat('social') || !feat('chat')) { this.me = null; this.set('off'); return; }
    if (!this.supported()) { this.set('unsupported'); return; }
    let server;
    try { server = (await api('/api/chat/keys?users=' + encodeURIComponent(U.username))).keys[U.username]; } catch (e) { return; }
    this.server = server;
    const local = await IDB.get('ids', U.username).catch(() => null);
    if (!server) { this.me = null; this.set('none'); return; }
    if (local && local.pub && local.pub.fp === server.fp) { this.me = local; await this.pinSelf(); this.set('ready'); return; }
    this.me = null;
    this.set('locked');
  },
  async adopt(id, rk) {
    id.rk = rk;
    await IDB.put('ids', U.username, id);
    this.me = id;
    this.server = Object.assign({}, id.pub);
    Chat.keys.clear();
    await this.pinSelf();
    this.set('ready');
    Chat.refresh();
  },
  // First device: make the identity, publish it with its recovery backup. Returns the recovery key to show.
  async setup(reset = false) {
    const id = await newIdentity(), rk = rkEncode(rand(20));
    try { await api('/api/chat/keys', Object.assign({ backup: await makeBackup(rk, id), reset }, id.pub)); }
    catch (e) { if (e.status === 409) { await this.init(); throw new Error('Private messages were just set up on another of your devices. Unlock them here instead.'); } throw e; }
    if (reset && this.me) await this.retire(this.me);
    await this.adopt(id, rk);
    return rk;
  },
  async unlock(rkText) {
    const key = rkDecode(rkText);
    if (!key) throw new Error("That isn't a recovery key. It's 32 letters and numbers, like ABCD-EFGH-….");
    const { backup, fp } = await api('/api/chat/backup');
    let id;
    try { id = await importIdentity(JSON.parse(td.decode(await unseal(await kdf(key, unb64u(backup.salt), 'axdio-backup-v1'), backup, `axdio-backup-v1|${U.username}|${fp}`)))); }
    catch (e) { throw new Error("That recovery key doesn't match. Check it and try again."); }
    if (id.pub.fp !== fp) throw new Error("That recovery key is for older keys.");
    await this.adopt(id, rkEncode(key));
  },
  // A new device asks another of the account's devices for the identity.
  async requestLink() {
    const eph = await subtle().generateKey(ECDH, false, ['deriveBits']);
    const pub = b64u(await subtle().exportKey('raw', eph.publicKey));
    const r = await api('/api/chat/link', { pub });
    this.pending = { id: r.id, eph, pub, expires: r.expires * 1000, code: await linkCode(pub) };
    return this.pending;
  },
  async checkLink() {
    const p = this.pending; if (!p) return 'none';
    const r = await api('/api/chat/link/' + encodeURIComponent(p.id));
    if (r.state === 'approved') {
      const j = JSON.parse(td.decode(await unseal(await ecdh(p.eph.privateKey, r.x, p.id, 'axdio-link-v1'), r.blob, `axdio-link-v1|${p.id}|${U.username}`)));
      const id = await importIdentity(j);
      const server = (await api('/api/chat/keys?users=' + encodeURIComponent(U.username))).keys[U.username];
      if (!server || server.fp !== id.pub.fp) throw new Error("The keys from your other device don't match this account's.");
      this.pending = null;
      await this.adopt(id, j.rk || '');
    } else if (r.state !== 'pending') this.pending = null;
    return r.state;
  },
  cancelLink() { this.pending = null; },
  // Devices that already have the identity see requests from new ones and can approve them.
  async links() {
    if (this.state !== 'ready') return [];
    const list = (await api('/api/chat/links')).links || [];
    for (const l of list) l.code = await linkCode(l.pub);
    return list;
  },
  async checkLinks() {
    const fresh = (await this.links().catch(() => [])).filter(l => !this.seenLinks.has(l.id));
    fresh.forEach(l => this.seenLinks.add(l.id));
    if (fresh.length) hook('link-request', fresh[0]);
  },
  async approve(l) {
    const x = await subtle().generateKey(ECDH, false, ['deriveBits']);
    const body = Object.assign(await exportIdentity(this.me), { rk: this.me.rk || '' });
    const blob = await seal(await ecdh(x.privateKey, l.pub, l.id, 'axdio-link-v1'), JSON.stringify(body), `axdio-link-v1|${l.id}|${U.username}`);
    await api(`/api/chat/link/${encodeURIComponent(l.id)}/approve`, { x: b64u(await subtle().exportKey('raw', x.publicKey)), blob });
  },
  deny(l) { return api(`/api/chat/link/${encodeURIComponent(l.id)}/deny`, {}); },
  recoveryKey() { return (this.me && this.me.rk) || ''; },
  // A fresh recovery key replaces the old one (for when the old one was lost or seen by someone else).
  async newRecoveryKey() {
    const rk = rkEncode(rand(20));
    await api('/api/chat/backup', { backup: await makeBackup(rk, this.me) });
    this.me.rk = rk;
    await IDB.put('ids', U.username, this.me);
    return rk;
  },
  async forgetDevice() { await IDB.del('ids', U.username).catch(() => {}); this.me = null; Chat.keys.clear(); this.set(this.server ? 'locked' : 'none'); },
  async retire(old) {
    const pin = await this.pin(U.username);
    if (pin) { pin.old = [{ fp: old.pub.fp, sig: old.pub.sig }, ...(pin.old || [])].slice(0, 10); await IDB.put('pins', this.pinKey(U.username), pin); }
  },

  // Contacts' keys as this device first saw them (trust on first use). A change is recorded and shown.
  pinKey(user) { return U.username + '|' + user; },
  async pin(user, keys) {
    let p = this.pins.get(user);
    if (p === undefined) { p = (await IDB.get('pins', this.pinKey(user)).catch(() => null)) || null; this.pins.set(user, p); }
    if (!keys) return p;
    if (!p) p = { fp: keys.fp, enc: keys.enc, sig: keys.sig, verified: false, t: now(), old: [] };
    else if (p.fp !== keys.fp) {
      p.old = [{ fp: p.fp, sig: p.sig }, ...(p.old || [])].slice(0, 10);
      p.changed = { t: now(), wasVerified: !!p.verified, seen: false };
      Object.assign(p, { fp: keys.fp, enc: keys.enc, sig: keys.sig, verified: false });
    } else return p;
    this.pins.set(user, p);
    await IDB.put('pins', this.pinKey(user), p).catch(() => {});
    return p;
  },
  async pinSelf() { if (this.me) await this.pin(U.username, this.me.pub); },
  async setPin(user, patch) {
    const p = await this.pin(user); if (!p) return;
    Object.assign(p, patch);
    this.pins.set(user, p);
    await IDB.put('pins', this.pinKey(user), p).catch(() => {});
    hook('chats');
  },
  // Someone you had verified changed keys: sending to them waits until you look at the new safety number.
  blocked(user) { const p = this.pins.get(user); return !!(p && p.changed && p.changed.wasVerified && !p.verified && !p.changed.ok); },
  // 60 digits both people see the same way round; they match only if neither key was swapped.
  async safetyNumber(user) {
    const theirs = await this.pin(user); if (!theirs || !this.me) return '';
    const pair = [[U.username, this.me.pub.fp], [user, theirs.fp]].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const h = await sha(`axdio-safety-v1|${pair[0][0]}|${pair[0][1]}|${pair[1][0]}|${pair[1][1]}`, 'SHA-512');
    const groups = [];
    for (let i = 0; i < 12; i++) {
      let n = 0;
      for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
      groups.push(String(n % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
  },
  // 'ok' when a pinned key for the user (current or earlier) made the signature, 'unknown' when no key
  // this device knows did, 'bad' when the user's current key should have and didn't.
  async check(user, sig, data) {
    const p = await this.pin(user);
    if (!p) return 'unknown';
    if (await verifySig(p.sig, sig, data)) return 'ok';
    for (const o of p.old || []) if (await verifySig(o.sig, sig, data)) return 'ok';
    return 'unknown';
  },
  sign(data) { return subtle().sign(SIGN, this.me.sig.privateKey, te.encode(data)).then(b64u); },
};

/* This device's own keys, for secret chats. The private halves can't be exported (not even by this app) and never
   leave the device: not to the server and not into the recovery backup. The account's signing key vouches for the
   public halves, so the other person's device can tell they're really this account's. Signing out deletes them. */
const devFp = (enc, sig) => sha(concat(te.encode('axdio-dev-v1'), unb64u(enc), unb64u(sig))).then(hex);
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux computer' : 'device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} (${br})`;
}
const Device = {
  me: null,
  async get() {
    if (this.me && this.me.user === U.username) return this.me;
    let d = await IDB.get('dev', U.username).catch(() => null);
    if (!d) {
      const enc = await subtle().generateKey(ECDH, false, ['deriveBits']), sig = await subtle().generateKey(ECDSA, false, ['sign', 'verify']);
      d = { id: b64u(rand(12)), enc, sig, created: now(),
            pub: { enc: b64u(new Uint8Array(await subtle().exportKey('raw', enc.publicKey))), sig: b64u(new Uint8Array(await subtle().exportKey('raw', sig.publicKey))) } };
      await IDB.put('dev', U.username, d);
    }
    d.fp = await devFp(d.pub.enc, d.pub.sig);
    d.user = U.username;
    this.me = d;
    return d;
  },
  certData(user, dev) { return canon({ t: 'device', user, id: dev.id, enc: dev.enc, sig: dev.sig }); },
  async card() { const d = await this.get(), c = { id: d.id, enc: d.pub.enc, sig: d.pub.sig, label: deviceLabel() }; c.cert = await E2EE.sign(this.certData(U.username, c)); return c; },
  async trusted(user, dev) { return !!(dev && dev.cert) && await E2EE.check(user, dev.cert, this.certData(user, dev)) === 'ok'; },
  async sign(data) { const d = await this.get(); return b64u(await subtle().sign(SIGN, d.sig.privateKey, te.encode(data))); },
  async forget(user) { await IDB.del('dev', user).catch(() => {}); this.me = null; },
};

/* ======================================================================
   4. Conversations and messages
   ====================================================================== */
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const REACTIONS = ['❤️', '🔥', '😂', '😮', '😢', '👍'];

const Chat = {
  list: [], byId: new Map(), ready: false, open: '', threads: new Map(), keys: new Map(), loading: null,
  card(c, name) {
    const p = c && c.people && c.people[name];
    return p || Social.cards.get(name) || { username: name, display_name: name ? 'Deleted account' : 'Someone', avatar: '', gone: true };
  },
  others(c) { return (c.st ? c.st.members : c.members).filter(m => m !== U.username); },
  peer(c) { return c.kind === 'dm' || c.kind === 'secret' ? c.members.find(m => m !== U.username) : ''; },
  title(c) {
    if (c.kind === 'dm') return this.card(c, this.peer(c)).display_name;
    if (c.st && c.st.name) return c.st.name;
    const names = this.others(c).map(m => this.card(c, m).display_name);
    return names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') : 'Group';
  },
  unreadTotal() { return this.list.reduce((n, c) => n + (c.unread || 0), 0); },
  async refresh() {
    if (!U.token || !feat('social') || !feat('chat')) { this.list = []; this.byId = new Map(); hook('chats'); return; }
    // A change that arrives while a refresh is running gets a refresh of its own, or it would be missed until the next one.
    if (this.loading) { this.again = true; return this.loading; }
    this.again = false;
    this.loading = (async () => {
      try {
        const d = await api('/api/chat/conversations');
        const list = [];
        for (const c of d.conversations || []) { const p = await this.prep(c); if (!(p.secret && p.st.elsewhere)) list.push(p); }
        this.list = list;
        this.byId = new Map(list.map(c => [c.id, c]));
        this.ready = true;
        hook('chats');
        if (this.open && this.byId.has(this.open)) this.pull(this.open);
      } catch (e) { /* offline */ } finally { this.loading = null; }
      if (this.again) return this.refresh();
    })();
    return this.loading;
  },
  async prep(c) {
    for (const [name, p] of Object.entries(c.people || {})) {
      Social.cards.set(name, { username: name, display_name: p.display_name, avatar: p.avatar });
      if (p.keys && E2EE.state === 'ready') await E2EE.pin(name, p.keys);
    }
    if (c.kind === 'secret') { c.secret = true; c.kind = 'dm'; }
    c.st = c.secret ? await this.secretState(c) : c.kind === 'group' ? await this.groupState(c) : { members: c.members.slice(), ok: c.members.length === 2 && c.members.includes(U.username), problem: '' };
    if (c.gone && c.gone.length) c.st.problem = 'This account no longer exists.';
    if (c.kind === 'group' && c.st.title && E2EE.state === 'ready') {
      try { c.st.name = td.decode(await unseal(await this.key(c, c.st.title.v), c.st.title.title, `axdio-title-v1|${c.id}|${c.st.title.n}`)).slice(0, 100); } catch (e) { /* not ours to read */ }
    }
    c.preview = c.last ? await this.decrypt(c, c.last) : null;
    // Messages unsent since they were shown.
    const th = this.threads.get(c.id);
    if (th && (c.unsent || []).length) {
      const gone = new Set(c.unsent);
      if (th.msgs.some(m => gone.has(m.id) && !m.deleted)) { th.msgs.forEach(m => { if (gone.has(m.id)) Object.assign(m, { deleted: true, body: null }); }); hook('thread', c.id); }
    }
    return c;
  },
  merge(c) {
    return this.prep(c).then(p => {
      if (p.secret && p.st.elsewhere) { this.list = this.list.filter(x => x.id !== p.id); this.byId.delete(p.id); hook('chats'); return p; }
      const i = this.list.findIndex(x => x.id === p.id);
      if (i >= 0) this.list[i] = p; else this.list.unshift(p);
      this.byId.set(p.id, p);
      hook('chats');
      return p;
    });
  },
  // Group membership from the signed events: who's in, who's the admin, the latest name.
  async groupState(c) {
    const st = { members: [], ok: true, problem: '', title: null };
    let prev = '';
    for (const [i, ev] of (c.events || []).entries()) {
      if (ev.t === 'gone') { st.members = st.members.filter(m => m !== ev.user); prev = b64u(await sha(canon(ev))); continue; }
      const signed = canon(Object.assign({}, ev, { sig: undefined }));
      const who = E2EE.state === 'ready' ? await E2EE.check(ev.by, ev.sig, signed) : 'unknown';
      const chained = ev.n === i && (ev.prev || '') === prev && ev.conv === c.id;
      if (!chained) { st.ok = false; st.problem = "This group's history has been changed on the server, so it can't be trusted."; break; }
      if (ev.t === 'create') {
        if (i !== 0 || !Array.isArray(ev.members) || ev.members[0] !== ev.by || who !== 'ok') { st.ok = false; st.problem = "This group's members can't be verified on this device."; }
        st.members = (ev.members || []).slice();
      } else if (!st.members.includes(ev.by)) { st.ok = false; st.problem = 'Someone outside this group changed it.'; }
      else if (ev.t === 'add') {
        if (who !== 'ok') { st.ok = false; st.problem = "Someone was added to this group by a key this device doesn't know."; }
        if (!st.members.includes(ev.user)) st.members.push(ev.user);
      } else if (ev.t === 'remove') { if (ev.by === st.members[0]) st.members = st.members.filter(m => m !== ev.user); }
      else if (ev.t === 'leave') st.members = st.members.filter(m => m !== ev.by);
      else if (ev.t === 'title') st.title = ev;
      prev = b64u(await sha(canon(ev)));
    }
    const server = c.members.slice().sort(), mine = st.members.slice().sort();
    if (st.ok && !sameSet(server, mine)) { st.ok = false; st.problem = "This group's member list on the server doesn't match its history."; }
    st.admin = st.members[0] || '';
    return st;
  },
  // A secret chat: which device holds each side, and whether this is one of them.
  async secretState(c) {
    const me = U.username, other = c.members.find(m => m !== me), devs = c.devices || {}, name = this.card(c, other).display_name;
    const st = { members: c.members.slice(), ok: true, problem: '', peer: other };
    const d = E2EE.state === 'ready' ? await Device.get().catch(() => null) : null;
    st.here = !!(d && devs[me] && devs[me].id === d.id);
    st.invite = !devs[me];
    st.elsewhere = !!devs[me] && !st.here;
    st.waiting = !devs[other];
    if (E2EE.state === 'ready') for (const u of Object.keys(devs)) if (!(await Device.trusted(u, devs[u]))) { st.ok = false; st.problem = "This secret chat's device keys can't be verified, so it isn't safe to use."; return st; }
    st.quiet = st.invite || (st.here && st.waiting);     // the chat's own banner says it (web/app/chatmedia.js)
    if (st.invite) { st.ok = false; st.problem = `${name} started a secret chat. Open it on this device to read and reply.`; }
    else if (st.elsewhere) { st.ok = false; st.problem = 'This secret chat is open on another of your devices.'; }
    else if (st.waiting) { st.ok = false; st.problem = `Waiting for ${name} to open this secret chat on their device.`; }
    return st;
  },
  dkeyData(rec) { return canon({ t: 'dkey', key: this.keyData(rec), dev: rec.dev }); },
  // Secret chats: the key is sealed to this device's own key, and must be signed by one of the chat's two devices.
  async secretKey(c, v, rec) {
    const me = U.username, d = await Device.get(), devs = c.devices || {}, signer = rec && devs[rec.by];
    if (!rec || !rec.wraps[me] || !devs[me] || devs[me].id !== d.id) throw new Error('nokey');
    if (rec.fps[me] !== d.fp) throw new Error('oldkey');
    if (!signer || rec.dev !== signer.id || !(await Device.trusted(rec.by, signer)) || !(await verifySig(signer.sig, rec.dsig, this.dkeyData(rec)))) throw new Error('decrypt');
    const w = rec.wraps[me];
    const raw = await unseal(await ecdh(d.enc.privateKey, w.e, `${c.id}|${v}`, 'axdio-convkey-v1'), w, `axdio-convkey-v1|${c.id}|${v}|${me}`);
    const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    this.keys.set(c.id + '|' + v, key);
    return key;
  },
  async secret(username) {
    if (E2EE.state !== 'ready') throw new Error('Unlock private messages on this device first.');
    return this.merge(await api('/api/chat/secret', { username, device: await Device.card() }));
  },
  async acceptSecret(cid) {
    if (E2EE.state !== 'ready') throw new Error('Unlock private messages on this device first.');
    const c = await this.merge(await api(`/api/chat/${cid}/accept`, { device: await Device.card() }));
    hook('thread', cid);
    return c;
  },
  async key(c, v) {
    const k = c.id + '|' + v;
    if (this.keys.has(k)) return this.keys.get(k);
    const rec = (c.keys || []).find(x => x.v === v), me = U.username;
    if (c.secret) return this.secretKey(c, v, rec);
    if (!rec || !rec.wraps[me] || !E2EE.me) throw new Error('nokey');
    if (rec.fps[me] !== E2EE.me.pub.fp) throw new Error('oldkey');
    const w = rec.wraps[me];
    const raw = await unseal(await ecdh(E2EE.me.enc.privateKey, w.e, `${c.id}|${v}`, 'axdio-convkey-v1'), w, `axdio-convkey-v1|${c.id}|${v}|${me}`);
    const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    this.keys.set(k, key);
    return key;
  },
  keyData(rec) { return canon({ t: 'key', conv: rec.conv, v: rec.v, by: rec.by, ts: rec.ts, ev: rec.ev, members: rec.members, wraps: rec.wraps, fps: rec.fps }); },
  // Why this device can't send here right now, or ''.
  async sendProblem(c) {
    if (E2EE.state !== 'ready') return 'locked';
    if (!c.st.ok) return c.st.problem;
    const missing = c.st.members.filter(m => m !== U.username && !(c.people[m] && c.people[m].keys));
    if (missing.length) return `Waiting for ${missing.map(m => this.card(c, m).display_name).join(', ')} to turn on private messages.`;
    const held = c.st.members.filter(m => m !== U.username && E2EE.blocked(m));
    if (held.length) return `${this.card(c, held[0]).display_name}'s security code changed. Check it before you send anything.`;
    return '';
  },
  // The key to send with: the newest one if it's for exactly the current members' pinned keys, else a new one.
  async sendKey(c) {
    const problem = await this.sendProblem(c);
    if (problem) throw new Error(problem === 'locked' ? 'Unlock private messages on this device first.' : problem);
    const members = c.st.members, last = (c.keys || [])[c.keys.length - 1];
    if (c.secret) {
      const devs = c.devices || {};
      if (last && devs[last.by] && last.dev === devs[last.by].id && (await Promise.all(members.map(async m => last.fps[m] === await devFp(devs[m].enc, devs[m].sig)))).every(Boolean)) {
        try { return { v: last.v, key: await this.key(c, last.v) }; } catch (e) { /* make a new one */ }
      }
      return this.rotate(c, members);
    }
    if (last && sameSet(last.members, members)) {
      const pins = await Promise.all(members.map(m => E2EE.pin(m)));
      const fresh = members.every((m, i) => pins[i] && last.fps[m] === pins[i].fp);
      if (fresh && (last.by === U.username || await E2EE.check(last.by, last.sig, this.keyData(last)) === 'ok')) {
        try { return { v: last.v, key: await this.key(c, last.v) }; } catch (e) { /* not wrapped for this device's keys: make a new one */ }
      }
    }
    return this.rotate(c, members);
  },
  async rotate(c, members) {
    const raw = rand(32), last = (c.keys || [])[c.keys.length - 1], v = (last ? last.v : 0) + 1;
    const wraps = {}, fps = {};
    for (const m of members) {
      // Secret chats seal the key to each side's one device; everything else to the people's account keys.
      const pin = c.secret ? c.devices[m] : await E2EE.pin(m);
      if (c.secret && !(await Device.trusted(m, pin))) throw new Error("This secret chat's device keys can't be verified.");
      const eph = await subtle().generateKey(ECDH, false, ['deriveBits']);
      wraps[m] = Object.assign({ e: b64u(await subtle().exportKey('raw', eph.publicKey)) },
        await seal(await ecdh(eph.privateKey, pin.enc, `${c.id}|${v}`, 'axdio-convkey-v1'), raw, `axdio-convkey-v1|${c.id}|${v}|${m}`));
      fps[m] = c.secret ? await devFp(pin.enc, pin.sig) : pin.fp;
    }
    const rec = { conv: c.id, v, by: U.username, ts: Date.now(), ev: (c.events || []).length, members: members.slice().sort(), wraps, fps };
    rec.sig = await E2EE.sign(this.keyData(rec));
    if (c.secret) { rec.dev = (await Device.get()).id; rec.dsig = await Device.sign(this.dkeyData(rec)); }
    const conv = await api(`/api/chat/${c.id}/keys`, { key: rec });
    this.keys.set(c.id + '|' + v, await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    const fresh = await this.merge(conv);
    // Carry the group's name over to the new key so people who just joined can read it.
    if (fresh.kind === 'group' && fresh.st.name && fresh.st.title && fresh.st.title.v !== v) await this.rename(fresh.id, fresh.st.name, v);
    return { v, key: this.keys.get(c.id + '|' + v) };
  },
  msgData(conv, m) { return canon({ t: 'msg', conv, id: m.id, from: m.sender, v: m.v, iv: m.iv, ct: m.ct }); },
  async decrypt(c, m) {
    const out = { id: m.id, seq: m.seq, from: m.sender, ts: m.ts * 1000, mine: m.sender === U.username, body: null, err: '', trust: '', expires: m.expires ? m.expires * 1000 : 0 };
    if (m.deleted) { out.deleted = true; return out; }
    if (E2EE.state !== 'ready') { out.err = 'locked'; return out; }
    try {
      out.body = JSON.parse(td.decode(await unseal(await this.key(c, m.v), m, `axdio-msg-v1|${c.id}|${m.id}|${m.sender}|${m.v}`)));
      out.trust = await E2EE.check(m.sender, m.sig, this.msgData(c.id, m));
    } catch (e) { out.err = e.message === 'oldkey' || e.message === 'nokey' ? 'keys' : 'decrypt'; }
    return out;
  },
  thread(cid) {
    if (!this.threads.has(cid)) this.threads.set(cid, { msgs: [], more: true, loaded: false, reacts: new Map() });
    return this.threads.get(cid);
  },
  async add(c, th, rows, older) {
    const have = new Set(th.msgs.map(m => m.id));
    const got = [];
    for (const r of rows) if (!have.has(r.id)) got.push(await this.decrypt(c, r));
    const fresh = got.filter(m => !(m.body && m.body.re));
    got.filter(m => m.body && m.body.re).forEach(m => {
      const r = th.reacts.get(m.body.re.id) || new Map();
      if (m.body.re.e) r.set(m.from, m.body.re.e); else r.delete(m.from);
      th.reacts.set(m.body.re.id, r);
    });
    th.msgs = older ? [...fresh, ...th.msgs] : [...th.msgs, ...fresh];
    th.top = rows.reduce((n, r) => Math.max(n, r.seq || 0), th.top || 0);   // reactions included, for read markers
    // Unsent messages come back as tombstones: replace what was shown.
    rows.filter(r => r.deleted).forEach(r => { const m = th.msgs.find(x => x.id === r.id); if (m) Object.assign(m, { deleted: true, body: null }); });
    return got.length;
  },
  async load(cid) {
    const c = this.byId.get(cid); if (!c) return;
    const th = this.thread(cid);
    const d = await api(`/api/chat/${cid}/messages?limit=50`);
    th.msgs = []; th.reacts = new Map(); th.top = 0;
    await this.add(c, th, d.messages || [], false);
    th.more = !!d.more; th.loaded = true;
    hook('thread', cid);
    this.markRead(cid);
  },
  async older(cid) {
    const c = this.byId.get(cid), th = this.thread(cid);
    if (!c || !th.more || th.busy) return;
    th.busy = true;
    try {
      const first = th.msgs.length ? th.msgs[0].seq : null;
      const d = await api(`/api/chat/${cid}/messages?limit=50${first ? '&before=' + first : ''}`);
      await this.add(c, th, d.messages || [], true);
      th.more = !!d.more;
      hook('thread', cid);
    } finally { th.busy = false; }
  },
  async pull(cid) {
    const c = this.byId.get(cid), th = this.thread(cid);
    if (!c || !th.loaded) return this.load(cid);
    const last = th.top || 0;
    const d = await api(`/api/chat/${cid}/messages?after=${last}&limit=100`);
    if (await this.add(c, th, d.messages || [], false)) hook('thread', cid);
    if ((th.top || 0) > last) this.markRead(cid);
  },
  markRead(cid) {
    const c = this.byId.get(cid), th = this.thread(cid);
    const top = th.top || 0;
    if (!c || !top || (c.reads && c.reads[U.username] >= top)) return;
    c.reads = Object.assign({}, c.reads, { [U.username]: top });
    c.unread = 0;
    hook('chats');
    api(`/api/chat/${cid}/read`, { seq: top }).catch(() => {});
  },
  // `files`: ids of encrypted attachments this message carries (web/app/chatmedia.js), so the server can remove them with it.
  async post(cid, body, attempt = 0, files) {
    let c = this.byId.get(cid);
    if (!c) throw new Error('That conversation is gone.');
    try {
      const { v, key } = await this.sendKey(c);
      const id = b64u(rand(16));
      const box = await seal(key, JSON.stringify(Object.assign({ at: Date.now() }, body)), `axdio-msg-v1|${cid}|${id}|${U.username}|${v}`);
      const sig = await E2EE.sign(this.msgData(cid, { id, sender: U.username, v, iv: box.iv, ct: box.ct }));
      const { message } = await api(`/api/chat/${cid}/messages`, Object.assign({ id, v, sig }, box, files && files.length ? { files } : {}));
      const th = this.thread(cid);
      await this.add(c, th, [message], false);
      c = this.byId.get(cid);
      if (!(body && body.re)) { c.last = message; c.preview = await this.decrypt(c, message); }
      hook('thread', cid); hook('chats');
      return message;
    } catch (e) {
      if (e.status === 409 && attempt < 2 && !/attachment/.test(e.message)) { await this.merge(await api(`/api/chat/${cid}`)); return this.post(cid, body, attempt + 1, files); }
      throw e;
    }
  },
  send(cid, text, extra = {}) {
    text = String(text || '').slice(0, 4000);
    if (!text.trim() && !extra.a) return Promise.resolve(null);
    return this.post(cid, Object.assign({ t: text }, extra));
  },
  react(cid, msgId, emoji) {
    const th = this.thread(cid), cur = (th.reacts.get(msgId) || new Map()).get(U.username);
    return this.post(cid, { re: { id: msgId, e: cur === emoji ? '' : emoji } });
  },
  async unsend(cid, msgId) {
    await api(`/api/chat/${cid}/messages/${encodeURIComponent(msgId)}`, undefined, 'DELETE');
    const m = this.thread(cid).msgs.find(x => x.id === msgId);
    if (m) Object.assign(m, { deleted: true, body: null });
    hook('thread', cid);
  },
  async hide(cid) {
    await api(`/api/chat/${cid}/hide`, {});
    this.threads.delete(cid);
    this.list = this.list.filter(c => c.id !== cid); this.byId.delete(cid);
    hook('chats');
  },
  async dm(username) {
    const c = await this.merge(await api('/api/chat/dm', { username }));
    return c;
  },
  // Group changes are signed events chained to the previous one.
  async event(c, ev) {
    const last = (c.events || [])[c.events.length - 1];
    const e = Object.assign({ conv: c.id, by: U.username, n: (c.events || []).length, prev: last ? b64u(await sha(canon(last))) : '', ts: Date.now() }, ev);
    e.sig = await E2EE.sign(canon(e));
    return e;
  },
  async group(members, name) {
    if (E2EE.state !== 'ready') throw new Error('Unlock private messages on this device first.');
    const id = 'gr_' + b64u(rand(16));
    const ev = await this.event({ id, events: [] }, { t: 'create', members: [U.username, ...members.filter(m => m !== U.username)] });
    const c = await this.merge(await api('/api/chat/groups', { event: ev }));
    if (name) await this.rename(c.id, name);
    return this.byId.get(c.id);
  },
  async change(cid, ev, attempt = 0) {
    const c = this.byId.get(cid);
    try {
      const r = await api(`/api/chat/${cid}/events`, { event: await this.event(c, ev) });
      if (r.left) { this.list = this.list.filter(x => x.id !== cid); this.byId.delete(cid); hook('chats'); return null; }
      return this.merge(r);
    } catch (e) {
      if (e.status === 409 && attempt < 2) { await this.merge(await api(`/api/chat/${cid}`)); return this.change(cid, ev, attempt + 1); }
      throw e;
    }
  },
  addMember(cid, user) { return this.change(cid, { t: 'add', user }); },
  removeMember(cid, user) { return this.change(cid, { t: 'remove', user }); },
  leave(cid) { return this.change(cid, { t: 'leave' }); },
  async rename(cid, name, v) {
    const c = this.byId.get(cid);
    name = String(name || '').trim().slice(0, 100);
    if (!name) return c;
    const key = v ? { v, key: this.keys.get(cid + '|' + v) } : await this.sendKey(c);
    const fresh = this.byId.get(cid);
    const n = (fresh.events || []).length;
    return this.change(cid, { t: 'title', v: key.v, title: await seal(key.key, name, `axdio-title-v1|${cid}|${n}`) });
  },
};

/* ======================================================================
   5. Friends, activity and polling
   ====================================================================== */
const Social = {
  me: { friends: [], incoming: [], outgoing: [], blocked: [], settings: { share_activity: true, discoverable: true } },
  activity: [], activityAt: 0, activityOpen: false, ready: false, cards: new Map(), pulse: null, sv: null, timer: 0, running: false,
  on() { return !!(U.token && feat('social')); },
  remember(list) { (list || []).forEach(c => this.cards.set(c.username, c)); },
  async refresh() {
    if (!this.on()) return;
    try {
      this.me = await api('/api/social/me');
      ['friends', 'incoming', 'outgoing', 'blocked'].forEach(k => this.remember(this.me[k]));
      this.ready = true;
      LS.set(K.social, this.me);
      hook('friends');
    } catch (e) { /* offline */ }
  },
  async loadActivity() {
    if (!this.on()) return;
    try { this.activity = (await api('/api/social/activity')).friends || []; this.activityAt = now(); this.remember(this.activity); hook('activity'); } catch (e) { /* offline */ }
  },
  state(username) {
    if (username === U.username) return 'self';
    const has = k => (this.me[k] || []).some(x => x.username === username);
    return has('friends') ? 'friend' : has('incoming') ? 'incoming' : has('outgoing') ? 'outgoing' : has('blocked') ? 'blocked' : 'none';
  },
  friends() { return (this.me.friends || []).slice().sort((a, b) => a.display_name.localeCompare(b.display_name)); },
  async act(action, username) {
    const r = await api('/api/social/friends/' + action, { username });
    await this.refresh();
    if (action === 'block' || action === 'remove') Chat.refresh();
    return r.state;
  },
  async search(q) { const d = await api('/api/social/search?q=' + encodeURIComponent(q)); this.remember(d.users); return d.users || []; },
  async profile(username) { const p = await api('/api/social/users/' + encodeURIComponent(username)); this.remember([p]); return p; },
  async setting(k, v) { this.me.settings = await api('/api/social/settings', { [k]: v }); hook('friends'); },
  nudge(sv) { if (this.sv !== sv) { const first = this.sv == null; this.sv = sv; if (!first) this.tick(); } },
  start() {
    if (this.running) return;
    this.running = true;
    const cached = U.token ? LS.get(K.social, null) : null;
    if (cached) { this.me = cached; ['friends', 'incoming', 'outgoing', 'blocked'].forEach(k => this.remember(cached[k])); }
    E2EE.init().then(() => this.tick());
  },
  stop() { this.running = false; clearTimeout(this.timer); this.pulse = null; },
  async tick() {
    clearTimeout(this.timer);
    if (!this.running) return;
    if (!this.on()) { this.timer = setTimeout(() => this.tick(), 60000); return; }
    try {
      const p = await api('/api/social/pulse');
      const was = this.pulse || {};
      this.pulse = p;
      if (p.f !== was.f) { this.refresh(); if (this.activityOpen) this.loadActivity(); if (was.f != null && E2EE.state !== 'off') E2EE.init(); }
      if (p.c !== was.c && feat('chat')) Chat.refresh();
      if (p.p !== was.p && feat('collab')) Collab.refresh();
      if (p.l !== was.l && p.links) E2EE.checkLinks();
      if (this.activityOpen && now() - this.activityAt > 20000) this.loadActivity();
      hook('pulse', p);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { this.pulse = null; hook('pulse', null); }
    }
    this.timer = setTimeout(() => this.tick(), document.hidden ? 60000 : Chat.open ? 4000 : this.activityOpen ? 10000 : 20000);
  },
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && Social.running) setTimeout(() => Social.tick(), 300); });

// What a message attachment points to, resolved against this library.
function attachment(a) {
  if (!a) return null;
  if (a.k === 'track') { const t = L.byRel.get(a.rel), at = Math.max(0, Math.min(86400, +a.at || 0)); return t ? { k: 'track', t, id: t.id, title: t.title, sub: t.artist, at } : { k: 'missing', title: a.title, sub: a.sub || 'Song' }; }
  if (a.k === 'album') { const al = L.albumByKey.get(a.key); return al ? { k: 'album', al, id: al.id, title: al.title, sub: 'Album • ' + AX.albumArtist(al) } : { k: 'missing', title: a.title, sub: 'Album' }; }
  if (a.k === 'artist') { const ar = L.artistByKey.get(a.key); return ar ? { k: 'artist', ar, id: ar.id, title: ar.name, sub: 'Artist' } : { k: 'missing', title: a.title, sub: 'Artist' }; }
  if (a.k === 'cpl') { const p = Collab.get(a.id); return p ? { k: 'cpl', p, id: p.id, title: p.name, sub: 'Collaborative playlist' } : { k: 'missing', title: a.title, sub: 'Playlist' }; }
  return null;
}
const attachTrack = t => ({ k: 'track', rel: t.rel, title: t.title, sub: t.artist });
const attachAlbum = al => ({ k: 'album', key: al.key, title: al.title });
const attachArtist = ar => ({ k: 'artist', key: ar.key, title: ar.name });

function personAvatar(card, cls = '') {
  const c = card || {}, init = esc(String(c.display_name || c.username || '?').trim().charAt(0).toUpperCase() || '?');
  const safe = /^(https?:|\/)/i.test(c.avatar || '');
  return `<span class="avatar ${cls}" data-i="${init}">${c.avatar && safe ? `<img src="${esc(c.avatar)}" alt="" loading="lazy">` : init}</span>`;
}
const agoText = ms => { const a = ago(ms); return a === 'now' ? 'Just now' : /\d (min|hr|d)$/.test(a) ? a + ' ago' : a; };
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' hr';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function previewText(c) {
  const m = c.preview;
  if (c.secret && c.st && c.st.invite) return 'Started a secret chat with you';
  if (!m) return c.secret ? 'Secret chat' : c.kind === 'dm' ? 'Say hello' : 'New group';
  const who = m.mine ? 'You: ' : c.kind === 'group' ? Chat.card(c, m.from).display_name.split(' ')[0] + ': ' : '';
  if (m.deleted) return who + 'Unsent a message';
  if (m.err === 'locked') return 'Encrypted message';
  if (m.err) return "Can't decrypt this message";
  if (m.body.re) return who + (m.body.re.e ? 'Reacted ' + m.body.re.e : 'Removed a reaction');
  const f = m.body.f;
  if (f && !m.body.t) return who + (f.kind === 'voice' ? 'Sent a voice message' : f.kind === 'video' ? 'Sent a video' : 'Sent a photo');
  const a = m.body.a;
  if (a && !m.body.t) return who + 'Sent ' + (a.k === 'track' ? (a.at ? 'a moment' : 'a song') : a.k === 'album' ? 'an album' : a.k === 'artist' ? 'an artist' : 'a playlist');
  return who + m.body.t;
}

// Signing out ends this device's secret chats: its device keys are deleted, so nobody signing in here later can open them.
if (AX.SIGNOUT) AX.SIGNOUT.push(user => { if (user) Device.forget(user); Chat.keys.clear(); });
// Building blocks for other modules that seal things for people, like the party chat key (web/app/party.js).
const Sealer = {
  ready: () => E2EE.state === 'ready',
  newKey: () => rand(32),
  async wrap(user, keys, raw, ctx) {
    const pin = await E2EE.pin(user, keys);
    const eph = await subtle().generateKey(ECDH, false, ['deriveBits']);
    const w = Object.assign({ e: b64u(await subtle().exportKey('raw', eph.publicKey)), by: U.username },
      await seal(await ecdh(eph.privateKey, pin.enc, ctx, 'axdio-party-v1'), raw, `axdio-party-v1|${ctx}|${user}`));
    w.sig = await E2EE.sign(canon({ t: 'pkey', ctx, to: user, e: w.e, iv: w.iv, ct: w.ct }));
    return w;
  },
  async unwrap(w, ctx) {
    if (!E2EE.me) throw new Error('locked');
    if (await E2EE.check(w.by, w.sig, canon({ t: 'pkey', ctx, to: U.username, e: w.e, iv: w.iv, ct: w.ct })) !== 'ok') throw new Error('unverified');
    return unseal(await ecdh(E2EE.me.enc.privateKey, w.e, ctx, 'axdio-party-v1'), w, `axdio-party-v1|${ctx}|${U.username}`);
  },
  async encrypt(raw, text, aad) { return seal(await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']), text, aad); },
  async decrypt(raw, box, aad) { return td.decode(await unseal(await subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']), box, aad)); },
};
Object.assign(AX, { Sealer, Device, Social, Chat, E2EE, REACTIONS, attachment, attachTrack, attachAlbum, attachArtist, personAvatar, ago, agoText, previewText, rkDecode });
})();
