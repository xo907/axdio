// Runs in every page of the window, apart from the page's own scripts.
// On the server's player: tells the app what's playing (for the taskbar buttons and the tray).
// On the app's own pages (connecting to a server, offline): gives them what they need from the app.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('axdioDesktop', {
    connect: address => ipcRenderer.invoke('axdio:connect', address),
    retry: () => ipcRenderer.invoke('axdio:retry'),
    info: () => ipcRenderer.invoke('axdio:info'),
  });
} else {
  let last = '';
  const report = () => {
    const audios = [...document.querySelectorAll('audio')];
    const playing = audios.some(a => !a.paused && !a.ended && a.currentSrc);
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const hasTrack = !!(md && md.title) || audios.some(a => a.currentSrc);
    const title = md && md.title ? `${md.title}${md.artist ? ' · ' + md.artist : ''}` : '';
    const key = JSON.stringify([playing, hasTrack, title]);
    if (key === last) return;
    last = key;
    ipcRenderer.send('axdio:state', { playing, hasTrack, title });
  };
  // Media events don't bubble; caught on the way down, they're seen for every <audio> on the page.
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata']) document.addEventListener(ev, () => setTimeout(report, 50), true);
  setInterval(report, 3000);
}
