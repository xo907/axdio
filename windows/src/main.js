// Axdio for Windows: the player from your Axdio server, as a desktop app.
// The server's own web player runs in the window; this adds what a browser tab can't: a window of its own with the
// Windows title bar buttons over the player's top bar, play / pause / next under the taskbar thumbnail, a tray icon
// (it keeps playing when the window is closed), starting with Windows, and remembering where the window was.
// Media keys and the Windows media overlay come from the player itself (it tells the system what's playing).
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, session, net, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const ASSETS = path.join(__dirname, '..', 'assets');
const asset = name => nativeImage.createFromPath(path.join(ASSETS, name));
const TOP = 64;                                   // the player's top bar (desktop.css --top-h)

// ---------- Settings (in %APPDATA%\Axdio\settings.json) ----------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let settings = { server: '', bounds: null, maximized: false, closeToTray: true, trayNoticeShown: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) { /* first run */ }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { /* read-only profile */ }
  }, 300);
}

// One Axdio at a time: opening it again brings the window back.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('com.xo.axdio.desktop');    // the taskbar and notifications know it as Axdio

let win = null, tray = null, quitting = false;
const now = { playing: false, title: '', hasTrack: false };

const origin = () => { try { return new URL(settings.server).origin; } catch (e) { return ''; } };
const isServer = url => { try { return origin() && new URL(url).origin === origin(); } catch (e) { return false; } };

// ---------- The window ----------
function onScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
}

function createWindow() {
  const b = onScreen(settings.bounds) ? settings.bounds : { width: 1320, height: 840 };
  win = new BrowserWindow({
    ...b, minWidth: 820, minHeight: 560, show: false, backgroundColor: '#000000', title: 'Axdio',
    icon: path.join(ASSETS, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: TOP },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });   // --hidden: started with Windows

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isMinimized() && !win.isFullScreen()) settings.bounds = win.getBounds();
    save();
  };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach(ev => win.on(ev, remember));

  // Closing the window keeps the music going in the tray (unless that's turned off, or Axdio is quitting).
  win.on('close', e => {
    if (quitting || !settings.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayNoticeShown && tray) {
      settings.trayNoticeShown = true; save();
      tray.displayBalloon({ title: 'Axdio is still here', content: 'Your music keeps playing. Click the Axdio icon in the tray to open it again, or right-click it to quit.', icon: asset('icon.png'), noSound: true });
    }
  });
  win.on('show', updateThumbar);

  const wc = win.webContents;
  wc.on('did-finish-load', () => { decorate(); updateThumbar(); });
  wc.on('did-navigate-in-page', decorate);
  wc.on('did-fail-load', (e, code, desc, url, mainFrame) => {
    if (!mainFrame || code === -3) return;            // -3: navigation replaced by another one
    if (isServer(url)) showLocal('offline.html', { server: settings.server, error: desc });
  });
  wc.on('page-title-updated', (e, title) => { e.preventDefault(); win.setTitle(title || 'Axdio'); });

  // Links: the server's own pages stay in the app (a shared song, album or artist opens in the player); the admin
  // panel and everything else open in the browser.
  wc.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (!isServer(url)) { e.preventDefault(); openLink(url); return; }
    const u = new URL(url);
    if (/^\/admin/.test(u.pathname)) { e.preventDefault(); shell.openExternal(url); return; }
    const share = /^\/(track|album|artist)\/[0-9A-Za-z]{11}$/.exec(u.pathname);
    if (share) { e.preventDefault(); wc.loadURL(origin() + u.pathname + '/open' + u.search); }
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key, ctrl = input.control || input.meta;
    if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) { e.preventDefault(); input.shift ? wc.reloadIgnoringCache() : wc.reload(); }
    else if (k === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (ctrl && input.shift && k.toLowerCase() === 'i') { e.preventDefault(); wc.toggleDevTools(); }
    else if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); wc.setZoomLevel(Math.min(3, wc.getZoomLevel() + 0.5)); }
    else if (ctrl && k === '-') { e.preventDefault(); wc.setZoomLevel(Math.max(-3, wc.getZoomLevel() - 0.5)); }
    else if (ctrl && k === '0') { e.preventDefault(); wc.setZoomLevel(0); }
    else if (input.alt && k === 'ArrowLeft' && wc.navigationHistory.canGoBack()) { e.preventDefault(); wc.navigationHistory.goBack(); }
    else if (input.alt && k === 'ArrowRight' && wc.navigationHistory.canGoForward()) { e.preventDefault(); wc.navigationHistory.goForward(); }
  });

  if (settings.server) win.loadURL(settings.server); else showLocal('setup.html');
}

function openLink(url) {
  if (/^https?:/i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
}

function showLocal(page, query = {}) {
  win.loadFile(path.join(__dirname, page), { query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v || '')])) });
}

// The player's top bar becomes the title bar: it drags the window, its buttons and search still work, and it makes
// room for the Windows buttons on the right. Other pages of the server get a thin bar to drag by.
const PLAYER_CSS = `
  #top { -webkit-app-region: drag; }
  #top button, #top input, #top a, #top .search-wrap, #top [data-act], #top .avatar-btn, #top select { -webkit-app-region: no-drag; }
  #top .top-right { margin-right: 138px; }
  .mobile-hint { display: none !important; }
`;
const PAGE_CSS = `
  html::before { content: ""; position: fixed; z-index: 2147483647; top: 0; left: 0; right: 138px; height: 10px; -webkit-app-region: drag; }
`;
function decorate() {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents, url = wc.getURL();
  if (!isServer(url)) return;
  wc.executeJavaScript('!!document.getElementById("top")').then(player => wc.insertCSS(player ? PLAYER_CSS : PAGE_CSS)).catch(() => {});
}

// ---------- Playing: taskbar buttons, tray, title ----------
// The page (preload.js) says when playback starts or stops; the buttons drive the player's own controls.
const run = js => { if (win && !win.isDestroyed() && isServer(win.webContents.getURL())) win.webContents.executeJavaScript(`(() => { try { const A = window.AX; if (A) { ${js} } } catch (e) {} })()`).catch(() => {}); };
const control = {
  toggle: () => run('A.togglePlay()'),
  next: () => run('A.next()'),
  prev: () => run('A.prev()'),
};

function updateThumbar() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (!now.hasTrack) { win.setThumbarButtons([]); return; }
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: asset('prev.png'), click: control.prev },
    { tooltip: now.playing ? 'Pause' : 'Play', icon: asset(now.playing ? 'pause.png' : 'play.png'), click: control.toggle },
    { tooltip: 'Next', icon: asset('next.png'), click: control.next },
  ]);
}

ipcMain.on('axdio:state', (e, s) => {
  if (!win || e.sender !== win.webContents) return;
  const changed = s.playing !== now.playing || s.hasTrack !== now.hasTrack;
  Object.assign(now, { playing: !!s.playing, title: String(s.title || '').slice(0, 120), hasTrack: !!s.hasTrack });
  if (changed) updateThumbar();
  if (tray) { tray.setToolTip(now.hasTrack ? `Axdio · ${now.title}` : 'Axdio'); tray.setContextMenu(trayMenu()); }
});

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Axdio', click: showWindow },
    { type: 'separator' },
    ...(now.hasTrack ? [
      { label: now.title || 'Now playing', enabled: false },
      { label: now.playing ? 'Pause' : 'Play', click: control.toggle },
      { label: 'Next', click: control.next },
      { label: 'Previous', click: control.prev },
      { type: 'separator' },
    ] : []),
    { label: 'Keep playing when the window is closed', type: 'checkbox', checked: settings.closeToTray, click: m => { settings.closeToTray = m.checked; save(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: m => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
    { label: 'Change server…', click: () => { showWindow(); showLocal('setup.html', { server: settings.server }); } },
    { type: 'separator' },
    { label: 'Quit Axdio', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const img = asset('tray.png');
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, 'tray@2x.png')) });
  tray = new Tray(img);
  tray.setToolTip('Axdio');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
}

// ---------- Connecting to a server (setup.html) ----------
function normalize(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s) || /:\d+$/.test(s.split('/')[0]) ? 'http://' : 'https://') + s;
  try { const u = new URL(s); return u.origin + u.pathname.replace(/\/+$/, ''); } catch (e) { return null; }
}

ipcMain.handle('axdio:connect', async (e, input) => {
  const base = normalize(input);
  if (!base) return { ok: false, error: "That doesn't look like a server address." };
  const tries = /^https:/.test(base) && !/^https?:\/\//i.test(String(input).trim()) ? [base, base.replace(/^https:/, 'http:')] : [base];
  for (const url of tries) {
    try {
      const r = await net.fetch(url + '/api/health', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (r.ok && d && d.status === 'ok') {
        settings.server = url; save();
        win.loadURL(url);
        return { ok: true, version: d.version };
      }
    } catch (err) { /* try the next, or say so below */ }
  }
  return { ok: false, error: "Couldn't reach an Axdio server there. Check the address, and that the server is running." };
});
ipcMain.handle('axdio:retry', () => { if (settings.server) win.loadURL(settings.server); });
ipcMain.handle('axdio:info', () => ({ server: settings.server, version: app.getVersion() }));

// ---------- Start ----------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  // The server may ask for the microphone (voice messages) and notifications; nothing else does.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isServer(details.requestingUrl || wc.getURL()) && ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'mediaKeySystem'].includes(permission));
  });
  createWindow();
  createTray();
});
