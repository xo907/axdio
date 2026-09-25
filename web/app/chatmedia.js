/* Axdio — photos, videos and voice messages in private chats, plus disappearing messages (loaded after social.js).
   Every attachment is encrypted on this device with a fresh AES-256-GCM key, in 512 KiB chunks, before it's uploaded.
   The key travels inside the end-to-end encrypted message, so the server stores only numbered ciphertext chunks it
   can't read. Photos are redrawn before sending, which drops their location and camera details. Received files are
   decrypted into memory for viewing and never written to disk unless the listener saves one. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || !AX.Chat || AX.ChatMedia) return;
const { UI, U, SITE, Chat, esc, ic, api } = AX;

/* ---- Helpers ---- */
const te = new TextEncoder();
const b64u = b => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = str => { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4)); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toast = m => UI.toast && UI.toast(m);
const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const aad = (fid, i, n) => te.encode(`axdio-file-v1|${fid}|${i}|${n}`);
const ivFor = (nb, i) => { const iv = new Uint8Array(12); iv.set(nb, 0); new DataView(iv.buffer).setUint32(8, i); return iv; };
// Only types that are safe to hand to <img>, <video> and <audio>. Anything else (HTML, SVG…) is treated as plain bytes.
const SAFE_MIME = /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(webm|ogg|mp4|mpeg|aac|wav)(;\s*codecs=[\w.,"' -]+)?)$/i;
const safeMime = m => SAFE_MIME.test(String(m || '')) ? String(m) : 'application/octet-stream';
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const lim = () => SITE.chat_media || null;
const allowed = kind => { const l = lim(); return !!(l && l[kind]); };

async function authFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers, U.token ? { 'X-Auth-Token': U.token } : {});
  const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts, { headers }));
  if (!r.ok) {
    let d = null; try { d = await r.json(); } catch (e) { /* not JSON */ }
    const err = new Error((d && d.error) || `Request failed (${r.status})`); err.status = r.status; throw err;
  }
  return r;
}

/* ---- Encrypt and upload, chunk by chunk ---- */
async function upload(cid, blob, kind, onProgress, signal) {
  const { id: fid, chunk, chunks } = await api(`/api/chat/${cid}/files`, { kind, size: blob.size });
  const raw = rand(32), nb = rand(8);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < chunks) {
      const i = next++;
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const plain = await blob.slice(i * chunk, Math.min(blob.size, (i + 1) * chunk)).arrayBuffer();
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(nb, i), additionalData: aad(fid, i, chunks) }, key, plain);
      for (let attempt = 0; ; attempt++) {
        try { await authFetch(`/api/chat/${cid}/files/${fid}/${i}`, { method: 'PUT', body: ct, headers: { 'Content-Type': 'application/octet-stream' }, signal }); break; }
        catch (e) {
          if (e.name === 'AbortError' || attempt >= 3 || (e.status && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
          await sleep(700 * (attempt + 1));
        }
      }
      done++;
      if (onProgress) onProgress(done / chunks);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks) }, worker));
  await api(`/api/chat/${cid}/files/${fid}/done`, {});
  return { id: fid, k: b64u(raw), nb: b64u(nb), n: chunks, c: chunk, size: blob.size };
}

/* ---- Download and decrypt, kept in memory ---- */
const files = new Map();      // file id -> { p: Promise<object URL>, bytes, t }
const CACHE_BYTES = 256 * 1048576;
function fetchFile(cid, f, onProgress) {
  const hit = files.get(f.id);
  if (hit) { hit.t = Date.now(); return hit.p; }
  const p = (async () => {
    const key = await crypto.subtle.importKey('raw', unb64u(f.k), 'AES-GCM', false, ['decrypt']);
    const nb = unb64u(f.nb), n = f.n | 0, parts = new Array(n);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < n) {
        const i = next++;
        const r = await authFetch(`/api/chat/${cid}/files/${f.id}/${i}`, { cache: 'default' });
        parts[i] = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(nb, i), additionalData: aad(f.id, i, n) }, key, await r.arrayBuffer()));
        done++;
        if (onProgress) onProgress(done / n);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, n) }, worker));
    return URL.createObjectURL(new Blob(parts, { type: safeMime(f.mime) }));
  })();
  files.set(f.id, { p, bytes: f.size || 0, t: Date.now() });
  p.catch(() => files.delete(f.id));
  p.then(evict);
  return p;
}
function evict() {
  let total = 0;
  files.forEach(e => { total += e.bytes; });
  if (total <= CACHE_BYTES) return;
  [...files.entries()].sort((a, b) => a[1].t - b[1].t).forEach(([id, e]) => {
    if (total <= CACHE_BYTES || live.has(id)) return;
    e.p.then(url => URL.revokeObjectURL(url)).catch(() => {});
    files.delete(id); total -= e.bytes;
  });
}

/* ---- Getting a file ready to send ---- */
function loadImage(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("That photo can't be opened here.")); im.src = src; }); }
function canvasBlob(cv, type, q) { return new Promise(res => cv.toBlob(res, type, q)); }
function draw(src, w, h) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(src, 0, 0, w, h); return cv; }
function thumbOf(src, sw, sh, width, q) {
  const w = Math.max(1, Math.min(width, sw)), h = Math.max(1, Math.round(sh * w / sw));
  return draw(src, w, h).toDataURL('image/jpeg', q);
}
async function prepImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImage(url), w = im.naturalWidth, h = im.naturalHeight;
    if (!w || !h) throw new Error("That photo can't be opened here.");
    const thumb = thumbOf(im, w, h, 40, .5);
    if (file.type === 'image/gif') return { blob: file, mime: 'image/gif', w, h, thumb };
    // Redrawing keeps the pixels and nothing else: no location, camera or edit history.
    const s = Math.min(1, 2560 / Math.max(w, h)), W = Math.round(w * s), H = Math.round(h * s);
    const png = file.type === 'image/png' && file.size < 3 * 1048576;
    const blob = await canvasBlob(draw(im, W, H), png ? 'image/png' : 'image/jpeg', .86);
    if (!blob) throw new Error("That photo can't be prepared.");
    return { blob, mime: png ? 'image/png' : 'image/jpeg', w: W, h: H, thumb };
  } finally { URL.revokeObjectURL(url); }
}
function once(el, ev, ms) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); el.addEventListener('error', () => { clearTimeout(t); rej(new Error('error')); }, { once: true }); }); }
async function prepVideo(file) {
  const url = URL.createObjectURL(file), v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  let w = 16, h = 9, dur = 0, thumb = '';
  try {
    await once(v, 'loadedmetadata', 8000);
    w = v.videoWidth || 16; h = v.videoHeight || 9; dur = isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.min(1, dur / 3 || 0);
    await once(v, 'seeked', 5000);
    if (v.videoWidth) { thumb = thumbOf(v, w, h, 360, .6); if (thumb.length > 14000) thumb = thumbOf(v, w, h, 220, .5); }
  } catch (e) { /* a format this browser can't preview: send it without a poster */ }
  finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
  return { blob: file, mime: SAFE_MIME.test(file.type) ? file.type : 'video/mp4', w, h, dur, thumb };
}

/* ---- Sending: shows a bubble with progress while it uploads ---- */
// Nothing is uploaded unless the message carrying its key can be sent too.
async function canSend(cid) {
  const c = Chat.byId.get(cid);
  if (!c) { toast('That conversation is gone'); return false; }
  if (AX.E2EE && AX.E2EE.state !== 'ready') { toast('Unlock private messages on this device first'); return false; }
  const problem = await Chat.sendProblem(c).catch(() => '');
  if (problem) { toast(problem === 'locked' ? 'Unlock private messages on this device first' : problem); return false; }
  return true;
}
const pending = new Map();    // conversation id -> [{ lid, kind, thumb, w, h, p, ctl, err }]
let lidSeq = 0;
function kindOf(file) { return /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'voice' : ''; }
async function send(cid, file, opts = {}) {
  const kind = opts.kind || kindOf(file);
  if (!kind) { toast("Only photos, videos and voice messages can be sent"); return; }
  if (!allowed(kind)) { toast({ image: 'Photos', video: 'Videos', voice: 'Voice messages' }[kind] + " can't be sent on this server"); return; }
  const l = lim();
  if (file.size > l.max && kind !== 'image') { toast(`That's too big: attachments can be up to ${fmtSize(l.max)} here`); return; }
  if (!(await canSend(cid))) return;
  const item = { lid: 'u' + (++lidSeq), kind, thumb: '', w: 4, h: 3, p: 0, ctl: new AbortController(), err: '' };
  const list = pending.get(cid) || []; list.push(item); pending.set(cid, list);
  const redraw = () => refresh(cid);
  try {
    const prep = kind === 'image' ? await prepImage(file) : kind === 'video' ? await prepVideo(file) : { blob: file, mime: opts.mime || file.type, dur: opts.dur, wave: opts.wave };
    if (prep.blob.size > l.max) throw new Error(`That's too big: attachments can be up to ${fmtSize(l.max)} here`);
    Object.assign(item, { thumb: prep.thumb || '', w: prep.w || 4, h: prep.h || 3 });
    redraw();
    const up = await upload(cid, prep.blob, kind, p => { item.p = p; paintProgress(item); }, item.ctl.signal);
    const meta = Object.assign(up, { kind, mime: safeMime(prep.mime) });
    ['w', 'h', 'thumb', 'wave'].forEach(k => { if (prep[k]) meta[k] = prep[k]; });
    if (prep.dur) meta.dur = Math.round(prep.dur * 10) / 10;
    if (kind !== 'voice' && file.name) meta.name = String(file.name).slice(0, 120);
    await Chat.post(cid, { t: String(opts.caption || '').slice(0, 4000), f: meta }, 0, [up.id]);
    // What was sent is already here: keep it so the bubble shows at once, without downloading it back.
    files.set(up.id, { p: Promise.resolve(URL.createObjectURL(prep.blob)), bytes: prep.blob.size, t: Date.now() });
    drop(cid, item);
  } catch (e) {
    if (e.name === 'AbortError') { drop(cid, item); return; }
    item.err = e.message || "Couldn't send that"; redraw();
    toast(item.err);
  }
}
function drop(cid, item) { const list = (pending.get(cid) || []).filter(x => x !== item); if (list.length) pending.set(cid, list); else pending.delete(cid); refresh(cid); }
function refresh(cid) { if (UI.social) try { UI.social('thread', cid); } catch (e) { /* the view is gone */ } }
function paintProgress(item) { document.querySelectorAll(`[data-up="${item.lid}"] .axm-bar i`).forEach(i => { i.style.width = (item.p * 100).toFixed(1) + '%'; }); }
function pendingHtml(cid) {
  return (pending.get(cid) || []).map(it => {
    const box = it.kind === 'voice'
      ? `<div class="axm axm-voice up"><span class="axm-vplay">${ic('mic', 'sm')}</span><span class="axm-uptext">${it.err ? esc(it.err) : 'Sending voice message…'}</span></div>`
      : `<div class="axm axm-${it.kind === 'video' ? 'vid' : 'img'} up" style="${dims(it.w, it.h)}">${it.thumb ? `<img class="axm-thumb" src="${esc(it.thumb)}" alt="">` : ''}`
        + (it.err ? `<span class="axm-err">${esc(it.err)}</span>` : '<span class="axm-spin"></span>') + '</div>';
    return `<div class="msg mine axm-pend" data-up="${it.lid}"><div class="msg-col"><div class="msg-body">${box}<div class="axm-bar"><i style="width:${(it.p * 100).toFixed(1)}%"></i></div>`
      + `<button class="axm-cancel" data-cm-act="${it.err ? 'dismiss' : 'cancel'}" data-lid="${it.lid}" data-cid="${esc(cid)}">${it.err ? 'Dismiss' : 'Cancel'}</button></div></div></div>`;
  }).join('');
}

/* ---- Showing attachments in a thread ---- */
const meta = new Map();       // file id -> { cid, f }
const live = new Map();       // file id -> the element showing it (kept across re-renders, so playback isn't interrupted)
function dims(w, h, maxW = 280, maxH = 340) {
  w = +w || 4; h = +h || 3;
  const s = Math.min(maxW / w, maxH / h), W = Math.max(120, Math.round(w * s)), H = Math.max(80, Math.round(h * s));
  return `width:${W}px;height:${H}px`;
}
function clean(f) {
  if (!f || typeof f !== 'object' || !/^[0-9A-Za-z_-]{22}$/.test(f.id || '') || !f.k || !f.nb || !(f.n > 0)) return null;
  return { id: f.id, k: String(f.k), nb: String(f.nb), n: f.n | 0, size: +f.size || 0, kind: ['image', 'video', 'voice'].includes(f.kind) ? f.kind : 'file',
    mime: safeMime(f.mime), w: Math.max(1, +f.w || 4), h: Math.max(1, +f.h || 3), dur: Math.max(0, +f.dur || 0),
    thumb: THUMB_RE.test(f.thumb || '') ? f.thumb : '', wave: Array.isArray(f.wave) ? f.wave.slice(0, 64).map(v => Math.max(0, Math.min(31, v | 0))) : null,
    name: String(f.name || '').slice(0, 120) };
}
function html(cid, m) {
  const f = clean(m.body && m.body.f);
  if (!f) return m.body && m.body.f ? `<div class="bub gone">${ic('lock', 'sm')} An attachment this app can't show</div>` : '';
  meta.set(f.id, { cid, f });
  if (f.kind === 'voice') {
    const wave = f.wave && f.wave.length ? f.wave : Array.from({ length: 40 }, (_, i) => 8 + ((i * 7) % 13));
    return `<div class="axm axm-voice" data-cm="${f.id}"><button class="axm-vplay" data-cm-act="voice" aria-label="Play voice message">${ic('play', 'sm')}</button>`
      + `<span class="axm-wave">${wave.map(v => `<i style="height:${Math.round(12 + v * 2.6)}%"></i>`).join('')}</span><span class="axm-dur">${fmtDur(f.dur)}</span></div>`;
  }
  const video = f.kind === 'video';
  return `<div class="axm axm-${video ? 'vid' : 'img'}" data-cm="${f.id}" data-cm-act="${video ? 'play' : 'open'}" style="${dims(f.w, f.h)}" role="button" aria-label="${video ? 'Play video' : 'Open photo'}">`
    + (f.thumb ? `<img class="axm-thumb" src="${esc(f.thumb)}" alt="">` : '')
    + (video ? `<span class="axm-play">${ic('play')}</span><span class="axm-dur">${f.dur ? fmtDur(f.dur) + ' · ' : ''}${fmtSize(f.size)}</span>` : '<span class="axm-spin"></span>')
    + '<span class="axm-ring" hidden></span></div>';
}
const seen = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => entries.forEach(e => {
  if (!e.isIntersecting) return;
  seen.unobserve(e.target);
  showImage(e.target);
}), { rootMargin: '300px' }) : null;
function showImage(el) {
  const m = meta.get(el.dataset.axm); if (!m) return;
  fetchFile(m.cid, m.f).then(url => {
    if (el.querySelector('.axm-full')) return;
    const im = new Image(); im.className = 'axm-full'; im.alt = m.f.name || 'Photo'; im.src = url;
    im.onload = () => { el.classList.add('ready'); const sp = el.querySelector('.axm-spin'); if (sp) sp.remove(); };
    el.appendChild(im);
    live.set(m.f.id, el);
  }).catch(() => { const sp = el.querySelector('.axm-spin'); if (sp) sp.outerHTML = `<span class="axm-err">Couldn't load this photo</span>`; });
}
// After a thread is drawn: put back elements that were already showing (a playing video keeps playing) and load photos as they come into view.
function hydrate(root) {
  if (!root) return;
  root.querySelectorAll('.axm[data-cm]').forEach(slot => {
    const id = slot.dataset.axm, el = live.get(id);
    if (el && el !== slot) { slot.replaceWith(el); return; }
    if (slot.classList.contains('axm-img')) { if (seen) seen.observe(slot); else showImage(slot); }
  });
}
function ring(el, p) { const r = el.querySelector('.axm-ring'); if (!r) return; r.hidden = false; r.style.setProperty('--p', Math.round(p * 100)); }
async function playVideo(el) {
  const m = meta.get(el.dataset.axm); if (!m || el.querySelector('video')) return;
  el.classList.add('loading'); ring(el, 0);
  try {
    const url = await fetchFile(m.cid, m.f, p => ring(el, p));
    const v = document.createElement('video');
    Object.assign(v, { src: url, controls: true, playsInline: true, autoplay: true, className: 'axm-full' });
    el.removeAttribute('data-cm-act'); el.classList.remove('loading'); el.classList.add('ready');
    el.querySelectorAll('.axm-play, .axm-dur, .axm-ring').forEach(x => x.remove());
    el.appendChild(v);
    live.set(m.f.id, el);
    duck(v);
  } catch (e) { el.classList.remove('loading'); toast("Couldn't load this video"); }
}
// Voice messages and videos pause the music, and it carries on when they finish.
function duck(media) {
  let resume = false;
  media.addEventListener('play', () => { if (AX.isPlaying && AX.isPlaying()) { resume = true; AX.pause(); } });
  const back = () => { if (resume) { resume = false; AX.play(); } };
  media.addEventListener('ended', back);
  media.addEventListener('pause', () => { if (media.ended) return; setTimeout(() => { if (media.paused && !media.ended) back(); }, 400); });
}
async function playVoice(el) {
  const m = meta.get(el.dataset.axm); if (!m) return;
  let a = el._audio;
  if (!a) {
    el.classList.add('loading');
    try {
      const url = await fetchFile(m.cid, m.f);
      a = el._audio = new Audio(url);
      a.addEventListener('timeupdate', () => el.style.setProperty('--vp', (a.currentTime / (a.duration && isFinite(a.duration) ? a.duration : m.f.dur || 1) * 100).toFixed(1) + '%'));
      a.addEventListener('play', () => { el.classList.add('playing'); el.querySelector('.axm-vplay').innerHTML = ic('pause', 'sm'); });
      a.addEventListener('pause', () => { el.classList.remove('playing'); el.querySelector('.axm-vplay').innerHTML = ic('play', 'sm'); });
      a.addEventListener('ended', () => el.style.setProperty('--vp', '0%'));
      duck(a);
      live.set(m.f.id, el);
    } catch (e) { toast("Couldn't load this voice message"); return; }
    finally { el.classList.remove('loading'); }
  }
  if (a.paused) { document.querySelectorAll('.axm-voice.playing').forEach(o => { if (o !== el && o._audio) o._audio.pause(); }); a.play().catch(() => {}); } else a.pause();
}
function seekVoice(el, e) {
  const a = el._audio, w = el.querySelector('.axm-wave'); if (!a || !w || !isFinite(a.duration)) return;
  const r = w.getBoundingClientRect(); a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * a.duration;
}

/* ---- Full-screen viewer ---- */
async function openViewer(el) {
  const m = meta.get(el.dataset.axm); if (!m) return;
  const url = await fetchFile(m.cid, m.f).catch(() => null);
  if (!url) { toast("Couldn't load this photo"); return; }
  const lb = document.createElement('div');
  lb.className = 'axm-lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-label', 'Photo');
  lb.innerHTML = `<img src="${url}" alt=""><div class="axm-lb-bar"><button data-lb="save" aria-label="Save">${ic('dl')}</button><button data-lb="close" aria-label="Close">${ic('close')}</button></div>`;
  const close = () => { lb.classList.remove('on'); setTimeout(() => lb.remove(), 200); document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') close(); };
  lb.addEventListener('click', e => {
    const b = e.target.closest('[data-lb]');
    if (b && b.dataset.lb === 'save') { const a = document.createElement('a'); a.href = url; a.download = m.f.name || `axdio-${m.f.id.slice(0, 8)}.${(m.f.mime.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`; a.click(); return; }
    if (!e.target.closest('img')) close();
  });
  document.addEventListener('keydown', key);
  document.body.appendChild(lb);
  requestAnimationFrame(() => lb.classList.add('on'));
}

/* ---- Voice recorder ---- */
const Rec = {
  state: '', cid: '', mr: null, parts: [], t0: 0, wave: [], stream: null, ctx: null, an: null, tick: 0, form: null, resume: false, mime: '',
  supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
  async start(cid, form) {
    if (this.state) return;
    if (!this.supported()) { toast("This browser can't record voice messages"); return; }
    if (!(await canSend(cid))) return;
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Allow the microphone to record a voice message' : "Couldn't start the microphone"); return; }
    this.mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    this.mr = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 48000 } : undefined);
    this.parts = []; this.wave = []; this.peak = .04; this.cid = cid; this.form = form; this.state = 'rec'; this.t0 = Date.now();
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.parts.push(e.data); };
    this.mr.start(250);
    if (AX.isPlaying && AX.isPlaying()) { this.resume = true; AX.pause(); }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC(); this.an = this.ctx.createAnalyser(); this.an.fftSize = 1024;
      this.ctx.createMediaStreamSource(this.stream).connect(this.an);
    } catch (e) { this.an = null; }
    this.bar(true);
    const buf = new Float32Array(1024);
    this.tick = setInterval(() => {
      const secs = (Date.now() - this.t0) / 1000;
      let level = .15;
      if (this.an) { this.an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; level = Math.min(1, Math.sqrt(s / buf.length) * 5); }
      this.wave.push(level);
      this.peak = Math.max(this.peak * .995, level, .04);
      const bar = this.form && this.form.querySelector('.axm-rec');
      if (bar) {
        bar.querySelector('.axm-rec-t').textContent = fmtDur(secs);
        const w = bar.querySelector('.axm-rec-wave'); w.insertAdjacentHTML('beforeend', `<i style="height:${Math.round(10 + Math.min(1, level / this.peak) * 90)}%"></i>`); while (w.children.length > 60) w.firstChild.remove();
      }
      if (secs >= 300) this.stop(true);
    }, 100);
  },
  stop(sendIt) {
    if (this.state !== 'rec') return;
    this.state = 'stopping';
    clearInterval(this.tick);
    const dur = (Date.now() - this.t0) / 1000, cid = this.cid, mr = this.mr;
    mr.onstop = () => {
      const blob = new Blob(this.parts, { type: (mr.mimeType || this.mime || 'audio/webm').split(';')[0] });
      this.cleanup();
      if (!sendIt) return;
      if (dur < .8) { toast('Hold on a little longer to record a voice message'); return; }
      const n = 40, top = Math.max(.04, ...this.wave), w = this.wave.map(v => v / top), wave = Array.from({ length: n }, (_, i) => { const a = Math.floor(i * w.length / n), b = Math.max(a + 1, Math.floor((i + 1) * w.length / n)); let m = 0; for (let k = a; k < b; k++) m = Math.max(m, w[k] || 0); return Math.round(m * 31); });
      send(cid, blob, { kind: 'voice', mime: blob.type, dur, wave });
    };
    try { mr.stop(); } catch (e) { this.cleanup(); }
  },
  cleanup() {
    (this.stream ? this.stream.getTracks() : []).forEach(t => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = this.ctx = this.an = this.mr = null; this.state = '';
    this.bar(false);
    if (this.resume) { this.resume = false; AX.play(); }
  },
  bar(on) {
    const f = this.form; if (!f) return;
    f.classList.toggle('axm-recording', on);
    const old = f.querySelector('.axm-rec'); if (old) old.remove();
    if (on) f.insertAdjacentHTML('beforeend', `<div class="axm-rec"><button type="button" class="axm-rec-x" data-cm-act="rec-cancel" aria-label="Delete recording">${ic('trash', 'sm')}</button><span class="axm-rec-dot"></span><span class="axm-rec-t">0:00</span><span class="axm-rec-wave"></span><button type="button" class="axm-rec-send" data-cm-act="rec-send" aria-label="Send voice message">${ic('send', 'sm')}</button></div>`);
  },
};

/* ---- Composer: attach, paste, drop and record ---- */
// `cls`: the app's own button class, so these match the buttons beside them.
function buttons(cls = '') {
  const l = lim(); if (!l) return '';
  return (l.image || l.video ? `<button type="button" class="axm-btn ${cls}" data-cm-act="pick" aria-label="Send a photo or video" title="Photo or video">${ic('image')}</button>` : '')
    + (l.voice && Rec.supported() ? `<button type="button" class="axm-btn ${cls}" data-cm-act="rec" aria-label="Record a voice message" title="Voice message">${ic('mic')}</button>` : '');
}
function mount(form, cid, dropZone) {
  if (!form || form.dataset.cmMounted === cid) return;
  form.dataset.cmMounted = cid; form.dataset.cid = cid;
  const input = form.querySelector('textarea');
  if (input) input.addEventListener('paste', e => {
    const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => kindOf(f) === 'image' || kindOf(f) === 'video');
    if (!fs.length || !lim()) return;
    e.preventDefault();
    fs.forEach(f => send(cid, f, { caption: takeCaption(form) }));
  });
  const zone = dropZone || form.parentElement;
  if (zone) {
    zone.addEventListener('dragover', e => { if (lim() && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); zone.classList.add('axm-drop'); } });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('axm-drop'); });
    zone.addEventListener('drop', e => {
      zone.classList.remove('axm-drop');
      const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (!fs.length || !lim()) return;
      e.preventDefault();
      fs.slice(0, 10).forEach(f => send(cid, f, { caption: takeCaption(form) }));
    });
  }
}
function takeCaption(form) {
  const t = form && form.querySelector('textarea'); if (!t || !t.value.trim()) return '';
  const v = t.value; t.value = ''; t.dispatchEvent(new Event('input')); return v;
}
function pick(cid, form) {
  const l = lim(); if (!l) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.accept = [l.image ? 'image/*' : '', l.video ? 'video/*' : ''].filter(Boolean).join(',');
  inp.onchange = () => { const cap = takeCaption(form); [...inp.files].slice(0, 10).forEach((f, i) => send(cid, f, { caption: i ? '' : cap })); };
  inp.click();
}

/* ---- Disappearing messages ---- */
const TTLS = [[0, 'Off'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week'], [2419200, '4 weeks']];
const ttlName = s => (TTLS.find(t => t[0] === s) || [0, 'Off'])[1];
async function setTtl(cid, ttl) {
  const c = await api(`/api/chat/${cid}/ttl`, { ttl });
  await Chat.merge(c);
  refresh(cid);
  if (UI.social) try { UI.social('chats'); } catch (e) { /* ignore */ }
}
function ttlDialog(cid) {
  const c = Chat.byId.get(cid); if (!c) return;
  const cur = c.ttl | 0;
  const w = document.createElement('div');
  w.className = 'axm-dlg-wrap';
  w.innerHTML = `<div class="axm-dlg" role="dialog" aria-label="Disappearing messages"><h3>${ic('timer')} Disappearing messages</h3><p>New messages in this chat disappear for everyone once they're this old, photos and videos included. Anyone in the chat can change this.</p>`
    + TTLS.map(([s, name]) => `<label class="axm-opt"><input type="radio" name="axm-ttl" value="${s}"${s === cur ? ' checked' : ''}><span>${name}</span></label>`).join('')
    + `<div class="axm-dlg-b"><button class="btn ghost sm" data-d="x">Cancel</button><button class="btn primary sm" data-d="ok">Save</button></div></div>`;
  const close = () => w.remove();
  w.addEventListener('click', async e => {
    const b = e.target.closest('[data-d]');
    if (e.target === w || (b && b.dataset.d === 'x')) { close(); return; }
    if (b && b.dataset.d === 'ok') {
      const v = +w.querySelector('input[name="axm-ttl"]:checked').value;
      close();
      if (v !== cur) setTtl(cid, v).then(() => toast(v ? `Messages now disappear after ${ttlName(v).replace(/^1 /, 'a ').replace(/^a hour/, 'an hour')}` : 'Disappearing messages are off')).catch(er => toast(er.message));
    }
  });
  document.body.appendChild(w);
}
function secretBanner(c) {
  if (!c || !c.secret || !c.st) return '';
  const other = c.st.peer, name = esc(Chat.card(c, other).display_name), dev = (c.devices || {})[other];
  if (c.st.invite) return `<div class="axm-secret invite">${ic('lock', 'sm')}<span>A secret chat works on one device on each side. Open it here and it will only ever be readable on this device.</span><button data-cm-act="secret-accept" data-cid="${esc(c.id)}">Open here</button></div>`;
  if (!c.st.here) return '';
  return `<div class="axm-secret">${ic('lock', 'sm')}<span>Secret chat · only on this device${dev ? ` and ${name}'s ${esc(dev.label || 'device')}` : `. ${name} hasn't opened it yet`}. Your other devices can't read it.</span></div>`;
}
function banner(c) {
  const sb = secretBanner(c);
  if (!c || !(c.ttl > 0)) return sb;
  const log = (c.ttl_log || [])[(c.ttl_log || []).length - 1], who = log ? (log.by === U.username ? 'you' : Chat.card(c, log.by).display_name) : '';
  return sb + `<div class="axm-ttl" data-cm-act="ttl" data-cid="${esc(c.id)}" role="button">${ic('timer', 'sm')}<span>Messages disappear after ${ttlName(c.ttl)}${who ? ` · set by ${esc(who)}` : ''}</span></div>`;
}
// Drop disappearing messages from open threads once their time is up.
setInterval(() => {
  const now = Date.now();
  (Chat.threads || new Map()).forEach((th, cid) => {
    const before = th.msgs.length;
    th.msgs = th.msgs.filter(m => !(m.expires && m.expires <= now));
    if (th.msgs.length !== before) refresh(cid);
  });
}, 10000);

/* ---- Listening party invites ---- */
async function partyInvite(cid) {
  const Party = AX.Party;
  if (!Party) return;
  if (!Party.v) await Party.create();
  if (!Party.v) return;
  const link = `${SITE.public_url || location.origin}/party/${Party.v.code}`;
  await Chat.send(cid, `🎧 Join my listening party: ${link}`).catch(e => toast(e.message));
  if (UI.openParty) UI.openParty();
}
function partyCode(a) {
  try { const u = new URL(a.href, location.href); if (u.origin !== location.origin && !(SITE.public_url && u.origin === new URL(SITE.public_url).origin)) return ''; const m = u.pathname.match(/^\/party\/([A-Za-z0-9]{4,8})$/); return m ? m[1] : ''; }
  catch (e) { return ''; }
}

/* ---- One set of click handlers for both apps ---- */
document.addEventListener('click', e => {
  const a = e.target.closest('a[href*="/party/"]');
  if (a && AX.Party && a.closest('.msg')) { const code = partyCode(a); if (code) { e.preventDefault(); AX.Party.join(code); return; } }
  const w = e.target.closest('.axm-voice .axm-wave');
  if (w) { seekVoice(w.closest('.axm-voice'), e); return; }
  const b = e.target.closest('[data-cm-act]'); if (!b) return;
  const act = b.dataset.cmAct, form = b.closest('form'), cid = b.dataset.cid || (form && form.dataset.cid) || '';
  if (act === 'pick') pick(cid, form);
  else if (act === 'rec') Rec.start(cid, form);
  else if (act === 'rec-send') Rec.stop(true);
  else if (act === 'rec-cancel') Rec.stop(false);
  else if (act === 'open') openViewer(b);
  else if (act === 'play') playVideo(b);
  else if (act === 'voice') playVoice(b.closest('.axm-voice'));
  else if (act === 'ttl') ttlDialog(cid);
  else if (act === 'blend') playBlend(b.dataset.u);
  else if (act === 'secret-accept') Chat.acceptSecret(cid).then(() => toast('Opened here. This secret chat now lives on this device')).catch(e => toast(e.message));
  else if (act === 'cancel' || act === 'dismiss') { const it = (pending.get(cid) || []).find(x => x.lid === b.dataset.lid); if (it) { it.ctl.abort(); drop(cid, it); } }
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);

/* ---- Blend: a friend's taste and yours in one mix (from GET /api/social/users/<name>) ---- */
const blends = new Map();
function blendHtml(pr) {
  const b = pr && pr.blend, L = AX.L;
  if (!b || !Array.isArray(b.rels)) return '';
  const tracks = b.rels.map(r => L.byRel.get(r)).filter(Boolean);
  if (!tracks.length) return '';
  const first = String(pr.display_name || pr.username).trim().split(/\s+/)[0];
  blends.set(pr.username, { name: `${first} + You`, ids: tracks.map(t => t.id) });
  const covers = [...new Set(tracks.map(t => AX.coverUrl(t.rel)))].slice(0, 4);
  while (covers.length && covers.length < 4) covers.push(covers[covers.length % Math.max(1, covers.length)]);
  const common = (b.common || []).slice(0, 3).map(esc);
  const sub = common.length ? `You both love ${common.length > 1 ? common.slice(0, -1).join(', ') + ' and ' + common[common.length - 1] : common[0]}` : 'Your music and theirs, mixed together';
  const m = Math.max(0, Math.min(100, b.match | 0));
  return `<div class="axm-blend" data-cm-act="blend" data-u="${esc(pr.username)}" role="button" aria-label="Play your Blend with ${esc(first)}">`
    + `<div class="axm-blend-art">${covers.map(c => `<img src="${esc(c)}" alt="" loading="lazy">`).join('')}</div>`
    + `<div class="axm-blend-meta"><small>Blend</small><b>${esc(first)} + You</b><span class="axm-blend-sub">${sub} · ${tracks.length} songs</span></div>`
    + `<div class="axm-match" style="--m:${m}"><b>${m}%</b><small>taste match</small></div>`
    + `<button class="axm-blend-play" data-cm-act="blend" data-u="${esc(pr.username)}" aria-label="Play">${ic('play')}</button></div>`;
}
function playBlend(u) {
  const b = blends.get(u); if (!b) return;
  AX.playCtx(AX.makeCtx('list', 'blend:' + u, b.name, b.ids), 0);
}

function preview(m) {
  const f = m && m.body && m.body.f;
  if (!f) return '';
  return f.kind === 'voice' ? 'Sent a voice message' : f.kind === 'video' ? 'Sent a video' : 'Sent a photo';
}

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.axm { position: relative; overflow: hidden; border-radius: 14px; background: rgba(127,127,127,.18); max-width: 100%; cursor: pointer; }
.axm-img, .axm-vid { display: block; }
.axm-thumb, .axm-full { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.axm-thumb { filter: blur(14px); transform: scale(1.15); }
.axm-full { z-index: 1; }
.axm-vid video.axm-full { object-fit: contain; background: #000; }
.axm-img.ready .axm-thumb { visibility: hidden; }
.axm-spin { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px; border: 2.5px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: axm-spin .8s linear infinite; z-index: 2; }
@keyframes axm-spin { to { transform: rotate(360deg); } }
.axm-play { position: absolute; left: 50%; top: 50%; width: 54px; height: 54px; margin: -27px; border-radius: 50%; background: rgba(0,0,0,.55); display: grid; place-items: center; color: #fff; z-index: 2; backdrop-filter: blur(6px); }
.axm-play .i { width: 26px; height: 26px; margin-left: 3px; }
.axm-vid .axm-dur { position: absolute; left: 8px; bottom: 8px; z-index: 2; font-size: 11.5px; font-weight: 700; color: #fff; background: rgba(0,0,0,.55); padding: 3px 7px; border-radius: 99px; }
.axm-ring { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px; border-radius: 50%; z-index: 3; background: conic-gradient(#fff calc(var(--p, 0) * 1%), rgba(255,255,255,.2) 0); -webkit-mask: radial-gradient(circle, transparent 25px, #000 26px); mask: radial-gradient(circle, transparent 25px, #000 26px); }
.axm-vid.loading .axm-play { opacity: .6; }
.axm-err { position: absolute; inset: auto 8px 8px; z-index: 2; font-size: 12px; font-weight: 600; color: #fff; background: rgba(160,20,40,.8); padding: 6px 8px; border-radius: 8px; }
.axm-bar { height: 3px; border-radius: 3px; background: rgba(127,127,127,.25); margin-top: 6px; overflow: hidden; }
.axm-bar i { display: block; height: 100%; background: var(--accent, #22c55e); transition: width .25s; }
.axm-cancel { display: block; margin: 4px 0 0 auto; font: inherit; font-size: 12px; font-weight: 600; color: inherit; opacity: .7; background: none; border: 0; cursor: pointer; padding: 2px 0; }
.axm-voice { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 8px; width: 250px; max-width: 100%; border-radius: 22px; cursor: default; --vp: 0%; }
.msg.mine .axm-voice { background: var(--accent, #22c55e); color: #000; }
.axm-vplay { flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%; border: 0; display: grid; place-items: center; background: rgba(255,255,255,.9); color: #000; cursor: pointer; }
.msg.mine .axm-vplay { background: rgba(0,0,0,.85); color: #fff; }
.axm-voice.loading .axm-vplay { opacity: .5; }
.axm-wave { flex: 1; height: 30px; display: flex; align-items: center; gap: 2px; cursor: pointer; -webkit-mask: linear-gradient(90deg, #000 var(--vp), rgba(0,0,0,.45) var(--vp)); mask: linear-gradient(90deg, #000 var(--vp), rgba(0,0,0,.45) var(--vp)); }
.axm-wave i { flex: 1; min-width: 2px; border-radius: 2px; background: currentColor; }
.axm-voice .axm-dur { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; opacity: .85; }
.axm-uptext { font-size: 13px; font-weight: 600; }
:where(.axm-btn) { flex-shrink: 0; width: 38px; height: 38px; border: 0; border-radius: 50%; background: none; color: inherit; display: grid; place-items: center; cursor: pointer; }
.axm-btn { flex-shrink: 0; }
form.axm-recording > :not(.axm-rec) { visibility: hidden; }
form.axm-recording { position: relative; }
.axm-rec { position: absolute; inset: 0; display: flex; align-items: center; gap: 10px; padding: 0 8px; }
.axm-rec button { width: 38px; height: 38px; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer; color: inherit; background: rgba(127,127,127,.18); flex-shrink: 0; }
.axm-rec .axm-rec-send { background: var(--accent, #22c55e); color: #000; }
.axm-rec-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: axm-blink 1s ease-in-out infinite; flex-shrink: 0; }
@keyframes axm-blink { 50% { opacity: .25; } }
.axm-rec-t { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 38px; }
.axm-rec-wave { flex: 1; height: 28px; display: flex; align-items: center; justify-content: flex-end; gap: 2px; overflow: hidden; }
.axm-rec-wave i { width: 3px; flex-shrink: 0; border-radius: 2px; background: currentColor; opacity: .8; }
.axm-drop { outline: 2px dashed var(--accent, #22c55e); outline-offset: -8px; }
.axm-lb { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.92); display: grid; place-items: center; opacity: 0; transition: opacity .2s; }
.axm-lb.on { opacity: 1; }
.axm-lb img { max-width: 96vw; max-height: 88vh; object-fit: contain; border-radius: 6px; }
.axm-lb-bar { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 12px); right: 12px; display: flex; gap: 8px; }
.axm-lb-bar button { width: 44px; height: 44px; border-radius: 50%; border: 0; background: rgba(255,255,255,.14); color: #fff; display: grid; place-items: center; cursor: pointer; }
.axm-ttl { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12.5px; font-weight: 600; opacity: .8; padding: 6px 12px; cursor: pointer; }
.axm-ttl .i { width: 15px; height: 15px; }
.axm-dlg-wrap { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.6); display: grid; place-items: center; padding: 16px; }
.axm-dlg { width: min(380px, 100%); background: var(--elev-2, #282828); color: var(--text, #fff); border-radius: 14px; padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.axm-dlg h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 17px; }
.axm-dlg h3 .i { width: 20px; height: 20px; }
.axm-dlg p { margin: 0 0 12px; font-size: 13.5px; opacity: .75; line-height: 1.45; }
.axm-opt { display: flex; align-items: center; gap: 10px; padding: 10px 4px; font-size: 15px; font-weight: 600; cursor: pointer; border-top: 1px solid rgba(127,127,127,.18); }
.axm-opt input { accent-color: var(--accent, #22c55e); width: 18px; height: 18px; }
.axm-dlg-b { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.axm-blend { display: flex; align-items: center; gap: 16px; padding: 14px; margin: 4px 0 20px; border-radius: 12px; cursor: pointer; max-width: 720px;
  background: linear-gradient(120deg, color-mix(in srgb, var(--accent, #22c55e) 30%, transparent), rgba(127,127,127,.12) 60%); }
.axm-blend-art { width: 72px; height: 72px; flex-shrink: 0; display: grid; grid-template-columns: 1fr 1fr; border-radius: 8px; overflow: hidden; }
.axm-blend-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.axm-blend-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.axm-blend-meta small { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; opacity: .75; }
.axm-blend-meta b { font-size: 20px; font-weight: 800; letter-spacing: -.02em; }
.axm-blend-sub { font-size: 13px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.axm-match { width: 64px; height: 64px; flex-shrink: 0; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative;
  background: conic-gradient(var(--accent, #22c55e) calc(var(--m) * 1%), rgba(127,127,127,.25) 0); }
.axm-match::before { content: ''; position: absolute; inset: 5px; border-radius: 50%; background: var(--bg, #121212); }
.axm-match b, .axm-match small { position: relative; line-height: 1.05; }
.axm-match b { font-size: 16px; font-weight: 800; }
.axm-match small { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; opacity: .7; text-align: center; max-width: 44px; }
.axm-blend-play { width: 48px; height: 48px; flex-shrink: 0; border-radius: 50%; border: 0; background: var(--accent, #22c55e); color: #000; display: grid; place-items: center; cursor: pointer; }
.axm-blend-play .i { width: 24px; height: 24px; }
@media (max-width: 520px) { .axm-blend { gap: 12px; padding: 12px; } .axm-blend-art { width: 56px; height: 56px; } .axm-blend-meta b { font-size: 17px; } .axm-match { width: 54px; height: 54px; } .axm-blend-play { display: none; } }
.axm-secret { display: flex; align-items: center; gap: 10px; margin: 8px 12px 0; padding: 10px 14px; border-radius: 12px; font-size: 13px; font-weight: 600; line-height: 1.4; background: rgba(34,197,94,.12); color: #bbf7d0; }
.axm-secret .i { width: 18px; height: 18px; flex-shrink: 0; color: #4ade80; }
.axm-secret span { flex: 1; }
.axm-secret button { flex-shrink: 0; height: 34px; padding: 0 14px; border-radius: 99px; border: 0; background: #22c55e; color: #000; font: inherit; font-weight: 800; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .axm-spin, .axm-rec-dot { animation: none; } }
` }));

AX.ChatMedia = { allowed, send, html, hydrate, pendingHtml, buttons, mount, preview, banner, ttlDialog, setTtl, ttlName, partyInvite, blendHtml, Rec, clean };
})();
