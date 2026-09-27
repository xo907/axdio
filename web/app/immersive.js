/* Axdio — Immersive visuals (loaded after core.js).
   A living background painted from the album's own colours, a spectrum ring that grows out of the artwork,
   and a pulse on every beat. Desktop and Android listen to the real audio through a Web Audio analyser;
   iPhones (where routing audio through Web Audio stops background playback) get a gentle synthetic rhythm. */
(() => {
'use strict';
const AX = window.AX;
if (!AX || AX.Vis) return;
const { FX, IOS, S, saveS, clamp, isPlaying } = AX;

/* ---- Palette: four distinct colours of an album cover ---- */
const palCache = new Map();
function palette(src) {
  if (palCache.has(src)) return palCache.get(src);
  const p = new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 28;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0, 28, 28);
        const d = x.getImageData(0, 0, 28, 28).data, buckets = Array.from({ length: 12 }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
        let grey = { r: 0, g: 0, b: 0, w: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510;
          const s = mx === mn ? 0 : (mx - mn) / (255 - Math.abs(mx + mn - 255) || 1);
          if (s < .12 || l < .08 || l > .94) { grey.r += r; grey.g += g; grey.b += b; grey.w++; continue; }
          let h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
          h = ((h * 60) + 360) % 360;
          const k = buckets[Math.floor(h / 30) % 12], w = s * (1 - Math.abs(l - .5));
          k.r += r * w; k.g += g * w; k.b += b * w; k.w += w;
        }
        const cols = buckets.filter(k => k.w > .5).sort((a, b) => b.w - a.w).slice(0, 4).map(k => [k.r / k.w, k.g / k.w, k.b / k.w].map(v => clamp(v * 1.15, 0, 255)));
        if (!cols.length && grey.w) cols.push([grey.r / grey.w, grey.g / grey.w, grey.b / grey.w]);
        while (cols.length < 4) { const c0 = cols[cols.length - 1] || [90, 60, 200]; cols.push(c0.map((v, i) => clamp(v * (i === cols.length % 3 ? 1.35 : .7), 0, 255))); }
        resolve(cols);
      } catch (e) { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
  palCache.set(src, p);
  return p;
}

/* ---- How loud, where, and when the beat lands ---- */
const E = {
  an: null, bins: null, tried: false, bass: 0, mid: 0, high: 0, avg: .2, vari: .002, beat: 0, lastBeat: 0, spec: new Float32Array(64),
  attach() {
    if (this.an || this.tried) return !!this.an;
    this.tried = true;
    if (IOS) return false;
    try {
      FX.viz = true;
      if (!FX.ensure()) return false;
      FX.apply(); FX.resume();
      this.an = FX.analyser || null;
      if (this.an) this.bins = new Uint8Array(this.an.frequencyBinCount);
    } catch (e) { this.an = null; }
    return !!this.an;
  },
  sample(t) {
    const playing = isPlaying();
    let live = false;
    if (this.an && playing) {
      this.an.getByteFrequencyData(this.bins);
      const b = this.bins, n = b.length, band = (lo, hi) => { let s = 0; for (let i = lo; i < hi; i++) s += b[i]; return s / ((hi - lo) * 255); };
      const bass = band(1, 8), mid = band(8, 60), high = band(60, Math.min(n, 300));
      // All zeros means no signal reaches the analyser (a quiet intro, or a suspended context): breathe instead.
      live = bass + mid + high > .002;
      if (live) { this.bass = bass; this.mid = mid; this.high = high; }
    }
    if (live) {
      const b = this.bins, n = b.length;
      // 64 bars on a log scale from ~40 Hz to ~14 kHz.
      for (let i = 0; i < 64; i++) {
        const lo = Math.floor(2 * Math.pow(n / 3 / 2, i / 64)), hi = Math.max(lo + 1, Math.floor(2 * Math.pow(n / 3 / 2, (i + 1) / 64)));
        let s = 0; for (let k = lo; k < hi; k++) s += b[k];
        // Bytes are decibels: lift the floor off and tilt up the (naturally quieter) treble.
        const v = clamp((s / ((hi - lo) * 255) - .3 + i / 64 * .1) / .6, 0, 1);
        this.spec[i] = this.spec[i] * .5 + Math.pow(v, 1.3) * .5;
      }
    } else {
      // No analyser (iPhone), no signal or paused: breathe gently, a little faster while playing.
      const k = playing ? 1 : .25, beatHz = 2;
      this.bass = k * (.35 + .25 * Math.pow(Math.max(0, Math.sin(t * Math.PI * beatHz)), 6));
      this.mid = k * (.3 + .1 * Math.sin(t * 1.3)); this.high = k * (.2 + .08 * Math.sin(t * 2.1));
      for (let i = 0; i < 64; i++) {
        const v = k * (.18 + .22 * Math.pow(Math.max(0, Math.sin(t * 1.7 + i * .37)), 2) * (1 - i / 90) + .15 * this.bass * (1 - i / 64));
        this.spec[i] = this.spec[i] * .8 + v * .2;
      }
    }
    // A beat is bass jumping well clear of its recent level and wobble.
    const dev = this.bass - this.avg;
    if (dev > Math.max(.035, 1.5 * Math.sqrt(this.vari)) && t - this.lastBeat > .28) { this.beat = 1; this.lastBeat = t; }
    this.avg += dev * .06; this.vari += (dev * dev - this.vari) * .04;
    this.beat *= .9;
  },
};

/* ---- A scene: background, ring and pulse on one canvas ---- */
const scenes = new Set();
let raf = 0;
function loop(ms) {
  raf = 0;
  const t = ms / 1000;
  let any = false;
  E.sample(t);
  for (const sc of scenes) if (sc.running && sc.canvas.isConnected) { sc.draw(t); any = true; }
  if (any && !document.hidden) raf = requestAnimationFrame(loop);
}
const kick = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(loop); };
document.addEventListener('visibilitychange', kick);

// A point on a rounded rectangle's outline (f = 0..1 clockwise from top centre) and its outward normal.
function edge(f, hw, hh, r) {
  const sx = hw - r, sy = hh - r, arc = Math.PI * r / 2, segs = [sx, arc, 2 * sy, arc, 2 * sx, arc, 2 * sy, arc, sx];
  let d = f * segs.reduce((a, b) => a + b, 0), k = 0;
  while (k < segs.length - 1 && d > segs[k]) d -= segs[k++];
  const corner = (ox, oy, a0) => { const a = a0 + d / r; return [ox + Math.cos(a) * r, oy + Math.sin(a) * r, Math.cos(a), Math.sin(a)]; };
  switch (k) {
    case 0: return [d, -hh, 0, -1];
    case 1: return corner(sx, -sy, -Math.PI / 2);
    case 2: return [hw, -sy + d, 1, 0];
    case 3: return corner(sx, sy, 0);
    case 4: return [sx - d, hh, 0, 1];
    case 5: return corner(-sx, sy, Math.PI / 2);
    case 6: return [-hw, sy - d, -1, 0];
    case 7: return corner(-sx, -sy, Math.PI);
    default: return [-sx + d, -hh, 0, -1];
  }
}

class Scene {
  constructor(canvas, opts = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.opts = opts; this.running = false;
    this.cols = [[70, 40, 160], [30, 120, 200], [200, 60, 120], [40, 180, 140]]; this.from = this.cols; this.to = this.cols; this.mix = 1;
    this.small = document.createElement('canvas'); this.small.width = 64; this.small.height = 40;
    this.sx = this.small.getContext('2d');
    this.seed = Math.random() * 100;
  }
  async setTrack(src) {
    const cols = src ? await palette(src) : null;
    if (!cols) return;
    this.from = this.current(); this.to = cols; this.mix = 0;
  }
  current() { const m = this.mix; return this.to.map((c, i) => c.map((v, k) => this.from[i][k] + (v - this.from[i][k]) * m)); }
  start() {
    if (this.running) return;
    this.running = true; scenes.add(this);
    if (this.opts.react !== false) E.attach();
    this.canvas.classList.add('viz-on');
    kick();
  }
  stop() {
    this.running = false; scenes.delete(this);
    this.canvas.classList.remove('viz-on');
    const a = this.opts.art; if (a) a.style.scale = '';
  }
  draw(t) {
    const cv = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const x = this.ctx, cols = (this.mix = Math.min(1, this.mix + .015), this.current());
    // Background: soft colour fields that drift and breathe, painted small and scaled up (cheap, naturally blurred).
    const s = this.sx, SW = 64, SH = Math.max(24, Math.round(64 * h / w));
    if (this.small.height !== SH) this.small.height = SH;
    s.globalCompositeOperation = 'source-over';
    s.fillStyle = `rgb(${cols[0].map(v => v * .12).join(',')})`;
    s.fillRect(0, 0, SW, SH);
    // Layered (not added) so the colours stay rich instead of washing out to white.
    const tt = t * .09 + this.seed;
    cols.forEach((c, i) => {
      const cx = SW * (.5 + .4 * Math.sin(tt * (1 + i * .23) + i * 1.9)), cy = SH * (.5 + .4 * Math.cos(tt * (.8 + i * .31) + i * 2.7));
      const r = Math.max(SW, SH) * (.36 + .08 * Math.sin(tt * 1.7 + i) + .16 * E.bass + (i === 0 ? .1 * E.beat : 0));
      const g = s.createRadialGradient(cx, cy, 0, cx, cy, r), rgb = c.map(v => Math.round(v * .92)).join(',');
      g.addColorStop(0, `rgba(${rgb},${(.62 + .2 * E.mid).toFixed(3)})`);
      g.addColorStop(.55, `rgba(${rgb},${(.28 + .1 * E.mid).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      s.fillStyle = g; s.fillRect(0, 0, SW, SH);
    });
    // A soft flash of the lead colour on each beat.
    if (E.beat > .05) { s.globalCompositeOperation = 'lighter'; s.fillStyle = `rgba(${cols[0].map(v => Math.round(v * .5)).join(',')},${(E.beat * .1).toFixed(3)})`; s.fillRect(0, 0, SW, SH); }
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.globalCompositeOperation = 'source-over';
    x.drawImage(this.small, 0, 0, cv.width, cv.height);
    // Keep text legible: darken towards the edges and bottom.
    const vg = x.createRadialGradient(cv.width / 2, cv.height * .45, Math.min(cv.width, cv.height) * .2, cv.width / 2, cv.height / 2, Math.max(cv.width, cv.height) * .75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    x.fillStyle = vg; x.fillRect(0, 0, cv.width, cv.height);
    // The frame: spectrum bars growing out of the artwork's edges, bass at the top, mirrored left and right.
    const art = this.opts.art;
    if (art && art.isConnected) {
      const cr = cv.getBoundingClientRect(), ar = art.getBoundingClientRect();
      if (ar.width > 40 && this.opts.ring !== false) {
        const cx = (ar.left + ar.width / 2 - cr.left) * dpr, cy = (ar.top + ar.height / 2 - cr.top) * dpr;
        const hw = ar.width / 2 * dpr, hh = ar.height / 2 * dpr, half = Math.min(hw, hh), gap = 6 * dpr;
        const N = 136, per = 2 * (hw + hh) * 2, lw = Math.max(1.5 * dpr, per / N * .38), maxLen = half * (this.opts.len || .3);
        // Light spilling from behind the cover.
        const glow = x.createRadialGradient(cx, cy, half * .5, cx, cy, half * (1.55 + .3 * E.bass));
        glow.addColorStop(0, `rgba(${cols[0].map(Math.round).join(',')},${.3 + .35 * E.beat})`); glow.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = glow; x.fillRect(cx - half * 2, cy - half * 2, half * 4, half * 4);
        x.lineCap = 'round'; x.lineWidth = lw;
        for (let i = 0; i < N; i++) {
          const k = i < N / 2 ? i : N - 1 - i, v = E.spec[Math.min(63, Math.floor(k / (N / 2) * 64))] || 0;
          const [px, py, nx, ny] = edge((i + .5) / N, hw + gap, hh + gap, Math.min(half * .14, 18 * dpr) + gap);
          const len = lw * .2 + maxLen * (v + .12 * E.beat);
          const c = cols[Math.min(3, Math.floor(k / (N / 2) * 4))];
          x.strokeStyle = `rgba(${c.map(q => Math.round(Math.min(255, q * 1.25 + 40))).join(',')},${(.5 + .5 * v).toFixed(3)})`;
          x.beginPath(); x.moveTo(cx + px, cy + py); x.lineTo(cx + px + nx * len, cy + py + ny * len); x.stroke();
        }
      }
      // The artwork swells a little on every beat (the separate `scale` property leaves the page's own transforms alone).
      art.style.scale = this.opts.pulse === false ? '' : (1 + .026 * E.beat + .01 * E.bass).toFixed(4);
    }
  }
}

AX.Vis = {
  get on() { return S.viz !== false; },
  toggle() { S.viz = S.viz === false; saveS(); return this.on; },
  mount(canvas, opts) { return new Scene(canvas, opts); },
  palette,
  E,
};
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
canvas.viz { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; opacity: 0; transition: opacity .8s ease; }
canvas.viz.viz-on { opacity: 1; }
` }));
})();
