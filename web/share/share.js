/* Share pages: plays the shared song, album or artist (and the similar songs after it) right on the page, with a
   visualizer around the artwork that follows the music, and a backdrop in the artwork's colours. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const D = JSON.parse($('share-data').textContent);
  const tracks = D.tracks || [];
  const root = document.documentElement, body = document.body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let toastTimer = 0;
  const toast = msg => {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  };
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const hex = h => { const n = parseInt(String(h || '#22c55e').slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

  // ---------- Colours: three from the artwork (the server's one until the artwork is in) ----------
  let pal = [hex(D.color), hex(D.accent), hex(D.color)];
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb(h, s, l) {
    const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }
  function palette(img) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 32, 32);
      const px = g.getImageData(0, 0, 32, 32).data, bins = [];
      for (let i = 0; i < 24; i++) bins.push({ w: 0, h: 0, s: 0 });
      for (let i = 0; i < px.length; i += 4) {
        const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
        const w = .03 + s * s * Math.max(0, 1 - Math.abs(l - .5) * 1.8);
        const b = bins[Math.floor(h * 24) % 24]; b.w += w; b.h += h * w; b.s += s * w;
      }
      const top = bins.filter(b => b.w > 0).map(b => ({ w: b.w, h: b.h / b.w, s: b.s / b.w })).sort((a, b) => b.w - a.w);
      const out = [];
      for (const b of top) {
        if (out.length === 3) break;
        if (out.some(o => Math.min(Math.abs(o.h - b.h), 1 - Math.abs(o.h - b.h)) < .06)) continue;
        out.push(b);
      }
      if (!out.length) return;
      while (out.length < 3) out.push({ h: (out[0].h + out.length * .08) % 1, s: out[0].s });
      pal = out.map((b, i) => hslToRgb(b.h, Math.min(Math.max(b.s, .45), .85), i === 0 ? .55 : .5));
      pal.forEach((c, i) => root.style.setProperty(`--c${i + 1}`, `rgb(${c.join(',')})`));
      V.recolor();
    } catch (e) { /* the artwork couldn't be read: keep the server's colour */ }
  }

  // ---------- Visualizer ----------
  const V = (() => {
    const cv = $('viz'), art = $('art'), bg = $('bg'), mini = $('mini-viz'), play = $('play');
    const round = !!(art && art.classList.contains('round'));
    const N = 64, band = new Float32Array(N), target = new Float32Array(N);
    const g = cv && cv.getContext('2d'), mg = mini && mini.getContext('2d');
    let an = null, bins = null, sr = 48000, w = 0, h = 0, dpr = 1, half = 0, pts = [], parts = [];
    let playing = false, fake = false, bass = 0, slowBass = 0, energy = 0, lastE = -1, frame = 0, raf = 0;

    function layout() {
      if (!cv) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = cv.clientWidth; h = cv.clientHeight;
      if (!w || !h) return;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      half = art.clientWidth / 2;
      pts = [];
      if (round) {
        const M = 120;
        for (let i = 0; i < M; i++) {
          const a = i / M * Math.PI * 2, nx = Math.sin(a), ny = Math.cos(a);   // a = 0 points down: bass at the bottom
          pts.push({ x: nx * half * 1.04, y: ny * half * 1.04, nx, ny, u: (1 - Math.cos(a)) / 2 });
        }
      } else {
        const M = 26, span = .82;
        for (const [ex, ey] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          for (let j = 0; j < M; j++) {
            const p = (j / (M - 1) * 2 - 1) * span;
            const x = ex ? ex * half * 1.03 : p * half, y = ey ? ey * half * 1.03 : p * half;
            pts.push({ x, y, nx: ex, ny: ey, u: Math.abs(p) / span });
          }
        }
      }
      recolor();
      if (mini) { mini.width = mini.clientWidth * dpr; mini.height = mini.clientHeight * dpr; }
    }
    function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
    function recolor() {
      for (const p of pts) {
        const c = p.u < .5 ? mix(pal[0], pal[1], p.u * 2) : mix(pal[1], pal[2], (p.u - .5) * 2);
        p.col = `rgb(${c.join(',')})`;
        p.b = Math.min(N - 1, Math.floor(Math.pow(p.u, .85) * (N - 1)));
      }
    }
    function attach(audio) {
      if (an || fake) return;
      // iPhones and iPads stop music routed through Web Audio when the screen locks: there the visualizer dances
      // to the beat of a made-up spectrum instead of the real one.
      const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const AC = window.AudioContext || window.webkitAudioContext;
      if (ios || !AC) { fake = true; return; }
      try {
        const ctx = new AC(), src = ctx.createMediaElementSource(audio);
        an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = .72;
        src.connect(an); an.connect(ctx.destination);
        bins = new Uint8Array(an.frequencyBinCount); sr = ctx.sampleRate;
        V.ctx = ctx;
      } catch (e) { fake = true; }
    }
    function sample(t) {
      if (playing && an) {
        an.getByteFrequencyData(bins);
        const hz = sr / an.fftSize;
        for (let i = 0; i < N; i++) {
          const f0 = 32 * Math.pow(15000 / 32, i / N), f1 = 32 * Math.pow(15000 / 32, (i + 1) / N);
          let lo = Math.floor(f0 / hz), hi = Math.max(lo + 1, Math.ceil(f1 / hz)), m = 0;
          for (let k = lo; k < hi && k < bins.length; k++) if (bins[k] > m) m = bins[k];
          const v = m / 255 * (1 + i / N * .7);
          target[i] = Math.min(1, Math.pow(v, 1.7) * 1.15);
        }
      } else if (playing && fake) {
        const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.04)), 6), off = Math.pow(Math.max(0, Math.sin(t * Math.PI * 4.16 + 1)), 10);
        for (let i = 0; i < N; i++) {
          const x = i / N, n = .5 + .5 * Math.sin(t * 3.1 + i * 1.7) * Math.sin(t * 1.3 + i * .37);
          target[i] = Math.min(1, (.62 * beat * (1 - x) + .3 * off * x + .32 * n) * (1 - x * .35));
        }
      } else {
        for (let i = 0; i < N; i++) target[i] = reduced ? .05 : .045 + .035 * (1 + Math.sin(t * 1.4 + i * .42)) / 2;
      }
      let b = 0, e = 0;
      for (let i = 0; i < N; i++) {
        band[i] += (target[i] - band[i]) * (target[i] > band[i] ? .55 : .14);
        e += band[i]; if (i < 6) b += band[i];
      }
      bass = b / 6; energy = e / N;
      slowBass += (bass - slowBass) * .05;
    }
    function draw(t) {
      if (!g || !w) return;
      const cx = w / 2, cy = h / 2;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      // The glow behind the artwork swells with the bass.
      const gr = g.createRadialGradient(cx, cy, half * .4, cx, cy, half * (1.25 + bass * .55));
      gr.addColorStop(0, `rgba(${pal[0].join(',')},${.12 + energy * .5})`);
      gr.addColorStop(1, `rgba(${pal[0].join(',')},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      // The bars.
      const max = half * (round ? .42 : .34), lw = Math.max(2, half * (round ? .022 : .028));
      g.lineCap = 'round'; g.lineWidth = lw;
      for (const p of pts) {
        const v = band[p.b], len = 3 + v * max;
        g.globalAlpha = .35 + v * .65;
        g.strokeStyle = p.col;
        g.beginPath();
        g.moveTo(cx + p.x + p.nx * 6, cy + p.y + p.ny * 6);
        g.lineTo(cx + p.x + p.nx * (6 + len), cy + p.y + p.ny * (6 + len));
        g.stroke();
      }
      // A thin orbit that breathes, for artists.
      if (round) {
        g.globalAlpha = .18 + energy * .5; g.lineWidth = 1.2; g.strokeStyle = `rgb(${pal[1].join(',')})`;
        g.beginPath(); g.arc(cx, cy, half * (1.52 + energy * .12), 0, Math.PI * 2); g.stroke();
      }
      // Sparks thrown off on the beat.
      if (playing && !reduced && bass - slowBass > .1 && parts.length < 90) {
        for (let k = 0; k < 7; k++) {
          const a = Math.random() * Math.PI * 2, r = half * (round ? 1.05 : 1.1);
          parts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: Math.cos(a) * (1 + Math.random() * 2.2), vy: Math.sin(a) * (1 + Math.random() * 2.2), life: 1, c: pal[k % 3] });
        }
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.x += p.vx; p.y += p.vy; p.vx *= .985; p.vy *= .985; p.life -= .016;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        g.globalAlpha = p.life * .9; g.fillStyle = `rgb(${p.c.join(',')})`;
        g.beginPath(); g.arc(p.x, p.y, 1.2 + p.life * 1.8, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function drawMini() {
      if (!mg || !mini.width || !body.classList.contains('has-mini')) return;
      const W = mini.width, H = mini.height, n = 9, bw = W / n;
      mg.clearRect(0, 0, W, H);
      for (let i = 0; i < n; i++) {
        const v = band[Math.floor(i / n * 40)], bh = Math.max(2 * dpr, v * H);
        mg.fillStyle = `rgb(${mix(pal[0], pal[1], i / n).join(',')})`;
        mg.beginPath(); mg.roundRect ? mg.roundRect(i * bw + bw * .2, H - bh, bw * .6, bh, bw * .3) : mg.rect(i * bw + bw * .2, H - bh, bw * .6, bh); mg.fill();
      }
    }
    function tick(ms) {
      raf = 0;
      const t = ms / 1000;
      sample(t);
      draw(t);
      drawMini();
      if (art) art.style.transform = playing ? `scale(${(1 + bass * .03).toFixed(4)})` : '';
      if (++frame % 2 === 0 && Math.abs(energy - lastE) > .004) {
        lastE = energy;
        bg.style.setProperty('--e', Math.min(1, energy * 2.2).toFixed(3));
        if (play) play.style.setProperty('--b', Math.min(1, bass * 1.6).toFixed(3));
      }
      // At rest (and with reduced motion) a few frames are enough; playing, every frame.
      if (playing || (!reduced && !document.hidden)) raf = requestAnimationFrame(tick);
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    if (cv) {
      new ResizeObserver(layout).observe(cv);
      layout();
      kick();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
    }
    return {
      attach, recolor: () => { recolor(); kick(); }, ctx: null,
      set playing(v) { playing = v; if (v && V.ctx && V.ctx.state === 'suspended') V.ctx.resume(); kick(); },
    };
  })();

  const artImg = $('art-img');
  if (artImg) { if (artImg.complete && artImg.naturalWidth) palette(artImg); else artImg.addEventListener('load', () => palette(artImg), { once: true }); }

  // ---------- Copy link ----------
  const copy = $('copy');
  if (copy) copy.addEventListener('click', async () => {
    const url = location.origin + location.pathname;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: document.title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); } catch (e) {
      const ta = document.createElement('textarea'); ta.value = url; body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (x) { /* nothing more to try */ }
      ta.remove();
    }
    copy.classList.add('done'); copy.querySelector('use').setAttribute('href', '#i-check'); copy.querySelector('span').textContent = 'Copied';
    setTimeout(() => { copy.classList.remove('done'); copy.querySelector('use').setAttribute('href', '#i-link'); copy.querySelector('span').textContent = 'Copy link'; }, 2200);
  });

  // ---------- Rows of cards: arrows (the scrollbar is hidden) ----------
  document.querySelectorAll('.sec').forEach(sec => {
    const rail = sec.querySelector('.rail'), bs = sec.querySelectorAll('.rail-b');
    if (!rail || !bs.length) return;
    const upd = () => {
      bs[0].disabled = rail.scrollLeft < 4;
      bs[1].disabled = rail.scrollLeft + rail.clientWidth > rail.scrollWidth - 4;
      sec.querySelector('.rail-nav').style.visibility = rail.scrollWidth > rail.clientWidth + 4 ? '' : 'hidden';
    };
    bs.forEach(b => b.addEventListener('click', () => rail.scrollBy({ left: +b.dataset.dir * rail.clientWidth * .85, behavior: reduced ? 'auto' : 'smooth' })));
    rail.addEventListener('scroll', upd, { passive: true });
    new ResizeObserver(upd).observe(rail);
    // A mouse wheel turned over a row of cards scrolls it sideways.
    rail.addEventListener('wheel', e => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) return;
      const max = rail.scrollWidth - rail.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && rail.scrollLeft <= 0) || (e.deltaY > 0 && rail.scrollLeft >= max - 1)) return;
      e.preventDefault(); rail.scrollLeft += e.deltaY;
    }, { passive: false });
  });

  // ---------- Discography filters ----------
  const chips = $('chips');
  if (chips) chips.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    chips.querySelectorAll('.chip').forEach(c => { const on = c === b; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); });
    document.querySelectorAll('#disc .card').forEach(c => c.classList.toggle('hide', b.dataset.f !== 'all' && c.dataset.type !== b.dataset.f));
  });

  const about = $('about');
  if (about) about.addEventListener('click', () => about.classList.toggle('open'));

  // ---------- Numbers count up as they come into view ----------
  const counters = document.querySelectorAll('[data-n]');
  if (counters.length && !reduced && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => es.forEach(en => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      const el = en.target, n = +el.dataset.n, t0 = performance.now();
      if (!n) return;
      const step = now => {
        const p = Math.min(1, (now - t0) / 1100), v = Math.round(n * (1 - Math.pow(1 - p, 4)));
        el.textContent = v.toLocaleString();
        if (p < 1) requestAnimationFrame(step);
      };
      el.textContent = '0'; requestAnimationFrame(step);
    }), { threshold: .4 });
    counters.forEach(c => io.observe(c));
  }

  if (!D.canPlay || !tracks.length) return;

  // ---------- Player ----------
  const audio = new Audio();
  audio.preload = 'none';
  const seek = $('seek'), cur = $('cur'), dur = $('dur'), mini = $('mini');
  const mainBtn = $('play'), miniBtn = $('mini-play'), prevBtn = $('prev'), nextBtn = $('next');
  const rows = [...document.querySelectorAll('.row[data-i]')];
  let idx = -1, dragging = false;
  // A shared moment (?t=73): start there, and carry it into the app.
  const startAt = D.kind === 'track' ? Math.max(0, parseInt(new URLSearchParams(location.search).get('t') || '0', 10) || 0) : 0;

  const setIcon = (btn, on) => {
    if (!btn) return;
    btn.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
    btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  };
  const isPlaying = () => !audio.paused && !audio.ended;
  const paint = () => {
    const on = isPlaying();
    setIcon(mainBtn, on); setIcon(miniBtn, on);
    body.classList.toggle('is-playing', on);
    V.playing = on;
    rows.forEach(r => { const me = +r.dataset.i === idx; r.classList.toggle('on', me); r.classList.toggle('playing', me && on); });
    if (prevBtn) prevBtn.disabled = idx <= 0 && audio.currentTime < 3;
    if (nextBtn) nextBtn.disabled = idx >= tracks.length - 1;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  };
  const progress = () => {
    const d = audio.duration || (tracks[idx] || {}).d || 0, t = audio.currentTime || 0;
    const p = d ? Math.min(1, t / d) : 0;
    if (mini) mini.style.setProperty('--p', p.toFixed(4));
    if (!seek || dragging) return;
    seek.value = Math.round(p * 1000);
    seek.style.setProperty('--p', (p * 100).toFixed(2) + '%');
    cur.textContent = fmt(t);
    if (d) dur.textContent = fmt(d);
  };

  function load(i) {
    idx = i;
    const t = tracks[i];
    audio.src = t.src;
    if (startAt && i === 0) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = Math.min(startAt, Math.max(0, audio.duration - 2)); } catch (e) { /* not seekable */ } }, { once: true });
    if (dur) dur.textContent = fmt(t.d);
    // Under the controls: what's playing, when it isn't the song the page is about.
    const np = $('np');
    if (np) { $('np-t').textContent = `${t.t} · ${t.a}`; np.classList.toggle('show', !(D.kind === 'track' && i === 0)); }
    if (mini) {
      $('mini-t').textContent = t.t; $('mini-a').textContent = t.a;
      const art = $('mini-art'), src = t.c || D.cover;
      if (src && art.getAttribute('src') !== src) art.src = src;
    }
    showMini();
    if ('mediaSession' in navigator && window.MediaMetadata) {
      const art = t.c || D.cover;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.t, artist: t.a, album: D.kind === 'album' && i < D.main ? D.title : '',
        artwork: art ? [{ src: new URL(art, location.href).href, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    }
    progress();
  }
  function start() {
    V.attach(audio);
    if (V.ctx && V.ctx.state === 'suspended') V.ctx.resume();
    const p = audio.play();
    if (p && p.catch) p.catch(e => { if (e.name !== 'AbortError') { toast("This song couldn't be played."); paint(); } });
  }
  function playAt(i) {
    if (i < 0 || i >= tracks.length) return;
    if (i !== idx) { load(i); start(); return; }
    if (audio.paused) start(); else audio.pause();
  }
  const toggle = () => playAt(idx < 0 ? 0 : idx);
  const nextSong = () => { if (idx + 1 < tracks.length) playAt(idx + 1); };
  const prevSong = () => { if (audio.currentTime > 3 || idx <= 0) { audio.currentTime = 0; progress(); } else playAt(idx - 1); };
  if (startAt) {
    document.querySelectorAll('a[href$="/open"]').forEach(a => { a.href += '?t=' + startAt; });
    const h = document.querySelector('h1');
    if (h) h.insertAdjacentHTML('afterend', `<p class="moment">▶ From ${fmt(startAt)}</p>`);
  }

  // The mini player shows on one-column pages once the controls have scrolled out of sight.
  let deckSeen = true;
  function showMini() {
    const on = idx >= 0 && !deckSeen;
    if (mini) mini.classList.toggle('show', on);
    body.classList.toggle('has-mini', idx >= 0);
  }
  const deck = $('deck');
  if (deck && 'IntersectionObserver' in window) {
    new IntersectionObserver(([en]) => { deckSeen = en.isIntersecting; showMini(); }, { threshold: 0 }).observe(deck);
  }
  if (mini) mini.addEventListener('click', e => { if (!e.target.closest('button')) deck.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' }); });

  if (mainBtn) mainBtn.addEventListener('click', toggle);
  if (miniBtn) miniBtn.addEventListener('click', toggle);
  if (prevBtn) prevBtn.addEventListener('click', prevSong);
  if (nextBtn) nextBtn.addEventListener('click', nextSong);
  rows.forEach(r => {
    r.addEventListener('click', e => { if (!e.target.closest('a')) playAt(+r.dataset.i); });
    r.addEventListener('keydown', e => { if (e.target === r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playAt(+r.dataset.i); } });
  });

  if (seek) {
    seek.addEventListener('input', () => {
      dragging = true;
      const d = audio.duration || (tracks[idx] || tracks[0]).d || 0;
      seek.style.setProperty('--p', seek.value / 10 + '%');
      cur.textContent = fmt(seek.value / 1000 * d);
    });
    seek.addEventListener('change', () => {
      dragging = false;
      if (idx < 0) { load(0); start(); }
      const d = audio.duration || (tracks[idx] || {}).d || 0;
      if (d) audio.currentTime = seek.value / 1000 * d;
    });
  }

  ['play', 'pause', 'playing', 'ended'].forEach(ev => audio.addEventListener(ev, paint));
  audio.addEventListener('waiting', () => mainBtn && mainBtn.classList.add('loading'));
  ['playing', 'pause', 'error'].forEach(ev => audio.addEventListener(ev, () => mainBtn && mainBtn.classList.remove('loading')));
  audio.addEventListener('timeupdate', progress);
  audio.addEventListener('durationchange', progress);
  // When the page's songs end, the similar ones play on after them.
  audio.addEventListener('ended', () => { if (idx + 1 < tracks.length) { load(idx + 1); start(); } else { audio.currentTime = 0; progress(); } });
  audio.addEventListener('error', () => { if (audio.src) { toast("This song couldn't be played."); paint(); } });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession, set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) { /* unsupported */ } };
    set('play', toggle); set('pause', () => audio.pause());
    set('seekto', e => { if (e.seekTime != null) { audio.currentTime = e.seekTime; progress(); } });
    if (tracks.length > 1) { set('nexttrack', nextSong); set('previoustrack', prevSong); }
  }

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === ' ' && !['input', 'button', 'a', 'textarea', 'li'].includes(tag)) { e.preventDefault(); toggle(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && tag !== 'input' && idx >= 0) {
      audio.currentTime = Math.max(0, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)); progress();
    }
  });
  paint();
})();
