// Runs in every page of the app's windows, apart from the page's own scripts.
// On the server's player: tells the app what's playing (taskbar buttons, tray, mini player), and gives the player
// what the app adds (window.axdioDesktop: the mini player and Discord status).
// On the app's own pages (connecting to a server, offline, the mini player): gives them what they need from the app.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('axdioDesktop', {
    connect: address => ipcRenderer.invoke('axdio:connect', address),
    retry: () => ipcRenderer.invoke('axdio:retry'),
    info: () => ipcRenderer.invoke('axdio:info'),
    now: () => ipcRenderer.invoke('axdio:now'),
    onNow: fn => ipcRenderer.on('axdio:now', (e, n) => fn(n)),
    cmd: c => ipcRenderer.send('axdio:cmd', String(c)),
  });
} else {
  // "axdioApp", not "axdioDesktop": the player's desktop.js has a function by that name.
  contextBridge.exposeInMainWorld('axdioApp', {
    app: 'windows',
    mini: () => ipcRenderer.send('axdio:cmd', 'mini'),
    discord: {
      get: () => ipcRenderer.invoke('axdio:discord-get'),
      set: on => ipcRenderer.invoke('axdio:discord-set', !!on),
    },
  });

  let last = '', lastPos = -1;
  const deck = () => {
    const audios = [...document.querySelectorAll('audio')].filter(a => a.currentSrc);
    return audios.find(a => !a.paused && !a.ended) || audios.sort((x, y) => y.currentTime - x.currentTime)[0] || null;
  };
  // While the player shows and controls another device (Connect), it says what plays there.
  const remote = () => { try { return JSON.parse(document.documentElement.dataset.axRemote || 'null'); } catch (e) { return null; } };
  const report = force => {
    const a = deck(), r = remote();
    const playing = r ? !!r.playing : !!(a && !a.paused && !a.ended);
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const hasTrack = !!((md && md.title) || a || r);
    const art = md && md.artwork && md.artwork.length ? (md.artwork.find(x => x.sizes === '384x384') || md.artwork[md.artwork.length - 1]).src : '';
    const s = {
      playing, hasTrack,
      title: md ? md.title || '' : '', artist: md ? md.artist || '' : '', album: md ? md.album || '' : '',
      art: art ? new URL(art, location.href).href : '',
      pos: r ? r.pos + (r.playing ? (Date.now() - r.at) / 1000 : 0) : a ? a.currentTime || 0 : 0,
      dur: r ? r.dur || 0 : a && isFinite(a.duration) ? a.duration : 0,
      remote: r ? r.name || '' : '',
    };
    const key = JSON.stringify([s.playing, s.hasTrack, s.title, s.artist, s.art, Math.round(s.dur), s.remote]);
    // Position: sent each second while playing (the mini player moves smoothly in between), and on any jump.
    const jumped = Math.abs(s.pos - lastPos) > 2.5 || !playing;
    if (!force && key === last && !(playing || jumped)) return;
    last = key; lastPos = s.pos;
    ipcRenderer.send('axdio:state', s);
  };
  // Media events don't bubble; caught on the way down, they're seen for every <audio> on the page.
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'seeked', 'durationchange']) {
    document.addEventListener(ev, () => setTimeout(() => report(true), 50), true);
  }
  document.addEventListener('axdio:remote', () => setTimeout(() => report(true), 50));
  setInterval(() => report(false), 1000);
}
