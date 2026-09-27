/* Share pages: plays the shared song, album or artist's popular songs right on the page. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const D = JSON.parse($('share-data').textContent);
  const tracks = D.tracks || [];
  if (!D.canPlay || !tracks.length) return;

  const audio = new Audio();
  audio.preload = 'none';
  const seek = $('seek'), cur = $('cur'), dur = $('dur'), bar = $('bar');
  const mainBtn = $('play'), barBtn = $('bar-play');
  const rows = [...document.querySelectorAll('.row[data-i]')];
  let idx = -1, dragging = false, toastTimer = 0;
  // A shared moment (?t=73): start there, and carry it into the app.
  const startAt = D.kind === 'track' ? Math.max(0, parseInt(new URLSearchParams(location.search).get('t') || '0', 10) || 0) : 0;

  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const toast = msg => {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  };
  const setIcon = (btn, playing) => {
    if (!btn) return;
    btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  const paint = () => {
    const playing = !audio.paused && !audio.ended;
    setIcon(mainBtn, playing); setIcon(barBtn, playing);
    rows.forEach(r => { const on = +r.dataset.i === idx; r.classList.toggle('on', on); r.classList.toggle('playing', on && playing); });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  };
  const progress = () => {
    if (!seek || dragging) return;
    const d = audio.duration || (tracks[idx] || {}).d || 0, t = audio.currentTime || 0;
    const p = d ? Math.min(1, t / d) : 0;
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
    if (bar) {
      $('bar-t').textContent = t.t; $('bar-a').textContent = t.a;
      const art = $('bar-art'), src = t.c || D.cover;
      if (src && art.getAttribute('src') !== src) art.src = src;
      bar.classList.add('show'); document.body.classList.add('has-bar');
    }
    if ('mediaSession' in navigator && window.MediaMetadata) {
      const art = t.c || D.cover;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.t, artist: t.a, album: D.kind === 'album' ? D.title : '',
        artwork: art ? [{ src: new URL(art, location.href).href, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    }
    progress();
  }
  function start() {
    const p = audio.play();
    if (p && p.catch) p.catch(e => { if (e.name !== 'AbortError') { toast("This song couldn't be played."); paint(); } });
  }
  function playAt(i) {
    if (i < 0 || i >= tracks.length) return;
    if (i !== idx) { load(i); start(); return; }
    if (audio.paused) start(); else audio.pause();
  }
  const toggle = () => playAt(idx < 0 ? 0 : idx);
  if (startAt) {
    document.querySelectorAll('a[href$="/open"]').forEach(a => { a.href += '?t=' + startAt; });
    const h = document.querySelector('h1');
    if (h) h.insertAdjacentHTML('afterend', `<p class="moment">▶ From ${fmt(startAt)}</p>`);
  }

  if (mainBtn) mainBtn.addEventListener('click', toggle);
  if (barBtn) barBtn.addEventListener('click', toggle);
  rows.forEach(r => {
    r.addEventListener('click', () => playAt(+r.dataset.i));
    r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playAt(+r.dataset.i); } });
  });

  if (seek) {
    seek.addEventListener('input', () => {
      dragging = true;
      const d = audio.duration || (tracks[idx] || {}).d || 0;
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
  audio.addEventListener('timeupdate', progress);
  audio.addEventListener('durationchange', progress);
  audio.addEventListener('ended', () => { if (idx + 1 < tracks.length) { load(idx + 1); start(); } else { audio.currentTime = 0; progress(); } });
  audio.addEventListener('error', () => { if (audio.src) { toast("This song couldn't be played."); paint(); } });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession, set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) { /* unsupported */ } };
    set('play', toggle); set('pause', () => audio.pause());
    set('seekto', e => { if (e.seekTime != null) { audio.currentTime = e.seekTime; progress(); } });
    if (tracks.length > 1) {
      set('nexttrack', () => playAt(Math.min(tracks.length - 1, idx + 1)));
      set('previoustrack', () => { if (audio.currentTime > 3 || idx <= 0) audio.currentTime = 0; else playAt(idx - 1); });
    }
  }

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === ' ' && !['input', 'button', 'a', 'textarea', 'li'].includes(tag)) { e.preventDefault(); toggle(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && tag !== 'input' && idx >= 0) {
      audio.currentTime = Math.max(0, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)); progress();
    }
  });
})();
