/* ==========================================================================
   Axdio core — the engine shared by the mobile UI (web/mobile/mobile.js) and
   the desktop UI (web/desktop/desktop.js). Load this first; it exposes
   window.AX. A UI plugs in by filling AX.UI hooks (render, toast, dialogs…).

   1. Utilities & icons     5. User data
   2. Storage & settings    6. Offline downloads & effects
   3. Colours & covers      7. Player engine (two decks: gapless/crossfade)
   4. Library index         8. Lyrics, media session, Connect & boot
   ========================================================================== */
(() => {
'use strict';

/* Hooks a UI overrides. Defaults are no-ops so the engine never depends on a view. */
const UI = {
  track() {}, playState() {}, modes() {}, queue() {}, like() {}, progress() {}, sleep() {}, volume() {},
  lyrics() {}, lyricLine() {}, remote() {}, online() {},
  dirty() {}, refresh() {},
  toast() {}, confirm: async () => true, pickPlaylist() {},
};

/* ======================================================================
   1. Utilities & icons
   ====================================================================== */
const byId = id => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = s => { s = isFinite(s) && s > 0 ? s : 0; const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${x < 10 ? '0' : ''}${x}`; };
const nf = n => Number(n).toLocaleString();
const count = (n, one, many = one + 's') => `${nf(n)} ${n === 1 ? one : many}`;
const ic = (name, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const EQB = '<span class="eqb" aria-hidden="true"><i></i><i></i><i></i></span>';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uniq = arr => Array.from(new Set(arr));
const now = () => Date.now();
const setUse = (svg, name) => { const u = svg && svg.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); };
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
let userActed = false;
document.addEventListener('pointerdown', () => { userActed = true; }, { passive: true, capture: true });
const haptic = (ms = 8) => {
  const active = navigator.userActivation ? navigator.userActivation.hasBeenActive : userActed;
  if (active && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* unsupported */ } }
};
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {
  let a = typeof seed === 'number' ? seed : hashStr(String(seed));
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(arr, rand = Math.random) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
const pick = (arr, rand = Math.random) => arr[Math.floor(rand() * arr.length)];
const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const weekKey = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toDateString(); };
const monthYear = ts => ts ? new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// One sprite for both UIs (24px Material-style glyphs). Injected once so every <use href="#i-…"> resolves.
const ICONS = {
  home: '<path d="M12 5.69l5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>',
  'home-f': '<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>',
  search: '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>',
  'search-f': '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" stroke="currentColor" stroke-width=".9"/>',
  lib: '<path d="M20 4v12H8V4h12m0-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7.5 13a2.5 2.5 0 0 0 2.5-2.5V7h3V5h-4v5.51c-.42-.32-.93-.51-1.5-.51a2.5 2.5 0 0 0 0 5zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/>',
  'lib-f': '<path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1 2.5-2.5c.57 0 1.08.19 1.5.51V5h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/>',
  play: '<path d="M7.5 5.2v13.6L18.8 12z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1"/><rect x="13.7" y="5" width="3.8" height="14" rx="1"/>',
  next: '<path d="M5.5 5.8v12.4l9.3-6.2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="16.8" y="5" width="2.2" height="14" rx="1.1"/>',
  prev: '<path d="M18.5 5.8v12.4L9.2 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="5" y="5" width="2.2" height="14" rx="1.1"/>',
  shuffle: '<path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  repeat: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
  heart: '<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>',
  'heart-f': '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>',
  add: '<path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>',
  'check-c': '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>',
  dl: '<path d="M12 4c4.41 0 8 3.59 8 8s-3.59 8-8 8-8-3.59-8-8 3.59-8 8-8m0-2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 10V8h-2v4H8l4 4 4-4h-3z"/>',
  'dl-f': '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14l-4-4h3V8h2v4h3l-4 4z"/>',
  'arrow-dn': '<path d="M11 5h2v9.2l3.3-3.3 1.4 1.4L12 18l-5.7-5.7 1.4-1.4 3.3 3.3z"/>',
  'more-v': '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>',
  'more-h': '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>',
  down: '<path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>',
  up: '<path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>',
  back: '<path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>',
  fwd: '<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>',
  close: '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
  queue: '<path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>',
  devices: '<path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z"/>',
  share: '<path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.11 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z"/>',
  mic: '<path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>',
  moon: '<path d="M12.34 2.02C6.59 1.82 2 6.42 2 12c0 5.52 4.48 10 10 10 3.71 0 6.93-2.02 8.66-5.02-7.51-.25-12.09-8.43-8.32-14.96z"/>',
  person: '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  'person-add': '<path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  album: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/>',
  'pl-add': '<path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z"/>',
  radio: '<path d="M7.76 16.24C6.67 15.16 6 13.66 6 12s.67-3.16 1.76-4.24l1.42 1.42C8.45 9.9 8 10.9 8 12c0 1.1.45 2.1 1.17 2.83l-1.41 1.41zm8.48 0C17.33 15.16 18 13.66 18 12s-.67-3.16-1.76-4.24l-1.42 1.42C15.55 9.9 16 10.9 16 12c0 1.1-.45 2.1-1.17 2.83l1.41 1.41zM12 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm8 2c0 2.21-.9 4.21-2.35 5.65l1.42 1.42C20.88 17.26 22 14.76 22 12s-1.12-5.26-2.93-7.07l-1.42 1.42A7.94 7.94 0 0 1 20 12zM6.35 6.35L4.93 4.93C3.12 6.74 2 9.24 2 12s1.12 5.26 2.93 7.07l1.42-1.42C4.9 16.21 4 14.21 4 12s.9-4.21 2.35-5.65z"/>',
  gear: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.485.485 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
  history: '<path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>',
  edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  trash: '<path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/>',
  drag: '<path d="M20 9H4v2h16V9zM4 15h16v-2H4v2z"/>',
  sort: '<path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z"/>',
  grid: '<path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z"/>',
  list: '<path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>',
  compact: '<path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"/>',
  check: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
  tune: '<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>',
  pin: '<path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/>',
  note: '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>',
  discord: '<path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.86-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .09-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1-.01-.12l.37-.3a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08.01l.37.3a.08.08 0 0 1 0 .12 12.3 12.3 0 0 1-1.88.9.08.08 0 0 0-.04.1c.36.7.78 1.36 1.23 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .04-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z"/>',
  chat: '<path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.6 1.3 4.9 3.4 6.5L4.6 22l4.3-2.2c1 .3 2 .4 3.1.4 5.5 0 10-3.9 10-8.6S17.5 3 12 3zm0 15.2c-1 0-2-.1-2.9-.4l-.6-.2-2 1 .4-1.8-.6-.4C4.6 15.1 3.9 13.5 3.9 11.7 3.9 7.9 7.5 5 12 5s8.1 2.9 8.1 6.7-3.6 6.5-8.1 6.5z"/>',
  'chat-f': '<path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.6 1.3 4.9 3.4 6.5L4.6 22l4.3-2.2c1 .3 2 .4 3.1.4 5.5 0 10-3.9 10-8.6S17.5 3 12 3z"/>',
  people: '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>',
  send: '<path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.99.99 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/>',
  lock: '<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm3 11c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>',
  key: '<path d="M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>',
  shield: '<path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>',
  smile: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>',
  reply: '<path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/>',
  block: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z"/>',
  group: '<path d="M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58A2.01 2.01 0 0 0 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm4 3.43c0-.81-.48-1.53-1.22-1.85A6.95 6.95 0 0 0 20 14c-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/>',
  plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
  'minus-c': '<path d="M7 11v2h10v-2H7zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>',
  volume: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>',
  'vol-1': '<path d="M7 9v6h4l5 5V4l-5 5H7z"/>',
  'vol-2': '<path d="M18.5 12A4.5 4.5 0 0 0 16 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>',
  'vol-0': '<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>',
  'cloud-off': '<path d="M19.35 10.04A7.49 7.49 0 0 0 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46A5.497 5.497 0 0 1 17.5 11v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 17.16 24 15.68 24 14c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2L21 20.73 4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73z"/>',
  phone: '<path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/>',
  pc: '<path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>',
  new: '<path d="M23 12l-2.44-2.78.34-3.68-3.61-.82-1.89-3.18L12 3 8.6 1.54 6.71 4.72l-3.61.81.34 3.68L1 12l2.44 2.78-.34 3.69 3.61.82 1.89 3.18L12 21l3.4 1.46 1.89-3.18 3.61-.82-.34-3.68L23 12zm-10 5h-2v-2h2v2zm0-4h-2V7h2v6z"/>',
  spark: '<path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/>',
  full: '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>',
  'full-exit': '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>',
  pip: '<path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>',
  npv: '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16h-6V5h6v14zM13 5v14H3V5h10zm-8.5 11.5h7l-2.25-3-1.75 2.26-1.25-1.51z"/>',
  expand: '<path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/>',
  keyboard: '<path d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/>',
  external: '<path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>',
  copy: '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
  logout: '<path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>',
  collapse: '<path d="M3 5v14h2V5H3zm10.59 1.41L12.17 5 5.17 12l7 7 1.42-1.41L9 13h12v-2H9l4.59-4.59z"/>',
  blank: '',
};
(function injectIcons() {
  if (byId('ax-icons')) return;
  const svg = `<svg id="ax-icons" width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('')}</svg>`;
  (document.body || document.documentElement).insertAdjacentHTML('afterbegin', svg);
})();

/* ======================================================================
   2. Storage & settings
   ====================================================================== */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota or private mode */ } },
  raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
// Keys shared with the old desktop player keep their original names.
const K = {
  settings: 'axdio_m_settings', local: 'axdio_m_local', userCache: 'axdio_m_user', playback: 'axdio_m_playback',
  recents: 'axdio_m_recents', searches: 'axdio_m_searches', dlQueue: 'axdio_m_dlqueue',
  accent: 'spotdl_mobile_accent', playlists: 'spotdl_playlists', device: 'spotdl_device_id', token: 'auth_token',
  collab: 'axdio_collab', social: 'axdio_social', chats: 'axdio_chats',
};
const S = Object.assign({
  autoplay: true, dynColor: true, boost: 1, eqOn: false, eqPreset: 'flat', eq: [0, 0, 0, 0, 0, 0], normalize: false,
  libView: 'list', libSort: 'recent', deviceName: '', shuffle: false, repeat: 0,
  volume: 1, muted: false, crossfade: 0, gapless: true, quality: 'original', cellQuality: '',
}, LS.get(K.settings, {}));
const FRESH_DEVICE = LS.raw(K.settings) == null;
const saveS = () => LS.set(K.settings, S);
const saveSSoon = debounce(saveS, 400);
const AUDIO_CACHE = 'spotdl-audio-v1';   // shared with the desktop player's offline downloads
const META_CACHE = 'axdio-meta-v1';
const LIB_URL = '/api/library/cache';
const streamUrl = rel => '/api/stream_path?path=' + encodeURIComponent(rel);   // the original file (also the offline cache key)
// Streaming quality: lossless, or a smaller MP3 made by the server ("data saver"). Phones can use a
// separate choice on mobile data where the browser reports the connection type.
const QUALITIES = { original: 'Lossless', high: 'High · 320 kbps', normal: 'Normal · 192 kbps', low: 'Data saver · 128 kbps' };
const onCellular = () => { const c = navigator.connection; return !!(c && (c.type === 'cellular' || c.saveData)); };
function streamQuality() {
  if (!(SITE.features && SITE.features.transcoding)) return 'original';
  const q = onCellular() && S.cellQuality ? S.cellQuality : S.quality;
  return QUALITIES[q] ? q : 'original';
}
const playUrl = rel => { const q = streamQuality(); return streamUrl(rel) + (q !== 'original' ? '&q=' + q : ''); };
function setQuality(q, cellular) { if (cellular) S.cellQuality = q; else S.quality = q; saveS(); UI.dirty(['settings'], true); }
const SITE = {};

/* ======================================================================
   3. Colours & covers
   ====================================================================== */
const PH = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#282828"/><path fill="#5e5e5e" d="M12.5 6v7.6a2.6 2.6 0 1 0 1.3 2.2V8.6h2.7V6z"/></svg>');
const coverUrl = rel => '/api/cover?path=' + encodeURIComponent(rel || '');
const img = (src, alt = '') => `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
document.addEventListener('error', e => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG') return;
  // A profile photo that can't load (removed, or not in a restored backup) falls back to the initial.
  const av = t.closest('.avatar');
  if (av) { av.textContent = av.dataset.i || ''; return; }
  if (!t.dataset.ph) { t.dataset.ph = '1'; t.src = PH; }
}, true);

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
// Re-light a colour so white text stays legible on it; greys stay grey.
function tone(rgb, l, sMin = 0, sMax = .72) {
  const [h, s] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return hslToRgb(h, s < .08 ? s : clamp(s, sMin, sMax), l).map(v => Math.round(v)).join(', ');
}
const hexRgb = hex => { const n = parseInt(String(hex).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const colorCache = new Map();
function dominant(src) {
  if (colorCache.has(src)) return colorCache.get(src);
  const p = new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 20;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0, 20, 20);
        const d = x.getImageData(0, 0, 20, 20).data;
        // Weight saturated, mid-bright pixels so big black/white areas don't wash out the hue.
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 510;
          const s = mx === mn ? 0 : (mx - mn) / (255 - Math.abs(mx + mn - 255) || 1);
          const wt = .04 + s * s * Math.max(0, 1 - Math.abs(l - .5) * 1.7);
          r += R * wt; g += G * wt; b += B * wt; w += wt;
        }
        resolve(w ? [r / w, g / w, b / w] : null);
      } catch (e) { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
  colorCache.set(src, p);
  return p;
}
function applyAccent(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return;
  const root = document.documentElement.style;
  root.setProperty('--accent', color);
  const n = parseInt(color.slice(1), 16), lum = (.299 * (n >> 16) + .587 * ((n >> 8) & 255) + .114 * (n & 255)) / 255;
  root.setProperty('--on-accent', lum > .55 ? '#000' : '#fff');
}
const ACCENTS = ['#1ed760', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#14b8a6', '#ffffff'];
function setAccent(c) { applyAccent(c); LS.setRaw(K.accent, c); pushPrefs(); UI.dirty(['settings'], true); }
const setThemeColor = c => { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = c; };

/* ======================================================================
   4. Library index
   ====================================================================== */
const L = {
  tracks: [], artists: [], albums: [], byRel: new Map(), artistByKey: new Map(), albumByKey: new Map(), sources: {},
  azArtists: [], azAlbums: [], newestAlbums: [], version: null, ready: false,
};
const SUFFIX = /\s+-\s+(single|ep)$/i;
const SPLIT = /\s*(?:,|;|\s&\s|\s\+\s|\s\/\s|\bfeat\.?\s|\bft\.?\s|\bwith\s|\bx\s|\bvs\.?\s)\s*/i;
const trackNo = t => {
  const n = parseInt(t.track_number, 10);
  if (n > 0) return n;
  const m = /^(\d{1,3})\s*[-._ ]/.exec(String(t.rel_path).split('/').pop());
  return m ? +m[1] : 0;
};
const fileTitle = rel => String(rel).split('/').pop().replace(/\.[^.]+$/, '').replace(/^\d{1,3}\s*[-._ ]\s*/, '');
const sortName = s => (s.replace(/^(the|a)\s+/i, '').replace(/^[^\p{L}\p{N}]+/u, '') || s);
const fileExt = rel => (String(rel).split('.').pop() || '').toUpperCase();

function buildLibrary(raw) {
  const t0 = performance.now();
  const tracks = [], artists = [], albums = [];
  const byRel = new Map(), artistByKey = new Map(), albumByKey = new Map();
  const votes = new Map(), rawAlbums = [], sources = {};

  // Artists are merged case-insensitively ("Syrex" / "SYREX"); the spelling with most tracks wins.
  for (const a of Array.isArray(raw) ? raw : []) {
    const name = String((a && a.artist) || '').trim() || 'Unknown Artist';
    const key = name.toLowerCase();
    if (!artistByKey.has(key)) {
      const ar = { id: artists.length, key, name, albumIds: [], trackIds: [], featIds: [], compIds: new Set(), rel: new Map(), cover: '', s: '', mtime: 0 };
      artists.push(ar); artistByKey.set(key, ar); votes.set(key, new Map());
    }
    for (const al of (a.albums || [])) {
      const tr = (al && al.tracks) || [];
      if (!tr.length) continue;
      const v = votes.get(key); v.set(name, (v.get(name) || 0) + tr.length);
      rawAlbums.push({ ak: key, name: String(al.name || '').trim() || 'Unknown Album', tracks: tr });
    }
  }
  for (const ar of artists) { let n = -1; for (const [nm, c] of votes.get(ar.key)) if (c > n) { ar.name = nm; n = c; } }

  // Compilations arrive tagged per track artist (one DJ mix = dozens of 1-track "albums"): merge them.
  const groups = new Map();
  for (const ra of rawAlbums) { const k = ra.name.toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ra); }
  for (const [lname, group] of groups) {
    const total = group.reduce((s, g) => s + g.tracks.length, 0);
    const comp = new Set(group.map(g => g.ak)).size >= 3 && !SUFFIX.test(group[0].name)
      && total / group.length <= 3 && Math.max(...group.map(g => g.tracks.length)) <= total * .4;
    for (const ra of group) {
      const ar = artistByKey.get(ra.ak);
      const key = comp ? '*\u0001' + lname : ra.ak + '\u0001' + lname;
      for (const t of ra.tracks) {
        if (!t || !t.rel_path || byRel.has(t.rel_path)) continue;
        let al = albumByKey.get(key);
        // The same song filed twice under one release (e.g. a normal + deluxe folder) is shown once;
        // the second path stays resolvable so likes/playlists that point at it still work.
        const dupKey = norm(t.title || fileTitle(t.rel_path)) + '|' + norm(t.display_artist || ar.name);
        if (al && al.seen.has(dupKey)) { byRel.set(t.rel_path, tracks[al.seen.get(dupKey)]); continue; }
        if (!al) {
          al = { id: albums.length, key, name: ra.name, title: ra.name.replace(SUFFIX, ''), artistId: comp ? -1 : ar.id, trackIds: [], mtime: 0, type: 'Album', comp, cover: '', s: '', seen: new Map() };
          albums.push(al); albumByKey.set(key, al);
          if (!comp) ar.albumIds.push(al.id);
        }
        if (comp) ar.compIds.add(al.id);
        const tr = {
          id: tracks.length, rel: t.rel_path, title: String(t.title || fileTitle(t.rel_path)),
          artist: String(t.display_artist || ar.name), artistId: ar.id, albumId: al.id,
          no: trackNo(t), mtime: +t.mtime || 0, hc: t.has_cover !== false, st: '', sa: '', s: '', src: t.src || '',
        };
        if (t.src) sources[t.src] = t.src_name || 'another server';
        tracks.push(tr); byRel.set(tr.rel, tr); al.trackIds.push(tr.id); ar.trackIds.push(tr.id); al.seen.set(dupKey, tr.id);
        if (tr.mtime > al.mtime) al.mtime = tr.mtime;
        if (tr.mtime > ar.mtime) ar.mtime = tr.mtime;
      }
    }
  }
  for (const al of albums) {
    al.trackIds.sort((a, b) => (tracks[a].no || 1e4) - (tracks[b].no || 1e4));
    const m = SUFFIX.exec(al.name), n = al.trackIds.length;
    al.type = al.comp ? 'Compilation' : m ? (m[1].toLowerCase() === 'ep' ? 'EP' : 'Single') : n <= 3 ? 'Single' : n <= 6 ? 'EP' : 'Album';
    const withArt = al.trackIds.find(id => tracks[id].hc);
    al.hc = withArt != null;
    al.cover = tracks[withArt != null ? withArt : al.trackIds[0]].rel;
  }

  // Related artists: featured credits count 3, sharing a compilation counts 1.
  const bump = (a, b, w) => { if (a === b) return; a.rel.set(b.id, (a.rel.get(b.id) || 0) + w); b.rel.set(a.id, (b.rel.get(a.id) || 0) + w); };
  for (const tr of tracks) {
    const ar = artists[tr.artistId];
    if (tr.artist.toLowerCase() === ar.key) continue;
    for (const part of tr.artist.split(SPLIT)) {
      const other = artistByKey.get(part.trim().toLowerCase());
      if (other && other !== ar) { bump(ar, other, 3); other.featIds.push(tr.id); }
    }
  }
  for (const al of albums) {
    if (!al.comp) continue;
    const ids = uniq(al.trackIds.map(id => tracks[id].artistId));
    if (ids.length <= 60) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) bump(artists[ids[i]], artists[ids[j]], 1);
  }
  for (const ar of artists) {
    ar.albumIds.sort((a, b) => albums[b].mtime - albums[a].mtime);
    let best = null;
    for (const id of ar.albumIds) {
      const al = albums[id];
      if (!best || (al.hc && !best.hc) || (al.hc === best.hc && al.trackIds.length > best.trackIds.length)) best = al;
    }
    ar.cover = best ? best.cover : (ar.trackIds.length ? tracks[ar.trackIds[0]].rel : '');
    ar.s = norm(ar.name);
  }
  for (const al of albums) al.s = norm(al.title + ' ' + (al.artistId >= 0 ? artists[al.artistId].name : 'various artists'));
  for (const tr of tracks) { tr.st = norm(tr.title); tr.sa = norm(tr.artist); tr.s = `${tr.st} ${tr.sa} ${norm(albums[tr.albumId].title)}`; }

  const live = artists.filter(a => a.trackIds.length);
  Object.assign(L, {
    tracks, artists, albums, byRel, artistByKey, albumByKey, sources, ready: true,
    azArtists: live.map(a => [sortName(a.name), a.id]).sort((x, y) => collator.compare(x[0], y[0])).map(x => x[1]),
    azAlbums: albums.map(a => [sortName(a.title), a.id]).sort((x, y) => collator.compare(x[0], y[0])).map(x => x[1]),
    newestAlbums: albums.map(a => a.id).sort((a, b) => albums[b].mtime - albums[a].mtime),
  });
  MIX.key = '';
  return Math.round(performance.now() - t0);
}
const albumArtist = al => al.artistId >= 0 ? L.artists[al.artistId].name : 'Various Artists';
// The server an album comes from, when all of it is shared by another server ('' for this server's own music).
function albumSource(al) {
  const s = al.trackIds.map(id => L.tracks[id].src);
  return s.length && s.every(x => x && x === s[0]) ? L.sources[s[0]] || '' : '';
}
const albumOf = t => L.albums[t.albumId];
const artistOf = t => L.artists[t.artistId];
// Split a display credit ("A, B & C") into text parts, linking the ones that are artists in the library.
function creditParts(t) {
  const out = [], re = new RegExp(SPLIT.source, 'gi');
  let last = 0, m;
  const push = s => { const name = s.trim(); if (!name) return; const ar = L.artistByKey.get(name.toLowerCase()); out.push({ text: s, artist: ar && ar.trackIds.length ? ar : null }); };
  while ((m = re.exec(t.artist)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    push(t.artist.slice(last, m.index)); out.push({ text: m[0], sep: true }); last = m.index + m[0].length;
  }
  push(t.artist.slice(last));
  if (!out.some(p => p.artist)) return [{ text: t.artist, artist: artistOf(t) }];
  return out;
}
function relatedArtists(ar, n = 8) {
  return [...ar.rel.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => L.artists[x[0]]).filter(a => a.trackIds.length);
}
function artistPlays() {
  const m = new Map();
  for (const h of U.history) { const t = L.byRel.get(h.rel_path); if (t) m.set(t.artistId, (m.get(t.artistId) || 0) + h.count); }
  return m;
}
function topArtists(n = 10) { return [...artistPlays().entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => L.artists[x[0]]); }
function popular(ar, n = 10) {
  const newest = ar.mtime || 1;
  return ar.trackIds.map(id => {
    const t = L.tracks[id], al = L.albums[t.albumId];
    const score = (U.plays.get(t.rel) || 0) * 10 + (U.likedSet.has(t.rel) ? 8 : 0) + (al.type === 'Single' ? 1.5 : 0)
      + (t.mtime / newest) + (hashStr(t.rel) % 100) / 400;
    return [score, id];
  }).sort((a, b) => b[0] - a[0]).slice(0, n).map(x => x[1]);
}
function radioIds(seedId, n = 50, exclude = new Set()) {
  const seed = L.tracks[seedId]; if (!seed) return [];
  const rand = rng(seed.rel + dayKey());
  const ar = artistOf(seed), pool = [];
  const take = (ids, k) => shuffled(ids, rand).slice(0, k).forEach(id => pool.push(id));
  take(ar.trackIds, 14);
  relatedArtists(ar, 10).forEach(r => take(r.trackIds, 5));
  if (pool.length < n) topArtists(8).forEach(r => take(r.trackIds, 3));
  while (pool.length < n * 1.5 && L.tracks.length > n * 2) pool.push(Math.floor(rand() * L.tracks.length));
  const out = uniq(shuffled(pool, rand)).filter(id => id !== seedId && !exclude.has(id));
  return [seedId, ...out].slice(0, n);
}

/* Generated "Made for you" mixes — deterministic per day / week so they feel stable. */
const MIX = { key: '', list: [], byId: new Map() };
const PALETTE = ['#dc148c', '#006450', '#8400e7', '#1e3264', '#e8115b', '#27856a', '#477d95', '#503750', '#ba5d07', '#148a08', '#e13300', '#509bf5', '#af2896', '#8d67ab', '#e91429', '#0d73ec'];
function buildMixes() {
  const key = [dayKey(), U.history.length, U.liked.length, L.tracks.length, U.username].join('|');
  if (MIX.key === key) return MIX.list;
  const rand = rng(key), list = [];
  let anchors = topArtists(8);
  if (anchors.length < 4) {
    const extra = shuffled(L.artists.filter(a => a.trackIds.length >= 6 && !anchors.includes(a)), rng(dayKey()));
    anchors = anchors.concat(extra.slice(0, 4 - anchors.length));
  }
  anchors.slice(0, 4).forEach((anchor, k) => {
    const rel = uniq(relatedArtists(anchor, 5).concat(anchors.filter(a => a !== anchor).slice(0, 2)));
    const pool = shuffled(anchor.trackIds, rand).slice(0, 22);
    rel.forEach(r => shuffled(r.trackIds, rand).slice(0, 6).forEach(id => pool.push(id)));
    const names = [anchor.name, ...rel.slice(0, 2).map(r => r.name)];
    list.push({
      id: 'daily-' + (k + 1), name: 'Daily Mix ' + (k + 1), desc: names.join(', ') + ' and more',
      ids: uniq(shuffled(pool, rand)).slice(0, 50), cover: { type: 'band', img: coverUrl(anchor.cover), m1: PALETTE[(k * 5 + 3) % PALETTE.length] },
    });
  });
  const played = artistPlays(), wr = rng(weekKey() + U.username);
  const unheard = shuffled(L.artists.filter(a => a.trackIds.length && !played.has(a.id)), wr).slice(0, 30);
  if (unheard.length >= 5) {
    list.push({ id: 'discover', name: 'Discover Weekly', desc: "Your weekly mixtape of music you haven't played yet. New every Monday.",
      ids: unheard.map(a => pick(a.trackIds, wr)), cover: { type: 'typo', m1: '#477d95', m2: '#1e3264' } });
  }
  const top = U.history.filter(h => L.byRel.has(h.rel_path)).slice().sort((a, b) => b.count - a.count);
  if (top.length >= 5) {
    list.push({ id: 'onrepeat', name: 'On Repeat', desc: "Songs you can't stop playing.",
      ids: top.slice(0, 30).map(h => L.byRel.get(h.rel_path).id), cover: { type: 'typo', m1: '#e8115b', m2: '#8400e7' } });
  }
  const monthAgo = now() - 30 * 864e5;
  const rewind = U.history.filter(h => L.byRel.has(h.rel_path) && h.last_played && Date.parse(h.last_played) < monthAgo);
  if (rewind.length >= 8) {
    list.push({ id: 'rewind', name: 'Repeat Rewind', desc: "Past favourites you haven't played in a while.",
      ids: shuffled(rewind, rand).slice(0, 30).map(h => L.byRel.get(h.rel_path).id), cover: { type: 'typo', m1: '#ba5d07', m2: '#503750' } });
  }
  const fresh = L.tracks.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 50).map(t => t.id);
  if (fresh.length) list.push({ id: 'fresh', name: 'Fresh in Your Library', desc: 'The newest arrivals, straight off the server.', ids: fresh, cover: { type: 'typo', m1: '#148a08', m2: '#006450' } });
  const liked = U.liked.map(r => L.byRel.get(r)).filter(Boolean);
  if (liked.length >= 10) {
    const seedIds = shuffled(liked, rand).slice(0, 6).map(t => t.id);
    const ids = uniq(seedIds.flatMap(id => radioIds(id, 12))).filter(id => !U.likedSet.has(L.tracks[id].rel));
    list.push({ id: 'liked-mix', name: 'Liked Songs Mix', desc: 'Songs that sound like the ones you love.', ids: shuffled(ids, rand).slice(0, 40), cover: { type: 'typo', m1: '#4a2fbd', m2: '#8ea8e6' } });
  }
  MIX.key = key; MIX.list = list; MIX.byId = new Map(list.map(m => [m.id, m]));
  return list;
}
function getMix(id) {
  buildMixes();
  if (MIX.byId.has(id)) return MIX.byId.get(id);
  if (id.startsWith('radio:')) {
    const t = L.byRel.get(id.slice(6)); if (!t) return null;
    const m = { id, name: `${t.title} Radio`, desc: `Songs inspired by ${t.title} by ${t.artist}.`, ids: radioIds(t.id, 50), cover: { type: 'band', img: coverUrl(t.rel), m1: '#1e3264', label: 'Radio' } };
    MIX.byId.set(id, m); return m;
  }
  if (id.startsWith('artist-radio:')) {
    const ar = L.artistByKey.get(id.slice(13)); if (!ar) return null;
    const seed = popular(ar, 1)[0];
    const m = { id, name: `${ar.name} Radio`, desc: `With ${relatedArtists(ar, 3).map(a => a.name).concat(ar.name).join(', ')}.`, ids: radioIds(seed, 50), cover: { type: 'band', img: coverUrl(ar.cover), m1: '#e13300', label: 'Radio' } };
    MIX.byId.set(id, m); return m;
  }
  if (id.startsWith('feat:')) {
    const ar = L.artistByKey.get(id.slice(5)); if (!ar || !ar.featIds.length) return null;
    const m = { id, name: `Featuring ${ar.name}`, desc: `${ar.name} guest spots across your library.`, ids: uniq(ar.featIds), cover: { type: 'band', img: coverUrl(ar.cover), m1: '#0d73ec', label: 'Featuring' } };
    MIX.byId.set(id, m); return m;
  }
  return null;
}

function searchAll(q) {
  const nq = norm(q).trim();
  if (!nq) return null;
  const toks = nq.split(/\s+/);
  const has = s => toks.every(t => s.includes(t));
  const songs = [], artists = [], albums = [], playlists = [];
  for (const t of L.tracks) {
    if (!has(t.s)) continue;
    let sc = t.st === nq ? 130 : t.st.startsWith(nq) ? 90 : t.st.includes(nq) ? 55 : 0;
    if (t.sa.includes(nq)) sc += 25;
    sc += Math.min(30, (U.plays.get(t.rel) || 0) * 3) + (U.likedSet.has(t.rel) ? 12 : 0);
    songs.push([sc, t.id]);
  }
  for (const ar of L.artists) {
    if (!ar.trackIds.length || !has(ar.s)) continue;
    const sc = (ar.s === nq ? 220 : ar.s.startsWith(nq) ? 150 : ar.s.includes(' ' + nq) ? 110 : 60) + Math.min(40, ar.trackIds.length / 3);
    artists.push([sc, ar.id]);
  }
  for (const al of L.albums) {
    if (!has(al.s)) continue;
    const tl = norm(al.title);
    albums.push([(tl === nq ? 120 : tl.startsWith(nq) ? 85 : tl.includes(nq) ? 55 : 20) + Math.min(20, al.trackIds.length), al.id]);
  }
  for (const name of Object.keys(U.playlists)) if (has(norm(name))) playlists.push({ k: 'playlist', name });
  for (const p of Collab.list) if (has(norm(p.name))) playlists.push({ k: 'cpl', id: p.id });
  for (const m of buildMixes()) if (has(norm(m.name + ' ' + m.desc))) playlists.push({ k: 'mix', id: m.id });
  const by = (a, b) => b[0] - a[0];
  songs.sort(by); artists.sort(by); albums.sort(by);
  let top = null;
  const best = [[artists[0], 'artist', 12], [songs[0], 'track', 0], [albums[0], 'album', -5]]
    .filter(x => x[0]).map(x => [x[0][0] + x[2], x[1], x[0][1]]).sort(by)[0];
  if (best) top = { k: best[1], id: best[2] };
  return { top, songs: songs.slice(0, 100).map(x => x[1]), artists: artists.slice(0, 40).map(x => x[1]), albums: albums.slice(0, 40).map(x => x[1]), playlists };
}

/* ======================================================================
   5. User data (auth, likes, playlists, history, follows)
   ====================================================================== */
const U = {
  token: LS.raw(K.token) || '', username: '', name: '', avatar: '', prefs: {}, discord: null, passwordLogin: true, presence: false,
  liked: [], likedSet: new Set(), playlists: {}, history: [], plays: new Map(), follows: [], saved: [],
};
function setLiked(arr) { U.liked = uniq((arr || []).filter(x => typeof x === 'string')); U.likedSet = new Set(U.liked); }
function setHistory(arr) {
  U.history = (arr || []).filter(h => h && h.rel_path).map(h => ({ rel_path: h.rel_path, count: h.count || 1, last_played: h.last_played || '' }));
  U.history.sort((a, b) => String(b.last_played).localeCompare(String(a.last_played)));
  U.plays = new Map(U.history.map(h => [h.rel_path, h.count]));
}
function loadLocalUser() {
  const loc = LS.get(K.local, {});
  setLiked(loc.liked); setHistory(loc.history);
  U.follows = loc.follows || []; U.saved = loc.saved || [];
  U.playlists = LS.get(K.playlists, {}) || {};
  U.username = ''; U.name = ''; U.avatar = ''; U.prefs = {};
  Collab.set([], true);
}
function saveLocalUser() {
  LS.set(K.local, { liked: U.liked, follows: U.follows, saved: U.saved, history: U.history.slice(0, 300) });
  LS.set(K.playlists, U.playlists);
}
function cacheUser() {
  if (!U.token) return;
  LS.set(K.userCache, { username: U.username, name: U.name, avatar: U.avatar, prefs: U.prefs, liked: U.liked, playlists: U.playlists, history: U.history.slice(0, 400), follows: U.follows, saved: U.saved });
}
function applyUser(d) {
  U.username = d.username || ''; U.name = d.display_name || d.name || U.username; U.avatar = d.avatar || '';
  U.prefs = d.preferences || d.prefs || {};
  setLiked(d.liked_songs || d.liked); setHistory(d.history);
  U.playlists = (d.playlists && typeof d.playlists === 'object' && !Array.isArray(d.playlists)) ? d.playlists : {};
  U.follows = d.follows || U.prefs.followed_artists || [];
  U.saved = d.saved || U.prefs.saved_albums || [];
  if ('discord' in d) U.discord = d.discord || null;
  if ('password_login' in d) U.passwordLogin = d.password_login !== false;
  if ('presence' in d) U.presence = !!d.presence;
  if (!LS.raw(K.accent) && U.prefs.theme_accent) applyAccent(U.prefs.theme_accent);
}
async function api(path, body, method) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (U.token) headers['X-Auth-Token'] = U.token;
  const res = await fetch(path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) { const err = new Error((data && data.error) || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return data || {};
}
async function syncUser() {
  if (!U.token) return false;
  try {
    const d = await api('/api/user/sync');
    if (!d.authenticated) { UI.toast('Your session expired. Please log in again.'); signOut(true); return false; }
    applyUser(d); cacheUser();
    return true;
  } catch (e) { return false; }
}
const pushLibrary = debounce(() => {
  if (!U.token) { saveLocalUser(); return; }
  api('/api/user/sync', { liked_songs: U.liked, playlists: U.playlists }).catch(() => UI.toast("Couldn't sync your changes — will retry"));
  cacheUser();
}, 500);
const pushPrefs = debounce(() => {
  if (!U.token) { saveLocalUser(); return; }
  U.prefs = Object.assign({}, U.prefs, { followed_artists: U.follows, saved_albums: U.saved });
  const accent = LS.raw(K.accent); if (accent) U.prefs.theme_accent = accent;
  api('/api/user/profile', { preferences: U.prefs }).catch(() => { /* retried on next change */ });
  cacheUser();
}, 700);
async function signIn(username, password, register, displayName, inviteCode) {
  const path = register ? '/api/auth/register' : '/api/auth/login';
  const invite = inviteCode != null ? inviteCode : pendingInvite();
  const body = register ? { username, password, display_name: displayName || username, invite_code: invite || undefined } : { username, password };
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.token) throw new Error(d.error || 'Login failed');
  if (register) { try { sessionStorage.removeItem(INVITE_KEY); } catch (e) { /* ignore */ } }
  return finishSignIn(d, username);
}
async function finishSignIn(d, fallbackName) {
  const local = { liked: U.liked.slice(), follows: U.follows.slice(), saved: U.saved.slice() };
  U.token = d.token; LS.setRaw(K.token, d.token);
  await syncUser();
  // Carry over anything liked or followed while logged out.
  const before = U.liked.length;
  setLiked(U.liked.concat(local.liked));
  const extraFollows = local.follows.filter(k => !U.follows.includes(k)), extraSaved = local.saved.filter(k => !U.saved.includes(k));
  U.follows = U.follows.concat(extraFollows); U.saved = U.saved.concat(extraSaved);
  if (U.liked.length !== before) pushLibrary();
  if (extraFollows.length || extraSaved.length) pushPrefs();
  LS.set(K.local, { history: [] });
  Connect.beat();
  return d.display_name || d.username || fallbackName;
}
/* Discord: signing in comes back as ?login=<one-time code> (traded for a token here) or ?discord=<outcome>. */
let discordNote = '';
async function takeLoginFromUrl() {
  const u = new URL(location.href), code = u.searchParams.get('login'), note = u.searchParams.get('discord');
  if (!code && !note) return;
  u.searchParams.delete('login'); u.searchParams.delete('discord');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  discordNote = note || '';
  if (!code) return;
  try {
    const res = await fetch('/api/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.token) throw new Error(d.error || '');
    U.token = d.token; LS.setRaw(K.token, d.token);   // boot loads the account right after
    discordNote = note === 'welcome' ? 'welcome' : 'signed-in';
  } catch (e) { discordNote = 'error'; }
}
// What to tell the listener about a Discord round trip (once): a message, or 'invite' when an invite code is needed.
const DISCORD_NOTES = {
  error: "Couldn't sign in with Discord. Try again.", cancelled: '', unavailable: "Sign in with Discord isn't set up on this server.",
  'no-account': "There's no account linked to that Discord, and sign-ups are closed. Ask the server admin.", disabled: 'This account has been disabled.',
  linked: 'Discord connected', taken: 'That Discord account is already connected to another account here.',
};
function takeDiscordNote() {
  const n = discordNote; discordNote = '';
  if (!n) return null;
  if (n === 'invite') return { invite: true };
  if (n === 'welcome' || n === 'signed-in') return { text: n === 'welcome' ? `Welcome, ${U.name || U.username}!` : `Signed in as ${U.name || U.username}` };
  return DISCORD_NOTES[n] ? { text: DISCORD_NOTES[n] } : null;
}
// The page's address goes along, so Discord sends people back to the address they're using.
const discordUrl = link => '/auth/discord?' + (link ? 'link=1&' : '') + 'o=' + encodeURIComponent(location.origin);
const discordSignIn = () => { location.href = discordUrl(); };
const discordLink = () => { location.href = discordUrl(true); };
async function discordUnlink() { await api('/api/user/discord/unlink', {}); U.discord = null; }
async function discordFinish(invite) {
  const d = await api('/api/auth/discord/finish', { invite_code: invite });
  return finishSignIn(d, d.username);
}
const discordButton = (label = 'Continue with Discord') => featOn('discord_login') ? `<a class="ax-discord" href="${discordUrl()}">${ic('discord')}<span>${esc(label)}</span></a><div class="ax-or"><span>or</span></div>` : '';
/* Discord status: a helper on the listener's computer shows what they play (Discord only accepts that locally). */
const presenceInfo = () => api('/api/user/presence');
async function presenceSetup() {
  const d = await api('/api/user/presence', {});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([d.script], { type: 'text/x-python' }));
  a.download = d.filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  U.presence = true;
  return d;
}
async function presenceOff() { await api('/api/user/presence', undefined, 'DELETE'); U.presence = false; }
function signOut(silent) {
  U.token = ''; LS.del(K.token); LS.del(K.userCache);
  loadLocalUser();
  UI.refresh();
  if (!silent) UI.toast('Logged out');
}
async function updateProfile(displayName) {
  await api('/api/user/profile', { display_name: displayName });
  U.name = displayName || U.username; cacheUser();
}
// Profile photos are cropped to a square and re-encoded as JPEG here (dropping camera and location data),
// so uploads stay small; the server re-encodes them again.
function pickImage() {
  return new Promise(resolve => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/*';
    i.addEventListener('change', () => resolve((i.files && i.files[0]) || null));
    i.click();
  });
}
async function squarePhoto(file, size = 512) {
  const fail = new Error("That image couldn't be opened. Try a JPEG or PNG.");
  if (!file || (file.type && !file.type.startsWith('image/'))) throw fail;
  if (file.size > 40 * 1024 * 1024) throw new Error('That image is too large.');
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const w = im.naturalWidth, h = im.naturalHeight, s = Math.min(w, h);
    if (!s) throw fail;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = '#282828'; x.fillRect(0, 0, size, size);
    x.imageSmoothingQuality = 'high';
    x.drawImage(im, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', .9));
    if (!blob) throw fail;
    return blob;
  } catch (e) { throw e && e.message ? e : fail; }
  finally { URL.revokeObjectURL(url); }
}
async function uploadAvatar(blob) {
  const res = await fetch('/api/user/avatar', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg', 'X-Auth-Token': U.token }, body: blob, cache: 'no-store' });
  let d = {};
  try { d = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) throw new Error(d.error || `Upload failed (${res.status})`);
  U.avatar = d.avatar || ''; cacheUser();
  return U.avatar;
}
async function removeAvatar() { await api('/api/user/avatar', undefined, 'DELETE'); U.avatar = ''; cacheUser(); }
const changePassword = (oldPw, newPw) => api('/api/user/change_password', { old_password: oldPw, new_password: newPw });
// Devices signed in to this account, data export and account deletion.
const listSessions = () => api('/api/user/sessions').then(d => d.sessions || []);
const revokeSession = id => api('/api/user/sessions/revoke', id === 'others' ? { others: true } : { id });
async function exportMyData() {
  const res = await fetch('/api/user/export', { headers: { 'X-Auth-Token': U.token }, cache: 'no-store' });
  if (!res.ok) throw new Error("Couldn't download your data");
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = ((res.headers.get('Content-Disposition') || '').match(/filename=([^;]+)/) || [])[1] || 'axdio-data.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// Subsonic-compatible apps sign in with an app password (see the server's Subsonic section).
const subsonicInfo = () => api('/api/user/subsonic');
const scrobbleInfo = () => api('/api/user/scrobbling');
const connectListenBrainz = token => api('/api/user/scrobbling', { service: 'listenbrainz', token });
const disconnectScrobbler = service => api('/api/user/scrobbling', { service, disconnect: true });
const subsonicPassword = action => api('/api/user/subsonic', { action });
async function deleteAccount(password) {
  await api('/api/user/delete_account', { password });
  signOut(true);
}
function recordPlay(t) {
  const iso = new Date().toISOString();
  const i = U.history.findIndex(h => h.rel_path === t.rel);
  const h = i >= 0 ? U.history.splice(i, 1)[0] : { rel_path: t.rel, count: 0 };
  h.count++; h.last_played = iso;
  U.history.unshift(h);
  U.plays.set(t.rel, h.count);
  if (U.token) { api('/api/user/record_play', { rel_path: t.rel }).catch(() => {}); cacheUser(); } else saveLocalUser();
  UI.dirty(['recent', 'home', 'profile']);
}
function toggleLike(t, btn) {
  if (!t) return;
  haptic();
  if (U.likedSet.has(t.rel)) {
    U.likedSet.delete(t.rel); U.liked = U.liked.filter(r => r !== t.rel);
    UI.toast('Removed from Liked Songs', { action: 'Undo', onAction: () => toggleLike(t) });
  } else {
    U.likedSet.add(t.rel); U.liked.push(t.rel);
    if (btn) { btn.classList.remove('heart-pop'); void btn.offsetWidth; btn.classList.add('heart-pop'); }
    UI.toast('Added to Liked Songs', { action: 'Change', onAction: () => UI.pickPlaylist([t.id]) });
  }
  pushLibrary();
  refreshLike(t.id);
  UI.dirty(['liked', 'library'], true);
  UI.dirty(['home', 'artist', 'profile']);
}
// Like/unlike many songs at once (desktop multi-select).
function setLikedMany(ids, on) {
  const rels = ids.map(id => L.tracks[id].rel);
  if (on) rels.forEach(r => { if (!U.likedSet.has(r)) { U.likedSet.add(r); U.liked.push(r); } });
  else { const s = new Set(rels); U.liked = U.liked.filter(r => !s.has(r)); rels.forEach(r => U.likedSet.delete(r)); }
  pushLibrary(); ids.forEach(refreshLike);
  UI.toast(on ? `Added ${count(ids.length, 'song')} to Liked Songs` : `Removed ${count(ids.length, 'song')} from Liked Songs`);
  UI.dirty(['liked', 'library'], true);
}
function toggleFollow(ar) {
  haptic();
  if (U.follows.includes(ar.key)) { U.follows = U.follows.filter(k => k !== ar.key); UI.toast(`Unfollowed ${ar.name}`); }
  else { U.follows.unshift(ar.key); UI.toast(`Following ${ar.name}`); }
  pushPrefs();
  $$(`[data-follow="${ar.id}"]`).forEach(b => { const on = U.follows.includes(ar.key); b.classList.toggle('on', on); b.textContent = on ? 'Following' : 'Follow'; });
  UI.dirty(['library', 'home']);
}
function toggleSaveAlbum(al) {
  haptic();
  const was = U.saved.includes(al.key);
  U.saved = was ? U.saved.filter(k => k !== al.key) : [al.key, ...U.saved];
  UI.toast(was ? 'Removed from Your Library' : 'Added to Your Library');
  pushPrefs();
  $$(`[data-save="${al.id}"]`).forEach(b => { b.classList.toggle('lit', !was); b.innerHTML = ic(was ? 'add' : 'check-c'); });
  UI.dirty(['library']);
}
function addToPlaylist(name, ids) {
  const list = U.playlists[name] || (U.playlists[name] = []);
  const rels = ids.map(id => L.tracks[id].rel).filter(r => !list.includes(r));
  list.push(...rels);
  pushLibrary();
  UI.dirty(['playlist', 'library', 'home'], true);
  return rels.length;
}
function removeFromPlaylist(name, rels) {
  const list = U.playlists[name]; if (!list) return;
  const drop = new Set(rels);
  U.playlists[name] = list.filter(r => !drop.has(r));
  pushLibrary();
  UI.dirty(['playlist', 'library'], true);
}
function reorderPlaylist(name, ids, from, to) {
  const rels = U.playlists[name]; if (!rels) return;
  const list = ids.map(id => L.tracks[id].rel);
  const [m] = list.splice(from, 1); list.splice(to, 0, m);
  U.playlists[name] = list.concat(rels.filter(r => !L.byRel.has(r)));
  pushLibrary();
}
// Returns an error message, or '' on success.
function plCreate(name, ids = []) {
  name = String(name || '').trim();
  if (!name) return 'Give your playlist a name';
  if (U.playlists[name]) return 'A playlist with that name already exists';
  U.playlists[name] = [];
  if (ids.length) addToPlaylist(name, ids); else pushLibrary();
  UI.dirty(['library', 'home', 'profile'], true);
  return '';
}
function plRename(name, nn) {
  nn = String(nn || '').trim();
  if (!nn || nn === name) return '';
  if (U.playlists[nn]) return 'A playlist with that name already exists';
  const out = {};
  Object.keys(U.playlists).forEach(k => { out[k === name ? nn : k] = U.playlists[k]; });
  U.playlists = out;
  RECENTS.forEach(r => { if (r.k === 'playlist:' + name) r.k = 'playlist:' + nn; });
  LS.set(K.recents, RECENTS);
  pushLibrary();
  UI.dirty(['playlist', 'library', 'home', 'profile'], true);
  return '';
}
function plDelete(name) {
  delete U.playlists[name];
  pushLibrary();
  UI.dirty(['library', 'home', 'profile', 'playlist'], true);
}

/* Collaborative playlists: the owner invites friends and everyone on it edits the same list on the server.
   Edits are applied here first so the apps feel instant, then sent; the server merges edits by song path. */
const Collab = {
  list: [], byId: new Map(),
  set(arr, quiet) {
    this.list = Array.isArray(arr) ? arr : [];
    this.byId = new Map(this.list.map(p => [p.id, p]));
    if (U.token) LS.set(K.collab, this.list);
    if (!quiet) UI.dirty(['library', 'playlist', 'cpl', 'home', 'profile', 'user'], true);
  },
  loadCached() { this.set(U.token ? LS.get(K.collab, []) : [], true); },
  async refresh() {
    if (!U.token || !feat('social') || !feat('collab')) { if (this.list.length) this.set([]); return; }
    try { this.set((await api('/api/social/playlists')).playlists || []); } catch (e) { /* offline: keep the cached copy */ }
  },
  get(id) { return this.byId.get(id) || null; },
  rels(id) { const p = this.byId.get(id); return p ? p.tracks.map(t => t.r) : []; },
  ids(id) { return this.rels(id).map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id); },
  owns(p) { return !!p && p.owner === U.username; },
  person(p, name) { return (p && p.people && p.people[name]) || { username: name, display_name: name, avatar: '' }; },
  async op(id, body) {
    try {
      const p = await api(`/api/social/playlists/${encodeURIComponent(id)}`, body);
      this.set(p.deleted || body.op === 'leave' ? this.list.filter(x => x.id !== id) : this.list.map(x => x.id === id ? p : x));
      return p;
    } catch (e) { UI.toast(e.message); this.refresh(); throw e; }
  },
  local(id, fn) { const p = this.byId.get(id); if (p) { fn(p); this.set(this.list); } },
  add(id, trackIds) {
    const have = new Set(this.rels(id)), rels = uniq(trackIds.map(i => L.tracks[i] && L.tracks[i].rel).filter(r => r && !have.has(r)));
    if (!rels.length) return 0;
    this.local(id, p => { p.tracks.push(...rels.map(r => ({ r, by: U.username, at: now() / 1000 }))); });
    this.op(id, { op: 'add', rels }).catch(() => {});
    return rels.length;
  },
  remove(id, rels) {
    const drop = new Set(rels);
    this.local(id, p => { p.tracks = p.tracks.filter(t => !drop.has(t.r)); });
    return this.op(id, { op: 'remove', rels }).catch(() => {});
  },
  move(id, ids, from, to) {
    const list = ids.map(i => L.tracks[i].rel), rest = list.filter((_, i) => i !== from);
    return this.place(id, list[from], to < rest.length ? rest[to] : null);
  },
  // Put one song right before another (or at the end when `before` is null).
  place(id, rel, before) {
    this.local(id, p => {
      const item = p.tracks.find(t => t.r === rel); if (!item) return;
      p.tracks = p.tracks.filter(t => t !== item);
      const at = before == null ? p.tracks.length : p.tracks.findIndex(t => t.r === before);
      p.tracks.splice(at < 0 ? p.tracks.length : at, 0, item);
    });
    return this.op(id, { op: 'move', rel, before }).catch(() => {});
  },
  async create(name, rels = [], collaborators = []) {
    const p = await api('/api/social/playlists', { name, tracks: rels, collaborators });
    this.set([...this.list, p]);
    return p;
  },
  // Turn one of your own playlists into a collaborative one (it moves to the server; the personal copy goes).
  async fromPersonal(name, collaborators) {
    const p = await this.create(name, (U.playlists[name] || []).slice(), collaborators);
    RECENTS.forEach(r => { if (r.k === 'playlist:' + name) r.k = 'cpl:' + p.id; });
    LS.set(K.recents, RECENTS);
    plDelete(name);
    return p;
  },
};

/* Recently opened / played contexts, and recent searches (both mutated in place). */
const RECENTS = LS.get(K.recents, []);
function touchRecent(k) {
  if (!k) return;
  const next = [{ k, t: now() }, ...RECENTS.filter(r => r.k !== k)].slice(0, 80);
  RECENTS.splice(0, RECENTS.length, ...next);
  LS.set(K.recents, RECENTS);
  UI.dirty(['home', 'library']);
}
const recentTs = k => { const r = RECENTS.find(x => x.k === k); return r ? r.t : 0; };
const SEARCHES = LS.get(K.searches, []);
function rememberSearch(k, key) {
  const next = [{ k, key }, ...SEARCHES.filter(s => !(s.k === k && s.key === key))].slice(0, 20);
  SEARCHES.splice(0, SEARCHES.length, ...next); LS.set(K.searches, SEARCHES);
}
function forgetSearch(k, key) { const i = SEARCHES.findIndex(s => s.k === k && s.key === key); if (i >= 0) SEARCHES.splice(i, 1); LS.set(K.searches, SEARCHES); }
function clearSearches() { SEARCHES.splice(0, SEARCHES.length); LS.set(K.searches, SEARCHES); }

/* ======================================================================
   6. Offline downloads & audio effects
   ====================================================================== */
const Off = {
  set: new Set(), active: new Map(), queue: [], running: 0, ctrl: new Map(), persisted: false,
  async init() {
    if (!('caches' in window)) return;
    try {
      const keys = await (await caches.open(AUDIO_CACHE)).keys();
      for (const k of keys) { const p = new URL(k.url, location.origin).searchParams.get('path'); if (p) this.set.add(p); }
    } catch (e) { /* storage unavailable */ }
  },
  state(rel) { return this.set.has(rel) ? 'done' : (this.active.has(rel) || this.queue.includes(rel)) ? 'busy' : ''; },
  summary(ids) {
    let done = 0, busy = 0, pct = 0;
    for (const id of ids) {
      const r = L.tracks[id].rel;
      if (this.set.has(r)) { done++; pct += 100; } else if (this.active.has(r)) { busy++; pct += this.active.get(r); } else if (this.queue.includes(r)) busy++;
    }
    return { done, busy, total: ids.length, pct: ids.length ? pct / ids.length : 0 };
  },
  enqueue(rels) {
    if (!feat('offline')) { UI.toast('Downloads are turned off on this server'); return 0; }
    if (!('caches' in window)) { UI.toast('Downloads are not supported in this browser'); return 0; }
    const add = rels.filter(r => !this.set.has(r) && !this.active.has(r) && !this.queue.includes(r));
    this.queue.push(...add);
    if (!this.persisted && navigator.storage && navigator.storage.persist) { this.persisted = true; navigator.storage.persist().catch(() => {}); }
    add.forEach(r => dlChanged(r));
    this.save(); this.pump();
    return add.length;
  },
  save() { LS.set(K.dlQueue, this.queue.concat([...this.active.keys()])); },
  pump() {
    while (this.running < 2 && this.queue.length) {
      const rel = this.queue.shift();
      this.running++;
      this.download(rel).finally(() => { this.running--; this.save(); this.pump(); });
    }
  },
  async download(rel) {
    const ctrl = new AbortController();
    this.ctrl.set(rel, ctrl); this.active.set(rel, 1); dlChanged(rel);
    try {
      const res = await fetch(streamUrl(rel), { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = +res.headers.get('Content-Length') || 0, reader = res.body.getReader(), chunks = [];
      let got = 0, lastPct = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (total) { const pct = Math.min(99, Math.round(got / total * 100)); if (pct - lastPct >= 3) { lastPct = pct; this.active.set(rel, pct); dlChanged(rel); } }
      }
      const type = res.headers.get('Content-Type') || 'audio/flac';
      const blob = new Blob(chunks, { type });
      await (await caches.open(AUDIO_CACHE)).put(streamUrl(rel), new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size) } }));
      this.set.add(rel);
    } catch (e) {
      if (e.name !== 'AbortError') {
        const t = L.byRel.get(rel);
        UI.toast(e.name === 'QuotaExceededError' ? 'Your device is out of storage for downloads' : `Download failed${t ? `: ${t.title}` : ''}`);
      }
    } finally {
      this.active.delete(rel); this.ctrl.delete(rel); dlChanged(rel);
      if (!this.active.size && !this.queue.length) UI.dirty(['downloads', 'library']);
    }
  },
  cancel(rels) {
    const s = new Set(rels);
    this.queue = this.queue.filter(r => !s.has(r));
    rels.forEach(r => { const c = this.ctrl.get(r); if (c) c.abort(); dlChanged(r); });
    this.save();
  },
  async remove(rels) {
    this.cancel(rels);
    try {
      const c = await caches.open(AUDIO_CACHE);
      await Promise.all(rels.filter(r => this.set.has(r)).map(r => c.delete(streamUrl(r))));
    } catch (e) { /* ignore */ }
    rels.forEach(r => { this.set.delete(r); dlChanged(r); });
    UI.dirty(['downloads', 'library']);
  },
  async removeAll() {
    this.cancel([...this.queue, ...this.active.keys()]);
    try { await caches.delete(AUDIO_CACHE); } catch (e) { /* ignore */ }
    const rels = [...this.set]; this.set.clear();
    rels.forEach(dlChanged);
    UI.dirty(['downloads', 'library', 'settings'], true);
  },
};
const RING_C = 2 * Math.PI * 6;
const ring = (pct, cls = '') => `<svg class="ring ${cls}" viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="6"/><circle class="fg" cx="8" cy="8" r="6" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${(RING_C * (1 - clamp(pct, 3, 100) / 100)).toFixed(2)}"/></svg>`;
function dlBadge(rel) {
  const st = Off.state(rel);
  if (st === 'done') return `<span class="badge-dl" title="Downloaded">${ic('arrow-dn')}</span>`;
  if (st === 'busy') return ring(Off.active.get(rel) || 0);
  return '';
}
let dlCtxRaf = 0;
function dlChanged(rel) {
  const t = L.byRel.get(rel); if (!t) return;
  $$(`[data-dl="${t.id}"]`).forEach(s => { s.innerHTML = dlBadge(rel); });
  if (!dlCtxRaf) dlCtxRaf = requestAnimationFrame(() => { dlCtxRaf = 0; $$('[data-dlc]').forEach(updateDlButton); });
}
function updateDlButton(b) {
  const ctx = CTX.get(b.dataset.dlc); if (!ctx) return;
  const s = Off.summary(ctx.ids);
  b.classList.toggle('lit', s.total > 0 && s.done === s.total);
  b.innerHTML = s.busy ? ring(s.pct, 'lg') : ic(s.total && s.done === s.total ? 'dl-f' : 'dl');
  b.setAttribute('aria-label', s.busy ? 'Downloading' : s.done === s.total ? 'Downloaded' : 'Download');
}
async function toggleCtxDownload(ctx) {
  const s = Off.summary(ctx.ids), rels = ctx.ids.map(id => L.tracks[id].rel);
  if (s.busy) {
    if (await UI.confirm({ title: 'Stop downloading?', text: `${ctx.name} will stop downloading. Songs already saved stay on this device.`, ok: 'Stop' })) Off.cancel(rels);
  } else if (s.total && s.done === s.total) {
    if (await UI.confirm({ title: 'Remove from downloads?', text: `You won't be able to play ${ctx.name} offline.`, ok: 'Remove', danger: true })) { Off.remove(rels); UI.toast('Removed from downloads'); }
  } else {
    const n = Off.enqueue(rels);
    haptic(12);
    UI.toast(n ? `Downloading ${count(n, 'song')}` : 'Already downloaded');
  }
}

const EQ_BANDS = [60, 150, 400, 1000, 2400, 15000];
const EQ_PRESETS = {
  flat: ['Flat', [0, 0, 0, 0, 0, 0]], bass: ['Bass Booster', [6, 4.5, 2, 0, 0, 0]], bassdown: ['Bass Reducer', [-6, -4, -2, 0, 0, 0]],
  treble: ['Treble Booster', [0, 0, 0, 1.5, 4, 6]], vocal: ['Vocal Booster', [-2, -1, 2, 4, 3, 0]], hiphop: ['Hip-Hop', [5, 4, 1, -1, 1, 3]],
  electronic: ['Electronic', [4.5, 3, 0, -2, 2, 4.5]], rock: ['Rock', [4, 2.5, -1, -1, 2, 4]], pop: ['Pop', [-1, 1.5, 3, 3, 1, -1]],
  acoustic: ['Acoustic', [3, 2, 1, 1.5, 2, 2.5]], loud: ['Loudness', [5, 3, 0, -1, 2.5, 5]], night: ['Late Night', [2.5, 1.5, 0, 0, -1.5, -3]],
};
const eqLabel = () => S.eqOn ? (EQ_PRESETS[S.eqPreset] ? EQ_PRESETS[S.eqPreset][0] : 'Custom') : 'Off';
// Web Audio graph built only when an effect is on; plain <audio> keeps iOS background playback reliable.
// Both decks feed one input node so crossfades pass through the same EQ.
const FX = {
  ctx: null, srcs: [], input: null, eq: [], comp: null, gain: null, limit: null,
  needed() { return S.boost > 1 || S.normalize || (S.eqOn && S.eq.some(v => v)); },
  ensure() {
    if (this.ctx) return true;
    if (!this.needed()) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      const c = this.ctx = new AC();
      this.input = c.createGain();
      this.srcs = D.els.map(el => { const s = c.createMediaElementSource(el); s.connect(this.input); return s; });
      this.eq = EQ_BANDS.map((f, i) => { const b = c.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.05; return b; });
      this.comp = c.createDynamicsCompressor();
      this.comp.threshold.value = -26; this.comp.knee.value = 24; this.comp.ratio.value = 4; this.comp.attack.value = .005; this.comp.release.value = .3;
      this.gain = c.createGain();
      this.limit = c.createDynamicsCompressor();
      this.limit.threshold.value = -1.5; this.limit.knee.value = 0; this.limit.ratio.value = 20; this.limit.attack.value = .002; this.limit.release.value = .12;
      this.apply();
      return true;
    } catch (e) { this.ctx = null; return false; }
  },
  apply() {
    if (!this.ctx) { if (this.needed() && !audio.paused) this.ensure(); return; }
    [this.input, ...this.eq, this.comp, this.gain, this.limit].forEach(n => { try { n.disconnect(); } catch (e) { /* not connected */ } });
    let n = this.input;
    this.eq.forEach((b, i) => { b.gain.value = S.eqOn ? S.eq[i] : 0; n.connect(b); n = b; });
    if (S.normalize) { n.connect(this.comp); n = this.comp; }
    this.gain.gain.value = S.boost * (S.normalize ? 1.35 : 1);
    n.connect(this.gain); n = this.gain;
    if (S.boost > 1 || S.normalize) { n.connect(this.limit); n = this.limit; }
    n.connect(this.ctx.destination);
  },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); },
};
function setBoost(v) {
  S.boost = v; saveS(); FX.apply(); if (v > 1) { FX.ensure(); FX.resume(); }
  UI.toast(v > 1 ? `Volume boost ${Math.round(v * 100)}%` : 'Volume boost off');
  UI.dirty(['settings', 'eq'], true);
}
function toggleNormalize() { S.normalize = !S.normalize; saveS(); FX.apply(); if (S.normalize) { FX.ensure(); FX.resume(); } UI.dirty(['settings', 'eq'], true); }
function toggleEq() { S.eqOn = !S.eqOn; saveS(); FX.apply(); if (S.eqOn) { FX.ensure(); FX.resume(); } UI.dirty(['eq', 'settings'], true); }
function setEqPreset(k) { if (!EQ_PRESETS[k]) return; S.eqPreset = k; S.eq = EQ_PRESETS[k][1].slice(); S.eqOn = true; saveS(); FX.ensure(); FX.apply(); FX.resume(); UI.dirty(['eq', 'settings'], true); }
function setEqBand(i, db) { S.eq[i] = db; S.eqPreset = 'custom'; FX.apply(); saveSSoon(); }

/* ======================================================================
   7. Player engine
   ====================================================================== */
// Two decks let the next song buffer before the current one ends (gapless) and overlap (crossfade).
// iOS only allows the element a user tapped to play, so it keeps a single deck.
const D = {
  els: [byId('audio'), IOS ? null : byId('audio2')].filter(Boolean),
  i: 0, fade: [1, 1], blob: [null, null], ready: null, preparing: null, prepSeq: 0, xf: null,
  get a() { return this.els[this.i]; },
  get b() { return this.els.length > 1 ? this.els[1 - this.i] : null; },
};
// `audio` always means the active deck.
const audio = new Proxy({}, {
  get(_, k) { const el = D.a; const v = el[k]; return typeof v === 'function' ? v.bind(el) : v; },
  set(_, k, v) { D.a[k] = v; return true; },
});
const P = {
  ctx: null, order: [], pos: -1, queue: [], cur: null, fromQueue: false, shuffle: !!S.shuffle, repeat: S.repeat | 0,
  pending: null, seekTo: 0, listened: 0, lastT: 0, counted: false, scrobbled: false, startedAt: 0, errors: 0, seq: 0, everPlayed: false, dur: 0,
};
const CTX = new Map();
let ctxSeq = 0;
function makeCtx(type, ref, name, ids, recent) { return { type, ref, name, ids, key: type + ':' + ref, recent, rid: '' }; }
function regCtx(ctx) { ctx.rid = 'c' + (++ctxSeq); CTX.set(ctx.rid, ctx); return ctx; }
const curTrack = () => (P.cur != null ? L.tracks[P.cur] : null);
const ctxPlaying = ctx => !!(ctx && P.ctx && P.ctx.key === ctx.key);
const isPlaying = () => !audio.paused && !P.pending;

function applyVolume() {
  const base = S.muted ? 0 : clamp(+S.volume || 0, 0, 1);
  D.els.forEach((el, i) => { el.volume = clamp(base * D.fade[i] * SL.fade, 0, 1); });
}
function setVolume(v) { S.volume = clamp(v, 0, 1); if (S.volume > 0) S.muted = false; applyVolume(); saveSSoon(); UI.volume(); }
function toggleMute() { S.muted = !S.muted; if (!S.muted && S.volume < .02) S.volume = .5; applyVolume(); saveSSoon(); UI.volume(); }

function buildOrder(len, start) {
  const idx = Array.from({ length: len }, (_, i) => i);
  if (!P.shuffle) return { order: idx, pos: clamp(start, 0, len - 1) };
  const first = start >= 0 ? start : Math.floor(Math.random() * len);
  return { order: [first, ...shuffled(idx.filter(i => i !== first))], pos: 0 };
}
function playCtx(ctx, start = -1, opts = {}) {
  if (!ctx || !ctx.ids.length) { UI.toast('Nothing to play here yet'); return; }
  if (opts.shuffle != null && opts.shuffle !== P.shuffle) setShuffle(opts.shuffle, true);
  P.ctx = { type: ctx.type, ref: ctx.ref, name: ctx.name, ids: ctx.ids.slice(), key: ctx.key, recent: ctx.recent };
  const o = buildOrder(ctx.ids.length, start < 0 && !P.shuffle ? 0 : start);
  P.order = o.order; P.pos = o.pos; P.fromQueue = false;
  load(P.ctx.ids[P.order[P.pos]], true);
  if (ctx.recent) touchRecent(ctx.recent);
  UI.queue();
}
function playTrackAlone(id) {
  const t = L.tracks[id]; if (!t) return;
  const al = albumOf(t);
  playCtx(makeCtx('album', al.key, al.title, al.trackIds, 'album:' + al.key), al.trackIds.indexOf(id));
}
// Work out the audio source for a track: the offline copy when there is one, otherwise the stream.
async function resolveSrc(t, forPlayNow) {
  const url = streamUrl(t.rel);
  const cached = Off.set.has(t.rel);
  // iOS only unlocks <audio> for play() inside the tap itself, so the very first play skips the async cache read when online.
  if (cached && (P.everPlayed || !navigator.onLine || !forPlayNow)) {
    try {
      const m = await (await caches.open(AUDIO_CACHE)).match(url);
      if (m) return { src: URL.createObjectURL(await m.blob()), blob: true };
    } catch (e) { /* fall back to streaming */ }
  } else if (!cached && !navigator.onLine) return null;
  return { src: playUrl(t.rel), blob: false };
}
function setDeckSrc(i, r) {
  if (D.blob[i]) URL.revokeObjectURL(D.blob[i]);
  D.blob[i] = r && r.blob ? r.src : null;
  const el = D.els[i];
  if (r) el.src = r.src; else { el.removeAttribute('src'); el.load(); }
}
async function load(id, autoplay, seek = 0) {
  const t = L.tracks[id]; if (!t) return;
  const seq = ++P.seq;
  const prepared = D.ready && D.ready.id === id && !seek ? D.ready.deck : -1;
  P.cur = id; P.pending = null; P.listened = 0; P.lastT = 0; P.counted = false; P.scrobbled = false; P.startedAt = Math.floor(Date.now() / 1000); P.seekTo = seek > 0 ? seek : 0; P.dur = 0;
  if (prepared >= 0) {
    // The next song is already buffered on the other deck (gapless), or already fading in (crossfade).
    const old = D.i;
    D.ready = null; D.i = prepared;
    if (!D.xf) { D.els[old].pause(); setDeckSrc(old, null); D.fade[D.i] = 1; }
    applyVolume();
    trackChanged();
    P.dur = D.a.duration || 0; P.lastT = D.a.currentTime || 0;
    if (autoplay && D.a.paused) play(); else syncPlayState();
    UI.progress(true); setPositionState();
    saveState();
    return;
  }
  endCrossfade(true); dropPrepared();
  trackChanged();
  const r = await resolveSrc(t, autoplay);
  if (seq !== P.seq) { if (r && r.blob) URL.revokeObjectURL(r.src); return; }
  if (!r) {
    UI.toast(`"${t.title}" isn't downloaded`);
    if (autoplay && P.errors++ < L.tracks.length) setTimeout(() => next(true, true), 300);
    return;
  }
  setDeckSrc(D.i, r);
  if (autoplay) play(); else D.a.load();
  saveState();
}
function play() {
  if (P.pending) { const { id, t } = P.pending; load(id, true, t); return; }
  if (P.cur == null) { shuffleAll(); return; }
  if (FX.needed()) FX.ensure();
  FX.resume();
  const pr = D.a.play();
  if (pr) pr.catch(err => {
    if (err.name === 'NotAllowedError') UI.toast('Tap play to start listening');
    else if (err.name !== 'AbortError') console.warn('play()', err);
  });
}
function pause() { endCrossfade(true); D.a.pause(); }
function togglePlay() { haptic(); if (audio.paused || P.pending) play(); else pause(); }
function shuffleAll() {
  if (!L.tracks.length) return;
  playCtx(makeCtx('library', 'all', 'Your Library', L.tracks.map(t => t.id)), -1, { shuffle: true });
  UI.toast('Shuffling your whole library');
}
function next(auto = false, fromError = false) {
  if (auto && !fromError && P.repeat === 2) { audio.currentTime = 0; play(); return; }
  if (P.queue.length) { P.fromQueue = true; load(P.queue.shift(), true); UI.queue(); return; }
  if (!P.ctx) return;
  let np = P.pos + (P.fromQueue ? 0 : 1);
  if (P.fromQueue) { P.fromQueue = false; np = P.pos + 1; }
  if (np >= P.order.length) {
    if (P.repeat === 1) { if (P.shuffle) P.order = shuffled(P.order); np = 0; }
    else if (S.autoplay && P.cur != null) { startAutoplay(); return; }
    else { pause(); audio.currentTime = 0; UI.toast(`End of ${P.ctx.name}`); return; }
  }
  P.pos = np;
  load(P.ctx.ids[P.order[np]], true);
  UI.queue();
}
function prev() {
  haptic();
  if (audio.currentTime > 3 || !P.ctx) { audio.currentTime = 0; return; }
  if (P.fromQueue) { P.fromQueue = false; load(P.ctx.ids[P.order[P.pos]], true); UI.queue(); return; }
  if (P.pos > 0) P.pos--;
  else if (P.repeat === 1) P.pos = P.order.length - 1;
  else { audio.currentTime = 0; return; }
  load(P.ctx.ids[P.order[P.pos]], true);
  UI.queue();
}
function startAutoplay() {
  const seed = P.cur, played = new Set(P.ctx ? P.ctx.ids : []);
  const ids = radioIds(seed, 40, played).slice(1);
  if (!ids.length) { pause(); return; }
  const t = L.tracks[seed];
  P.ctx = makeCtx('mix', 'radio:' + t.rel, 'Autoplay', ids);
  P.order = ids.map((_, i) => i); P.pos = 0; P.fromQueue = false;
  load(ids[0], true);
  UI.toast('Autoplay: similar songs are up next');
  UI.queue();
}
function setShuffle(on, silent) {
  P.shuffle = on; S.shuffle = on; saveS();
  if (P.ctx) {
    const cur = P.order[P.pos], idx = P.ctx.ids.map((_, i) => i);
    if (on) { P.order = [cur, ...shuffled(idx.filter(i => i !== cur))]; P.pos = 0; }
    else { P.order = idx; P.pos = cur; }
  }
  if (!silent) { haptic(); UI.toast(on ? 'Shuffle on' : 'Shuffle off'); }
  updateModes(); UI.queue(); saveState();
}
function cycleRepeat() {
  P.repeat = (P.repeat + 1) % 3; S.repeat = P.repeat; saveS();
  haptic(); UI.toast(['Repeat off', 'Repeating this list', 'Repeating this song'][P.repeat]);
  updateModes(); saveState();
}
function addToQueue(ids, playNext) {
  ids = ids.filter(id => L.tracks[id]);
  if (!ids.length) return;
  if (playNext) P.queue.unshift(...ids); else P.queue.push(...ids);
  if (P.cur == null) {
    // Nothing loaded yet: stage the first queued song instead of blasting it.
    const id = P.queue.shift();
    P.cur = id; P.pending = { id, t: 0 }; P.fromQueue = true; P.dur = 0;
    trackChanged(); UI.progress(true);
  }
  haptic(10);
  UI.toast(ids.length === 1 ? (playNext ? `"${L.tracks[ids[0]].title}" plays next` : 'Added to queue') : `${count(ids.length, 'song')} added to queue`);
  UI.queue(); saveState();
}
function upcoming(n) {
  const out = [];
  if (!P.ctx) return out;
  for (let p = P.pos + 1; p < P.order.length && out.length < n; p++) out.push({ id: P.ctx.ids[P.order[p]], pos: p });
  return out;
}
function queueJump(i) { const id = P.queue.splice(0, i + 1).pop(); if (id == null) return; P.fromQueue = true; load(id, true); UI.queue(); }
function ctxJump(pos) { if (!P.ctx || pos < 0 || pos >= P.order.length) return; P.pos = pos; P.fromQueue = false; load(P.ctx.ids[P.order[pos]], true); UI.queue(); }
function queueRemove(i) { P.queue.splice(i, 1); UI.queue(); saveState(); }
function queueMove(from, to) { const [m] = P.queue.splice(from, 1); P.queue.splice(to, 0, m); UI.queue(); saveState(); }
function queueClear() { P.queue = []; UI.queue(); saveState(); UI.toast('Queue cleared'); }
function seek(sec) {
  if (P.pending) { P.pending.t = sec; UI.progress(true); return; }
  endCrossfade(true);
  if (isFinite(audio.duration)) audio.currentTime = clamp(sec, 0, audio.duration);
}

/* Gapless & crossfade */
// Which song would next(true) pick, without changing any state.
function peekNext() {
  if (P.repeat === 2) return null;
  if (P.queue.length) return P.queue[0];
  if (!P.ctx) return null;
  const np = P.pos + 1;
  if (np < P.order.length) return P.ctx.ids[P.order[np]];
  if (P.repeat === 1 && !P.shuffle) return P.ctx.ids[P.order[0]];
  return null;
}
function dropPrepared() {
  D.prepSeq++; D.preparing = null;
  if (D.ready && !D.xf && D.ready.deck !== D.i) setDeckSrc(D.ready.deck, null);
  D.ready = null;
}
async function prepareNext() {
  if (!D.b || D.xf) return;
  const id = peekNext();
  // Reading a downloaded song from Cache Storage can outlast several timeupdates: don't restart it.
  if (id == null || (D.ready && D.ready.id === id) || D.preparing === id) return;
  dropPrepared();
  D.preparing = id;
  const seq = D.prepSeq, t = L.tracks[id];
  const r = await resolveSrc(t, false);
  if (seq !== D.prepSeq || !r) { if (r && r.blob) URL.revokeObjectURL(r.src); return; }
  D.preparing = null;
  const bi = 1 - D.i;
  setDeckSrc(bi, r);
  D.els[bi].preload = 'auto';
  D.els[bi].load();
  D.ready = { id, deck: bi };
}
function startCrossfade() {
  const to = D.ready.deck, from = D.i, el = D.els[to];
  D.xf = { from, to, t0: now(), dur: S.crossfade * 1000, iv: 0 };
  D.fade[to] = 0; applyVolume();
  try { el.currentTime = 0; } catch (e) { /* not seekable yet */ }
  const pr = el.play(); if (pr) pr.catch(() => endCrossfade(true));
  // Timers keep running in background tabs, unlike requestAnimationFrame.
  D.xf.iv = setInterval(() => {
    const x = D.xf; if (!x) return;
    const p = clamp((now() - x.t0) / x.dur, 0, 1);
    D.fade[x.from] = Math.cos(p * Math.PI / 2); D.fade[x.to] = Math.sin(p * Math.PI / 2);
    applyVolume();
    if (p >= 1) endCrossfade(false);
  }, 50);
  next(true);   // loads the prepared deck, which is already playing
}
// Finish (or cut short) a crossfade: silence the outgoing deck.
function endCrossfade(abort) {
  const x = D.xf; if (!x) return;
  clearInterval(x.iv); D.xf = null;
  const old = D.els[x.from];
  if (x.from !== D.i) { old.pause(); setDeckSrc(x.from, null); }
  D.fade = [1, 1];
  if (abort && x.to !== D.i && D.ready) D.ready = null;
  applyVolume();
}

/* Sleep timer */
const SL = { end: 0, eot: false, iv: 0, fade: 1 };
function setSleep(min) {
  clearInterval(SL.iv); SL.end = 0; SL.eot = false; SL.fade = 1; applyVolume();
  if (min === 'eot') { SL.eot = true; UI.toast('Sleep timer: stops at the end of this song'); }
  else if (min > 0) {
    SL.end = now() + min * 60000;
    SL.iv = setInterval(sleepTick, 1000);
    UI.toast(`Sleep timer set for ${min >= 60 ? count(min / 60, 'hour') : min + ' min'}`);
  } else UI.toast('Sleep timer off');
  updateSleepUi();
}
function sleepTick() {
  const left = SL.end - now();
  if (left <= 0) { clearInterval(SL.iv); SL.end = 0; pause(); SL.fade = 1; applyVolume(); UI.toast('Sleep timer ended — sweet dreams'); updateSleepUi(); return; }
  if (left < 12000) { SL.fade = clamp(left / 12000, 0.05, 1); applyVolume(); }   // gentle fade (ignored on iOS)
  updateSleepUi();
}
const sleepLabel = () => SL.eot ? 'End of song' : SL.end ? fmt((SL.end - now()) / 1000) + ' left' : 'Off';
function updateSleepUi() {
  $$('[data-sleep-btn]').forEach(b => b.classList.toggle('lit', !!(SL.end || SL.eot)));
  $$('[data-sleep-val]').forEach(e => { e.textContent = sleepLabel(); });
  UI.sleep();
}

/* Persist the session so a reload or app switch resumes where you left off. */
let lastSave = 0;
function saveState(force = true) {
  const t = curTrack();
  if (!t || (!force && now() - lastSave < 8000)) return;
  lastSave = now();
  const c = P.ctx;
  LS.set(K.playback, {
    v: 2, cur: t.rel, t: P.pending ? P.pending.t : (audio.currentTime || 0), dur: audio.duration || P.dur || 0,
    ctx: c ? { type: c.type, ref: c.ref, name: c.name, recent: c.recent, rels: c.ids.length <= 3000 ? c.ids.map(id => L.tracks[id].rel) : null } : null,
    order: c && P.shuffle && c.ids.length <= 3000 ? P.order : null, pos: P.pos, fromQueue: P.fromQueue,
    queue: P.queue.slice(0, 300).map(id => L.tracks[id].rel),
  });
}
function restoreState() {
  const st = LS.get(K.playback, null);
  if (!st || !st.cur) return;
  const t = L.byRel.get(st.cur);
  if (!t) return;
  if (st.ctx) {
    let ids = null;
    if (st.ctx.rels) ids = st.ctx.rels.map(r => L.byRel.get(r)).filter(Boolean).map(x => x.id);
    else if (st.ctx.type === 'library') ids = L.tracks.map(x => x.id);
    if (ids && ids.length) {
      P.ctx = makeCtx(st.ctx.type, st.ctx.ref, st.ctx.name, ids, st.ctx.recent);
      const ok = Array.isArray(st.order) && st.order.length === ids.length;
      P.order = ok ? st.order : ids.map((_, i) => i);
      const at = ids.indexOf(t.id);
      P.pos = ok ? clamp(st.pos | 0, 0, ids.length - 1) : Math.max(0, at);
      if (P.ctx.ids[P.order[P.pos]] !== t.id && at >= 0 && !st.fromQueue) P.pos = Math.max(0, P.order.indexOf(at));
      P.fromQueue = !!st.fromQueue;
    }
  }
  P.queue = (st.queue || []).map(r => L.byRel.get(r)).filter(Boolean).map(x => x.id);
  P.cur = t.id; P.pending = { id: t.id, t: st.t || 0 }; P.dur = st.dur || 0;
  trackChanged();
  UI.progress(true);
}
// Stage a song (paused) with its album as context — used for share links and Connect hand-offs.
function stageTrack(t, at = 0, autoplay = false) {
  const al = albumOf(t);
  P.ctx = makeCtx('album', al.key, al.title, al.trackIds.slice(), 'album:' + al.key);
  const o = buildOrder(al.trackIds.length, al.trackIds.indexOf(t.id));
  P.order = o.order; P.pos = o.pos; P.fromQueue = false;
  if (autoplay) { load(t.id, true, at); return; }
  P.cur = t.id; P.pending = { id: t.id, t: at }; P.dur = 0;
  trackChanged(); UI.progress(true);
}

/* UI state shared by both views: which row is playing, play/pause icons, like buttons, modes. */
function trackChanged() {
  const t = curTrack();
  $$('.trk.playing').forEach(r => r.classList.remove('playing'));
  if (t) {
    $$(`.trk[data-t="${t.id}"]`).forEach(r => r.classList.add('playing'));
    document.title = `${t.title} • ${t.artist}`;
    refreshLike(t.id);
    const c = P.ctx;
    $$('[data-ck]').forEach(n => n.classList.toggle('ctx-playing', !!(c && n.dataset.ck === c.recent)));
    updateMediaSession(t);
    loadLyricsSoon(t);
  } else document.title = SITE.site_title || 'Axdio';
  updatePlayButtons(); updateModes();
  UI.track(t);
}
function refreshLike(id) {
  const t = L.tracks[id]; if (!t) return;
  const on = U.likedSet.has(t.rel);
  const label = on ? 'Remove from Liked Songs' : 'Add to Liked Songs';
  const set = b => { b.classList.toggle('liked', on); setUse(b, on ? 'heart-f' : 'heart'); b.setAttribute('aria-label', label); if (b.dataset.tip != null) b.dataset.tip = label; };
  $$(`[data-act="like"][data-t="${id}"]`).forEach(set);
  if (P.cur === id) $$('[data-act="like-cur"]').forEach(set);
  UI.like(id, on);
}
function updatePlayButtons() {
  const playing = isPlaying();
  document.body.classList.toggle('is-playing', playing);
  $$('[data-pp]').forEach(svg => setUse(svg, playing ? 'pause' : 'play'));
  $$('[data-pc]').forEach(b => { const on = ctxPlaying(CTX.get(b.dataset.pc)) && playing; setUse(b, on ? 'pause' : 'play'); b.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
  $$('[data-act="toggle"]').forEach(b => b.setAttribute('aria-label', playing ? 'Pause' : 'Play'));
  UI.playState(playing);
}
function updateModes() {
  $$('[data-shuf]').forEach(b => b.classList.toggle('on', P.shuffle));
  $$('[data-rep]').forEach(b => { b.classList.toggle('on', P.repeat > 0); b.classList.toggle('rep-2', P.repeat === 2); });
  UI.modes();
}
let progRaf = 0;
function progLoop() { UI.progress(false); syncLyrics(); progRaf = !audio.paused && !document.hidden ? requestAnimationFrame(progLoop) : 0; }
function syncPlayState() {
  updatePlayButtons();
  if (!audio.paused) { if (!progRaf) progLoop(); P.everPlayed = true; }
  syncMediaSession();
}

/* ======================================================================
   8. Lyrics, media session, Connect & boot
   ====================================================================== */
const LY = { rel: null, lines: [], synced: false, idx: -1, state: 'idle', timer: 0 };
function loadLyricsSoon(t) {
  clearTimeout(LY.timer);
  if (LY.rel === t.rel) return;
  LY.rel = t.rel; LY.lines = []; LY.idx = -1; LY.synced = false; LY.state = 'loading';
  UI.lyrics();
  LY.timer = setTimeout(() => loadLyrics(t), 350);
}
async function loadLyrics(t) {
  if (!feat('lyrics')) { LY.state = 'none'; UI.lyrics(); return; }
  try {
    const q = new URLSearchParams({ artist: artistOf(t).name, title: t.title, album: albumOf(t).name, path: t.rel });
    const d = await (await fetch('/api/lyrics?' + q)).json();
    if (LY.rel !== t.rel) return;
    if (d.synced) {
      const tag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, lines = [];
      String(d.synced).split(/\r?\n/).forEach(l => {
        const text = l.replace(tag, '').trim();
        for (const m of l.matchAll(tag)) lines.push({ t: +m[1] * 60 + +m[2] + (m[3] ? +m[3].padEnd(3, '0').slice(0, 3) / 1000 : 0), text: text || '♪' });
      });
      lines.sort((a, b) => a.t - b.t);
      LY.lines = lines; LY.synced = lines.length > 0; LY.state = lines.length ? 'ok' : 'none';
    } else if (d.plain) { LY.lines = String(d.plain).split(/\r?\n/).map(text => ({ t: 0, text })); LY.synced = false; LY.state = 'ok'; }
    else LY.state = 'none';
  } catch (e) { if (LY.rel === t.rel) LY.state = navigator.onLine ? 'error' : 'offline'; }
  if (LY.rel === t.rel) { LY.idx = -1; UI.lyrics(); syncLyrics(true); }
}
const lyMsg = () => ({ loading: 'Loading lyrics…', none: "Lyrics aren't available for this song.", error: "Couldn't load lyrics.", offline: 'Lyrics need a connection.' }[LY.state] || '');
function syncLyrics(force) {
  if (!LY.synced || !LY.lines.length) return;
  const cur = (P.pending ? P.pending.t : audio.currentTime) + .25;
  let i = LY.idx;
  if (i < 0 || i >= LY.lines.length || LY.lines[i].t > cur || (LY.lines[i + 1] && LY.lines[i + 1].t <= cur)) {
    i = -1;
    let lo = 0, hi = LY.lines.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (LY.lines[m].t <= cur) { i = m; lo = m + 1; } else hi = m - 1; }
  }
  if (i === LY.idx && !force) return;
  LY.idx = i;
  UI.lyricLine(i, !!force);
}

/* Media Session: notification shade, lock screen, headphones, car controls */
function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !t) return;
  try {
    const al = albumOf(t);
    // Android can't draw the SVG placeholder the server returns for missing art, so fall back to the PNG app icon.
    const src = t.hc ? coverUrl(t.rel) : al.hc ? coverUrl(al.cover) : '';
    const artwork = src
      ? [96, 256, 512].map(s => ({ src: location.origin + src, sizes: `${s}x${s}`, type: 'image/jpeg' }))
      : [{ src: location.origin + '/api/app-icon', sizes: '512x512', type: 'image/png' }];
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: al.title, artwork });
  } catch (e) { /* unsupported */ }
}
function setPositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: clamp(audio.currentTime, 0, d) }); } catch (e) { /* ignore */ }
}
function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* unsupported action */ } };
  set('play', play); set('pause', pause); set('stop', pause);
  set('previoustrack', prev); set('nexttrack', () => next());
  set('seekto', d => { if (d.fastSeek && D.a.fastSeek) D.a.fastSeek(d.seekTime); else seek(d.seekTime); setPositionState(); });
  set('seekbackward', d => { seek(audio.currentTime - (d.seekOffset || 10)); setPositionState(); });
  set('seekforward', d => { seek(audio.currentTime + (d.seekOffset || 10)); setPositionState(); });
}
// Re-assert everything whenever playback (re)starts: the OS notification is built from this state,
// and some Android builds rebuild the session when a new media source starts.
function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = curTrack();
  if (t) updateMediaSession(t);
  try { navigator.mediaSession.playbackState = isPlaying() ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
  bindMediaSession();
  setPositionState();
}

/* Audio element events: only the active deck drives the UI. */
D.els.forEach((el, i) => {
  const active = () => D.els[D.i] === el;
  el.addEventListener('play', () => { if (!active()) return; updatePlayButtons(); if (!progRaf) progLoop(); syncMediaSession(); nowPlaying('STREAMING'); });
  el.addEventListener('pause', () => { if (!active()) return; updatePlayButtons(); saveState(); syncMediaSession(); nowPlaying('PAUSED'); });
  el.addEventListener('seeked', () => { if (active() && !el.paused) { npLast = 0; nowPlaying('STREAMING'); } });
  el.addEventListener('playing', () => { if (!active()) return; document.body.classList.remove('buffering'); P.errors = 0; P.everPlayed = true; syncMediaSession(); });
  el.addEventListener('waiting', () => { if (active()) document.body.classList.add('buffering'); });
  el.addEventListener('canplay', () => { if (active()) document.body.classList.remove('buffering'); });
  el.addEventListener('loadedmetadata', () => {
    if (!active()) return;
    P.dur = el.duration;
    if (P.seekTo) { el.currentTime = Math.min(P.seekTo, el.duration - 1); P.seekTo = 0; }
    UI.progress(true); setPositionState();
  });
  el.addEventListener('seeked', () => { if (active()) setPositionState(); });
  el.addEventListener('timeupdate', () => {
    if (!active()) return;
    const t = el.currentTime, d = t - P.lastT;
    if (d > 0 && d < 2) P.listened += d;
    P.lastT = t;
    const cur = curTrack();
    if (cur && !P.counted && P.listened >= Math.min(30, (el.duration || 60) * .5)) { P.counted = true; recordPlay(cur); }
    // Scrobbling services count a listen after half the song or 4 minutes (songs over 30 s only).
    if (cur && !P.scrobbled && U.token && el.duration > 30 && P.listened >= Math.min(240, el.duration * .5)) {
      P.scrobbled = true;
      if (feat('scrobbling')) api('/api/user/scrobble', { rel_path: cur.rel, started_at: P.startedAt }).catch(() => {});
    }
    if (document.hidden) syncLyrics();
    saveState(false);
    // Buffer the next song on the spare deck near the end, then crossfade into it.
    const left = (el.duration || 0) - t;
    if (D.b && isFinite(left) && left > 0) {
      if (D.ready && D.ready.id !== peekNext() && !D.xf) dropPrepared();
      if ((S.gapless || S.crossfade > 0) && left < Math.max(20, S.crossfade + 12)) prepareNext();
      if (S.crossfade > 0 && !D.xf && D.ready && D.ready.id === peekNext() && left <= S.crossfade && left > .4
        && el.duration > S.crossfade * 3 && !SL.eot && !el.paused) startCrossfade();
    }
  });
  el.addEventListener('ended', () => {
    if (!active()) return;
    nowPlaying('IDLE');
    if (SL.eot) { SL.eot = false; updateSleepUi(); UI.toast('Sleep timer ended — sweet dreams'); el.currentTime = 0; return; }
    next(true);
  });
  el.addEventListener('error', () => {
    if (!active()) { if (D.ready && D.ready.deck === i) D.ready = null; return; }
    if (!el.getAttribute('src')) return;
    document.body.classList.remove('buffering');
    const t = curTrack();
    if (++P.errors >= 4) { UI.toast('Playback stopped — several songs failed to load'); return; }
    UI.toast(`Couldn't play ${t ? `"${t.title}"` : 'this song'} — skipping`);
    setTimeout(() => next(true, true), 900);
  });
});
// Admin dashboard "now playing" feed
let npLast = 0;
function nowPlaying(status) {
  const t = curTrack(); if (!t) return;
  if (status === 'STREAMING' && now() - npLast < 4000) return;
  npLast = now();
  fetch('/api/player/now_playing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t.rel.split('/').pop(), src: streamUrl(t.rel), status, pos: audio.currentTime || 0 }) }).catch(() => {});
}
setInterval(() => { if (!audio.paused) nowPlaying('STREAMING'); }, 15000);

/* Connect: device presence + playback hand-off between phones and computers */
const Connect = {
  id: LS.raw(K.device) || '',
  name: '',
  platform: 'mobile',
  defaultName() {
    const ua = navigator.userAgent;
    const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
    if (this.platform === 'desktop') {
      const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Desktop';
      return `${os} desktop (${br})`;
    }
    const dev = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : 'Phone';
    return `${dev} (${br})`;
  },
  init(platform) {
    this.platform = platform || this.platform;
    if (!this.id) { this.id = 'dev_' + Math.random().toString(36).slice(2, 11); LS.setRaw(K.device, this.id); }
    this.name = S.deviceName || this.defaultName();
    if (!feat('connect')) return;
    this.beat();
    setInterval(() => { if (!document.hidden || !audio.paused) this.beat(); }, 5000);
  },
  rename(n) { S.deviceName = n; this.name = n || this.defaultName(); saveS(); this.beat(); },
  async beat() {
    if (!this.id) return;
    const t = curTrack();
    try {
      const d = await api('/api/devices/heartbeat', { device_id: this.id, device_name: this.name, state: { playing: !audio.paused, rel_path: t ? t.rel : '', currentTime: audio.currentTime || 0, volume: S.volume } });
      if (d.sv != null && window.AX.Social) window.AX.Social.nudge(d.sv);
      const cmd = d.command;
      if (cmd && cmd.type === 'transfer_playback' && cmd.playback && cmd.playback.rel_path) {
        const tr = L.byRel.get(cmd.playback.rel_path);
        if (!tr) return;
        stageTrack(tr, cmd.playback.currentTime || 0, cmd.playback.playing !== false);
        UI.toast('Playback moved to this device');
      }
    } catch (e) { /* offline */ }
  },
  async list() { try { return (await api('/api/devices/list')).devices || []; } catch (e) { return null; } },
  async transfer(id, name) {
    const t = curTrack();
    if (!t) { UI.toast('Play something first'); return false; }
    try {
      const d = await api('/api/devices/transfer', { target_device_id: id, playback: { playing: true, rel_path: t.rel, currentTime: audio.currentTime || (P.pending ? P.pending.t : 0) } });
      if (!d.success) throw new Error(d.error || 'Device unreachable');
      pause();
      UI.remote(name);
      UI.toast(`Playing on ${name}`);
      return true;
    } catch (e) { UI.toast(`Couldn't connect to ${name}`); return false; }
  },
};

/* Share links: /track/<id>, /album/<id>, /artist/<id> open a page with link previews and a player.
   An id is the 64-bit FNV-1a hash of the item's key in base62, the same as server.py's share_id(),
   so a link is ready the moment someone taps Share. */
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function shareId(kind, ref) {
  const M = BigInt('0xffffffffffffffff'), FNV = BigInt('0x100000001b3'), N = BigInt(62);
  let h = BigInt('0xcbf29ce484222325'), out = '';
  for (const b of new TextEncoder().encode(kind + '\0' + ref)) h = ((h ^ BigInt(b)) * FNV) & M;
  for (let i = 0; i < 11; i++) { out = B62[Number(h % N)] + out; h /= N; }
  return out;
}
const trackLink = t => '/track/' + shareId('t', t.rel);
const albumLink = al => '/album/' + shareId('a', al.key);
const artistLink = ar => '/artist/' + shareId('r', ar.key);

async function share(title, text, path) {
  if (!feat('sharing')) { UI.toast('Sharing is turned off on this server'); return; }
  const url = (SITE.public_url || location.origin) + path;
  try {
    if (navigator.share && Connect.platform === 'mobile') { await navigator.share({ title, text, url }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); UI.toast('Link copied to clipboard'); }
  catch (e) { UI.toast("Couldn't copy the link"); }
}

/* Online / offline */
function setOnline() {
  const off = !navigator.onLine;
  document.body.classList.toggle('is-offline', off);
  $$('.trk[data-t]').forEach(r => { const t = L.tracks[+r.dataset.t]; if (t) r.classList.toggle('off', off && !Off.set.has(t.rel)); });
  UI.online(off);
}
window.addEventListener('online', setOnline);
window.addEventListener('offline', () => { setOnline(); UI.toast("You're offline — downloads still play"); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveState();
  else { if (!audio.paused && !progRaf) progLoop(); UI.progress(true); }
});
window.addEventListener('pagehide', () => saveState());

/* Shared view helpers: the item model behind cards, rows and tiles in both UIs */
function avatarHtml(cls = '') {
  const init = esc((U.name || U.username || '?').trim().charAt(0).toUpperCase() || '?');
  const safe = /^(https?:|data:image\/|\/)/i.test(U.avatar || '');
  return `<span class="avatar ${cls}" data-i="${U.token ? init : ''}">${U.avatar && safe ? img(U.avatar) : U.token ? init : ic('person', 'md')}</span>`;
}
function itAlbum(al) { return { k: 'album', id: al.id, title: al.title, sub: `${al.type} • ${albumArtist(al)}`, cover: img(coverUrl(al.cover)), ck: 'album:' + al.key, ts: al.mtime, ids: al.trackIds }; }
function itArtist(ar) { return { k: 'artist', id: ar.id, title: ar.name, sub: 'Artist', cover: img(coverUrl(ar.cover)), circle: true, ck: 'artist:' + ar.key, ts: ar.mtime }; }
function itPlaylist(name) {
  const rels = U.playlists[name] || [];
  return { k: 'playlist', id: name, title: name, sub: `Playlist • ${U.name || 'You'} • ${count(rels.length, 'song')}`, cover: plCover(rels), ck: 'playlist:' + name, ts: 0 };
}
function itCollab(p) {
  const rels = p.tracks.map(t => t.r), others = [p.owner, ...p.collaborators].filter(n => n !== U.username).length;
  return { k: 'cpl', id: p.id, title: p.name, sub: `Playlist • ${others ? `You + ${count(others, 'other')}` : 'Collaborative'} • ${count(rels.length, 'song')}`,
    cover: plCover(rels), ck: 'cpl:' + p.id, ts: 0, collab: true };
}
// Search results list playlists as { k, name } / { k, id }.
function itSearchPl(x) {
  if (x.k === 'playlist') return itPlaylist(x.name);
  if (x.k === 'cpl') { const p = Collab.get(x.id); return p ? itCollab(p) : null; }
  const m = getMix(x.id); return m ? itMix(m) : null;
}
function itLiked() { return { k: 'liked', id: '', title: 'Liked Songs', sub: `Playlist • ${count(U.liked.length, 'song')}`, cover: `<div class="cover-glyph liked-art">${ic('heart-f')}</div>`, ck: 'liked', pinned: true }; }
function itDownloads() { return { k: 'downloads', id: '', title: 'Downloads', sub: `${count(Off.set.size, 'song')} on this device`, cover: `<div class="cover-glyph dl-art">${ic('dl-f')}</div>`, ck: 'downloads', pinned: true }; }
function itMix(m) { return { k: 'mix', id: m.id, title: m.name, sub: m.desc, cover: mixCover(m), ck: 'mix:' + m.id }; }
function itFromKey(k) {
  const i = k.indexOf(':'), kind = i < 0 ? k : k.slice(0, i), ref = i < 0 ? '' : k.slice(i + 1);
  if (kind === 'album') { const al = L.albumByKey.get(ref); return al ? itAlbum(al) : null; }
  if (kind === 'artist') { const ar = L.artistByKey.get(ref); return ar && ar.trackIds.length ? itArtist(ar) : null; }
  if (kind === 'playlist') return U.playlists[ref] ? itPlaylist(ref) : null;
  if (kind === 'cpl') { const p = Collab.get(ref); return p ? itCollab(p) : null; }
  if (kind === 'mix') { const m = getMix(ref); return m ? itMix(m) : null; }
  if (kind === 'liked') return U.liked.length ? itLiked() : null;
  if (kind === 'downloads') return Off.set.size ? itDownloads() : null;
  return null;
}
function searchItem(s) {
  if (s.k === 'track') { const t = L.byRel.get(s.key); return t ? { k: 'track', id: t.id, title: t.title, sub: 'Song • ' + t.artist, cover: img(coverUrl(t.rel)) } : null; }
  return itFromKey(s.k + ':' + s.key);
}
// Track ids behind any item, for "play", "add to queue" and drag-and-drop.
function itemIds(k, id) {
  if (k === 'album') { const al = L.albums[+id]; return al ? al.trackIds.slice() : []; }
  if (k === 'artist') { const ar = L.artists[+id]; return ar ? uniq(popular(ar, 10).concat(ar.albumIds.flatMap(a => L.albums[a].trackIds))) : []; }
  if (k === 'playlist') return (U.playlists[id] || []).map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  if (k === 'cpl') return Collab.ids(id);
  if (k === 'mix') { const m = getMix(id); return m ? m.ids.filter(x => L.tracks[x]) : []; }
  if (k === 'liked') return U.liked.slice().reverse().map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  if (k === 'downloads') return [...Off.set].map(r => L.byRel.get(r)).filter(Boolean).map(t => t.id);
  if (k === 'track') return L.tracks[+id] ? [+id] : [];
  return [];
}
// A playable context for an item (so "play" on a card behaves like opening it and pressing play).
function itemCtx(k, id) {
  const ids = itemIds(k, id); if (!ids.length) return null;
  if (k === 'album') { const al = L.albums[+id]; return makeCtx('album', al.key, al.title, ids, 'album:' + al.key); }
  if (k === 'artist') { const ar = L.artists[+id]; return makeCtx('artist', ar.key, ar.name, ids, 'artist:' + ar.key); }
  if (k === 'playlist') return makeCtx('playlist', id, id, ids, 'playlist:' + id);
  if (k === 'cpl') { const p = Collab.get(id); return makeCtx('playlist', 'cpl:' + id, p ? p.name : 'Playlist', ids, 'cpl:' + id); }
  if (k === 'mix') { const m = getMix(id); return makeCtx('mix', m.id, m.name, ids, 'mix:' + m.id); }
  if (k === 'liked') return makeCtx('liked', '', 'Liked Songs', ids, 'liked');
  if (k === 'downloads') return makeCtx('list', 'downloads', 'Downloads', ids, 'downloads');
  return null;
}
function plCover(rels) {
  const covers = [], seen = new Set();
  for (const r of rels) {
    const t = L.byRel.get(r); if (!t) continue;
    const al = albumOf(t); if (seen.has(al.id)) continue;
    seen.add(al.id); covers.push(coverUrl(al.cover));
    if (covers.length === 4) break;
  }
  if (!covers.length) return `<div class="cover-glyph">${ic('note')}</div>`;
  if (covers.length < 4) return img(covers[0]);
  return `<div class="mosaic">${covers.map(c => img(c)).join('')}</div>`;
}
function mixCover(m) {
  const c = m.cover;
  if (c.type === 'band') return `<div class="mixart" style="--m1:${c.m1}">${img(c.img)}<div class="band"><small>${esc(c.label || 'Made for you')}</small>${esc(m.name)}</div></div>`;
  const ids = uniq(m.ids.map(id => L.tracks[id] && L.tracks[id].albumId)).filter(x => x != null).slice(0, 4);
  return `<div class="mixart typo" style="--m1:${c.m1};--m2:${c.m2 || c.m1}"><div class="mt">${esc(m.name)}</div><div class="mg">${ids.length === 4 ? ids.map(a => img(coverUrl(L.albums[a].cover))).join('') : ''}</div></div>`;
}
// Items for "Your Library": pinned first, then sorted by recents / date added / name.
function libItems(filter, q, sort = 'recent') {
  const out = [], seen = new Set();
  const add = it => { if (it && !seen.has(it.ck)) { seen.add(it.ck); out.push(it); } };
  const followed = U.follows.map(k => L.artistByKey.get(k)).filter(a => a && a.trackIds.length);
  const saved = U.saved.map(k => L.albumByKey.get(k)).filter(Boolean);
  if (!filter || filter === 'playlists') {
    add(itLiked());
    if (Off.set.size) add(itDownloads());
    Object.keys(U.playlists).forEach(n => add(itPlaylist(n)));
    Collab.list.forEach(p => add(itCollab(p)));
  }
  if (filter === 'playlists') RECENTS.filter(r => r.k.startsWith('mix:')).forEach(r => add(itFromKey(r.k)));
  if (!filter) {
    followed.forEach(a => add(itArtist(a)));
    saved.forEach(a => add(itAlbum(a)));
    RECENTS.forEach(r => add(itFromKey(r.k)));
  }
  if (filter === 'artists') { followed.forEach(a => add(itArtist(a))); L.azArtists.forEach(id => add(itArtist(L.artists[id]))); }
  if (filter === 'albums') { saved.forEach(a => add(itAlbum(a))); L.azAlbums.forEach(id => add(itAlbum(L.albums[id]))); }
  if (filter === 'downloaded' && Off.set.size) {
    add(itDownloads());
    const albums = new Set(), pls = new Set();
    Off.set.forEach(r => { const t = L.byRel.get(r); if (t) albums.add(t.albumId); });
    Object.keys(U.playlists).forEach(n => { if (U.playlists[n].some(r => Off.set.has(r))) pls.add(n); });
    pls.forEach(n => add(itPlaylist(n)));
    Collab.list.filter(p => p.tracks.some(t => Off.set.has(t.r))).forEach(p => add(itCollab(p)));
    albums.forEach(id => add(itAlbum(L.albums[id])));
  }
  let list = out;
  if (q) { const nq = norm(q); list = list.filter(it => norm(it.title + ' ' + it.sub).includes(nq)); }
  const pinned = list.filter(it => it.pinned), rest = list.filter(it => !it.pinned);
  const fav = it => (it.k === 'artist' && U.follows.includes(L.artists[it.id].key)) || (it.k === 'album' && U.saved.includes(L.albums[it.id].key));
  if (sort === 'alpha') rest.sort((a, b) => collator.compare(sortName(a.title), sortName(b.title)));
  else if (sort === 'added') rest.sort((a, b) => (b.ts || recentTs(b.ck) / 1000) - (a.ts || recentTs(a.ck) / 1000));
  else if (filter === 'artists' || filter === 'albums') rest.sort((a, b) => (recentTs(b.ck) - recentTs(a.ck)) || (fav(b) - fav(a)));
  else rest.sort((a, b) => (recentTs(b.ck) - recentTs(a.ck)) || (fav(b) - fav(a)));
  return pinned.concat(rest);
}
const emptyHtml = (icon, title, text, btn = '') => `<div class="empty">${ic(icon)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${btn}</div>`;
const COMP_RE = /\b(dj mix|mixed|compilation|vol(ume)?\.?\s*\d|best of|greatest hits|anthology|edition \d)/i;
// Long lists render in chunks as they scroll into view. Returns a disposer.
function chunkRender(root, container, n, render, step = 50) {
  let i = 0;
  const sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  container.appendChild(sentinel);
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root, rootMargin: '900px 0px' });
  function more() {
    const end = Math.min(n, i + step), parts = [];
    for (; i < end; i++) parts.push(render(i));
    sentinel.insertAdjacentHTML('beforebegin', parts.join(''));
    if (i >= n) { io.disconnect(); sentinel.remove(); } else { io.unobserve(sentinel); io.observe(sentinel); }
  }
  more();
  if (i < n) io.observe(sentinel);
  return () => { io.disconnect(); sentinel.remove(); };
}
// Pointer-driven drag-to-reorder for rows with a [data-drag] handle.
function dragSort(container, rowSel, scrollSel, onDrop) {
  container.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-drag]'); if (!handle) return;
    e.preventDefault();
    const rows = $$(`:scope > ${rowSel}`, container), row = handle.closest(rowSel), from = rows.indexOf(row);
    if (from < 0) return;
    const scroller = container.closest(scrollSel), rh = row.getBoundingClientRect().height;
    const y0 = e.clientY, s0 = scroller ? scroller.scrollTop : 0;
    let to = from, lastY = y0, auto = 0;
    handle.setPointerCapture(e.pointerId);
    row.classList.add('dragging'); row.style.contentVisibility = 'visible';
    haptic(10);
    const layout = () => {
      const dy = lastY - y0 + (scroller ? scroller.scrollTop - s0 : 0);
      row.style.transform = `translateY(${dy}px)`;
      to = clamp(from + Math.round(dy / rh), 0, rows.length - 1);
      rows.forEach((r, i) => {
        if (r === row) return;
        const s = from < to && i > from && i <= to ? -rh : from > to && i < from && i >= to ? rh : 0;
        r.style.transition = 'transform .15s'; r.style.transform = s ? `translateY(${s}px)` : '';
      });
    };
    const move = ev => {
      lastY = ev.clientY; layout();
      if (!scroller) return;
      const b = scroller.getBoundingClientRect(), edge = 70;
      const v = ev.clientY < b.top + edge ? -8 : ev.clientY > b.bottom - edge - 120 ? 8 : 0;
      clearInterval(auto);
      if (v) auto = setInterval(() => { scroller.scrollTop += v; layout(); }, 16);
    };
    const up = () => {
      clearInterval(auto);
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
      row.classList.remove('dragging'); row.style.contentVisibility = '';
      if (to !== from) { haptic(8); onDrop(from, to); }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
}

/* Server configuration (branding, feature switches, sign-up rules) */
const CREDIT = { text: 'Created by xo.st', url: 'https://xo.st' };
const INVITE_KEY = 'axdio_invite';
const SITE_KEYS = ['site_title', 'accent_color', 'custom_css', 'allow_indexing', 'custom_favicon_url', 'custom_logo_url', 'app_version', 'site_tagline',
  'public_url', 'features', 'announcement', 'registration', 'require_login', 'min_password_length', 'defaults'];
let siteLive = false;   // set once /api/branding answered; the cached library's copy is older
// Features are on unless the server says otherwise, so older servers keep everything.
const feat = k => !(SITE.features && SITE.features[k] === false);
// Features that need setting up on the server show only once the server says they're ready.
const featOn = k => !!(SITE.features && SITE.features[k] === true);
const minPassword = () => SITE.min_password_length || 4;
function pendingInvite() { try { return sessionStorage.getItem(INVITE_KEY) || ''; } catch (e) { return ''; } }
// An invite link (/?invite=CODE) is remembered for this tab and removed from the address bar.
function takeInviteFromUrl() {
  const u = new URL(location.href), code = (u.searchParams.get('invite') || '').trim().toUpperCase();
  if (!code) return '';
  try { sessionStorage.setItem(INVITE_KEY, code); } catch (e) { /* ignore */ }
  u.searchParams.delete('invite');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  return code;
}
function showAnnouncement() {
  const a = SITE.announcement;
  let el = byId('ax-announce');
  if (!a || !a.text || LS.raw('axdio_announce_seen') === a.id) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'ax-announce'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.className = 'ax-announce ' + (a.level || 'info');
  el.innerHTML = `<span>${esc(a.text)}</span><button type="button" aria-label="Dismiss">${ic('close')}</button>`;
  el.querySelector('button').onclick = () => { LS.setRaw('axdio_announce_seen', a.id); el.remove(); };
}
// Full-screen sign-in for private servers. Signing in reloads, so the library loads with the new session.
function authGate() {
  if (byId('ax-gate')) return;
  const reg = SITE.registration || 'open', invite = pendingInvite();
  let mode = invite && reg !== 'closed' ? 'register' : 'login';
  const gate = document.createElement('div');
  gate.id = 'ax-gate';
  gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-label', 'Sign in');
  const logo = SITE.custom_logo_url && /^(https?:|\/)/.test(SITE.custom_logo_url) ? `<img src="${esc(SITE.custom_logo_url)}" alt="">` : ic('note');
  const draw = () => {
    const r = mode === 'register';
    gate.innerHTML = `<form class="axg-card" novalidate><div class="axg-mark">${logo}</div><h1>${r ? 'Create your account' : `Sign in to ${esc(SITE.site_title || 'Axdio')}`}</h1>`
      + `<p>${r && reg === 'invite' ? 'You need an invite code from the server admin.' : 'This server is private. Sign in to start listening.'}</p>`
      + (reg !== 'closed' ? `<div class="axg-seg"><button type="button" class="${r ? '' : 'on'}" data-m="login">Log in</button><button type="button" class="${r ? 'on' : ''}" data-m="register">Sign up</button></div>` : '')
      + discordButton()
      + (r ? '<label>Display name<input name="name" autocomplete="nickname"></label>' : '')
      + '<label>Username<input name="user" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>'
      + `<label>Password<input name="pass" type="password" autocomplete="${r ? 'new-password' : 'current-password'}" required></label>`
      + (r && reg === 'invite' ? `<label>Invite code<input name="invite" value="${esc(invite)}" autocapitalize="characters" spellcheck="false" placeholder="ABCD-1234"></label>` : '')
      + `<div class="axg-err" role="alert"></div><button class="axg-go" type="submit">${r ? 'Sign up' : 'Log in'}</button>`
      + (reg === 'closed' ? '<p class="axg-note">Accounts are created by the server admin.</p>' : '') + '</form>';
    const form = gate.querySelector('form');
    gate.querySelectorAll('[data-m]').forEach(b => { b.onclick = () => { mode = b.dataset.m; draw(); }; });
    form.onsubmit = async e => {
      e.preventDefault();
      const f = form.elements, err = form.querySelector('.axg-err'), btn = form.querySelector('.axg-go');
      const u = f.user.value.trim(), p = f.pass.value;
      if (!u || !p) { err.textContent = 'Enter your username and password.'; return; }
      if (r && p.length < minPassword()) { err.textContent = `Use at least ${minPassword()} characters for your password.`; return; }
      btn.disabled = true; err.textContent = '';
      try { await signIn(u, p, r, f.name ? f.name.value.trim() : '', f.invite ? f.invite.value.trim().toUpperCase() : undefined); location.reload(); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
    (form.querySelector('input[name=user]')).focus();
  };
  draw();
  document.body.appendChild(gate);
  const ov = byId('axdio-loading-overlay'); if (ov) ov.remove();
}
async function fetchSite() {
  try {
    const res = await fetch('/api/branding', { cache: 'no-store', headers: U.token ? { 'X-Auth-Token': U.token } : {} });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}
const CORE_CSS = `
.ax-announce{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9000;display:flex;align-items:center;gap:10px;max-width:min(640px,calc(100vw - 24px));padding:10px 8px 10px 16px;border-radius:12px;font:600 13.5px/1.4 var(--font,system-ui,sans-serif);color:#fff;background:#1f3b63;box-shadow:0 12px 36px rgba(0,0,0,.55);margin-top:env(safe-area-inset-top)}
.ax-announce.success{background:#14532d}.ax-announce.warning{background:#78350f}
.ax-announce button{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:inherit;opacity:.8;flex-shrink:0;background:none;border:0;cursor:pointer}
.ax-announce button:hover{opacity:1;background:rgba(255,255,255,.12)}.ax-announce svg{width:18px;height:18px;fill:currentColor}
#ax-gate{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(120% 70% at 50% 0%,#1d1d1d,#0a0a0a 65%);overflow:auto;font-family:var(--font,system-ui,sans-serif);color:#fff}
#ax-gate .axg-card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
#ax-gate .axg-mark{width:52px;height:52px;border-radius:14px;background:var(--accent,#22c55e);color:var(--on-accent,#000);display:grid;place-items:center;overflow:hidden;margin-bottom:6px}
#ax-gate .axg-mark svg{width:28px;height:28px;fill:currentColor}#ax-gate .axg-mark img{width:100%;height:100%;object-fit:cover}
#ax-gate h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0}#ax-gate p{color:#a3a3a3;margin:-6px 0 4px;font-size:14px}
#ax-gate .axg-seg{display:flex;background:#1a1a1a;border-radius:10px;padding:3px}
#ax-gate .axg-seg button{flex:1;padding:8px;border-radius:8px;font-weight:700;font-size:13.5px;color:#a3a3a3;background:none;border:0;cursor:pointer}
#ax-gate .axg-seg button.on{background:#2a2a2a;color:#fff}
#ax-gate label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:700}
#ax-gate input{height:46px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#161616;color:#fff;padding:0 14px;font:500 15px var(--font,system-ui,sans-serif);outline:0}
#ax-gate input:focus{border-color:rgba(255,255,255,.35)}
#ax-gate .axg-err{color:#f87171;font-size:13px;min-height:1em}
#ax-gate .axg-go{height:48px;border-radius:999px;border:0;background:var(--accent,#22c55e);color:var(--on-accent,#000);font:800 15px var(--font,system-ui,sans-serif);cursor:pointer}
#ax-gate .axg-go:disabled{opacity:.6}#ax-gate .axg-note{font-size:13px;text-align:center;margin-top:4px}
.ax-discord{display:flex;align-items:center;justify-content:center;gap:10px;height:48px;border-radius:999px;background:#5865f2;color:#fff !important;font:800 15px var(--font,system-ui,sans-serif);text-decoration:none;transition:filter .15s,transform .1s}
.ax-discord:hover{filter:brightness(1.08)}.ax-discord:active{transform:scale(.98)}.ax-discord svg{width:22px;height:22px;fill:currentColor}
.ax-or{display:flex;align-items:center;gap:12px;color:#8a8a8a;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:4px 0}
.ax-or::before,.ax-or::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.12)}
`;
(() => { const st = document.createElement('style'); st.id = 'ax-core-css'; st.textContent = CORE_CSS; document.head.appendChild(st); })();

/* Library loading & boot */
function applySite(s) {
  // Only known keys are kept; anything else the endpoint returns is ignored.
  Object.keys(SITE).forEach(k => delete SITE[k]);
  SITE_KEYS.forEach(k => { if (s && s[k] != null) SITE[k] = s[k]; });
  document.documentElement.dataset.off = ['lyrics', 'offline', 'connect', 'sharing'].filter(k => !feat(k)).join(' ');
  if (FRESH_DEVICE && SITE.defaults) {
    const d = SITE.defaults;
    if (d.crossfade != null) S.crossfade = Math.max(0, Math.min(12, +d.crossfade || 0));
    if (d.gapless != null) S.gapless = !!d.gapless;
    if (d.normalize != null) S.normalize = !!d.normalize;
  }
  if (document.body) showAnnouncement();
  if (SITE.site_title && P.cur == null) document.title = SITE.site_title;
  if (!LS.raw(K.accent) && !(U.prefs && U.prefs.theme_accent) && SITE.accent_color) applyAccent(SITE.accent_color);
  const css = byId('axdio-custom-css'); if (css && SITE.custom_css) css.textContent = SITE.custom_css;
  if (SITE.allow_indexing) { const m = byId('meta-robots'); if (m) m.content = 'index, follow'; }
  if (SITE.custom_favicon_url) { const f = document.querySelector('link[rel="icon"]'); if (f) f.href = SITE.custom_favicon_url; }
}
async function readCachedLibrary() {
  try { const r = await caches.match(LIB_URL, { cacheName: META_CACHE }); return r ? await r.json() : null; } catch (e) { return null; }
}
async function fetchLibrary() {
  const res = await fetch(LIB_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const copy = res.clone();
  const data = await res.json();
  try { await (await caches.open(META_CACHE)).put(LIB_URL, copy); } catch (e) { /* storage full or unavailable */ }
  return data;
}
function useLibrary(data, source, log) {
  const oldTracks = L.tracks;
  const ms = buildLibrary(data.library);
  L.version = data.version;
  if (!siteLive) applySite(data.settings);
  log('OK', `Indexed ${nf(L.tracks.length)} tracks · ${nf(L.azArtists.length)} artists · ${nf(L.albums.length)} releases in ${ms} ms (${source})`);
  if (oldTracks.length) remapPlayer(oldTracks);
}
// After a library refresh, numeric track ids change: carry the player over by file path.
function remapPlayer(old) {
  const m = id => { const t = old[id] && L.byRel.get(old[id].rel); return t ? t.id : null; };
  P.queue = P.queue.map(m).filter(x => x != null);
  if (P.cur != null) P.cur = m(P.cur);
  if (P.pending) { const id = m(P.pending.id); P.pending = id != null ? { id, t: P.pending.t } : null; }
  if (D.ready) { const id = m(D.ready.id); D.ready = id != null ? { id, deck: D.ready.deck } : null; }
  if (P.ctx) {
    const curIdx = P.order[P.pos];
    const ids = P.ctx.ids.map(m);
    const keep = ids.map((id, i) => [id, i]).filter(x => x[0] != null);
    const remap = new Map(keep.map((x, j) => [x[1], j]));
    P.ctx.ids = keep.map(x => x[0]);
    P.order = P.order.map(i => remap.get(i)).filter(x => x != null);
    P.pos = Math.max(0, P.order.indexOf(remap.get(curIdx)));
  }
  if (P.cur == null) { P.ctx = null; P.order = []; P.pos = -1; }
}
// Load user, offline cache and library (cache first, then the server), then restore the session.
async function boot({ platform = 'mobile', log = () => {}, onLibrary = () => {} } = {}) {
  Connect.platform = platform;
  LS.del('spotdl_lib_cache');   // superseded by Cache Storage (the JSON outgrew localStorage)
  const accent = LS.raw(K.accent);
  if (accent) applyAccent(accent);
  const cachedUser = U.token ? LS.get(K.userCache, null) : null;
  if (cachedUser) applyUser(cachedUser); else loadLocalUser();
  setOnline();
  applyVolume();
  bindMediaSession();

  takeInviteFromUrl();
  await takeLoginFromUrl();
  const site = await fetchSite();
  if (site && site.settings) { applySite(site.settings); siteLive = true; }
  if (site && site.settings && site.settings.require_login && !(site.viewer && site.viewer.authenticated)) {
    log('INFO', 'Private server — sign in to continue');
    buildLibrary([]);
    if (U.token) signOut(true);   // the saved session was revoked or has expired
    authGate();
    return;
  }
  await Off.init();
  log('OK', `Offline audio cache mounted — ${count(Off.set.size, 'song')} on this device`);
  const cached = await readCachedLibrary();
  if (cached && Array.isArray(cached.library)) { useLibrary(cached, 'local cache', log); onLibrary(); }
  else log('INFO', 'No local library cache — fetching manifest from server…');

  let fresh = null;
  try {
    if (cached && cached.version != null) {
      const v = await api('/api/library/version');
      if (v.version !== cached.version || v.count !== cached.cached_count) { log('INFO', 'Library changed on server — syncing…'); fresh = await fetchLibrary(); }
      else log('OK', `Library up to date (v${String(cached.version).slice(0, 12)})`);
    } else fresh = await fetchLibrary();
  } catch (e) {
    log('WARN', navigator.onLine ? `Library sync failed: ${e.message}` : 'Offline — using cached library');
  }
  if (fresh && Array.isArray(fresh.library)) useLibrary(fresh, 'server', log);
  if (!L.ready) {
    log('WARN', 'Library unavailable. Reload once you are back online.');
    buildLibrary([]);
  }
  if (U.token) {
    Collab.loadCached();
    if (await syncUser()) log('OK', `Session restored for ${U.name || U.username}`);
    else log('WARN', 'Could not reach account service — using saved data');
  }
  restoreState();
  // Downloads interrupted by closing the app resume now.
  const pendingDl = LS.get(K.dlQueue, []).filter(r => L.byRel.has(r));
  if (pendingDl.length && navigator.onLine) Off.enqueue(pendingDl);
  Connect.init(platform);
}

window.AX = {
  UI, IOS,
  byId, $$, esc, norm, clamp, fmt, nf, count, ic, EQB, debounce, uniq, now, setUse, collator, haptic, hashStr, rng, shuffled, pick, dayKey, weekKey, monthYear,
  LS, K, S, saveS, saveSSoon, AUDIO_CACHE, META_CACHE, streamUrl, playUrl, QUALITIES, streamQuality, setQuality, onCellular, SITE, feat, featOn, CREDIT, minPassword, pendingInvite, authGate,
  PH, coverUrl, img, tone, hexRgb, dominant, applyAccent, ACCENTS, setAccent, setThemeColor,
  L, sortName, fileExt, buildLibrary, albumArtist, albumSource, albumOf, artistOf, creditParts, relatedArtists, topArtists, popular, radioIds, MIX, PALETTE, buildMixes, getMix, searchAll,
  U, api, signIn, signOut, finishSignIn, takeDiscordNote, discordSignIn, discordLink, discordUnlink, discordFinish, discordButton, presenceInfo, presenceSetup, presenceOff, updateProfile, pickImage, squarePhoto, uploadAvatar, removeAvatar, changePassword, listSessions, revokeSession, exportMyData, deleteAccount, subsonicInfo, subsonicPassword, scrobbleInfo, connectListenBrainz, disconnectScrobbler, cacheUser, recordPlay, toggleLike, setLikedMany, toggleFollow, toggleSaveAlbum,
  addToPlaylist, removeFromPlaylist, reorderPlaylist, plCreate, plRename, plDelete, pushLibrary, pushPrefs, Collab,
  RECENTS, touchRecent, recentTs, SEARCHES, rememberSearch, forgetSearch, clearSearches,
  Off, ring, dlBadge, dlChanged, updateDlButton, toggleCtxDownload, EQ_BANDS, EQ_PRESETS, eqLabel, FX, setBoost, toggleNormalize, toggleEq, setEqPreset, setEqBand,
  audio, D, P, CTX, makeCtx, regCtx, curTrack, ctxPlaying, isPlaying, buildOrder, playCtx, playTrackAlone, load, play, pause, togglePlay, shuffleAll, next, prev,
  setShuffle, cycleRepeat, addToQueue, upcoming, queueJump, ctxJump, queueRemove, queueMove, queueClear, seek, setVolume, toggleMute, applyVolume, stageTrack,
  SL, setSleep, sleepLabel, saveState, trackChanged, refreshLike, updatePlayButtons, updateModes, syncMediaSession,
  LY, lyMsg, syncLyrics, Connect, share, shareId, trackLink, albumLink, artistLink, setOnline,
  avatarHtml, libItems, itAlbum, itArtist, itPlaylist, itCollab, itSearchPl, itLiked, itDownloads, itMix, itFromKey, searchItem, itemIds, itemCtx, plCover, mixCover, emptyHtml, COMP_RE, chunkRender, dragSort,
  boot,
};
window.Axdio = window.AX;   // debug handle kept from the first mobile release
})();
