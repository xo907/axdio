// Axdio for Windows: the player from your Axdio server, as a desktop app.
// The server's own web player runs in the window; this adds what a browser tab can't: a window of its own with the
// Windows title bar buttons over the player's top bar, play / pause / next under the taskbar thumbnail and in the
// jump list, a mini player that stays on top, Discord status, a tray icon (it keeps playing when the window is
// closed), starting with Windows, updating itself, and remembering where its windows were.
// Media keys and the Windows media overlay come from the player itself (it tells the system what's playing).
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, session, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Presence } = require('./discord');

const ASSETS = path.join(__dirname, '..', 'assets');
const asset = name => nativeImage.createFromPath(path.join(ASSETS, name));
const TOP = 64;                                   // the player's top bar (desktop.css --top-h)
const MINI = { width: 400, height: 112 };

// A profile of its own (for trying things out without touching the real one): AXDIO_PROFILE=<folder>.
if (process.env.AXDIO_PROFILE) app.setPath('userData', path.resolve(process.env.AXDIO_PROFILE));

// ---------- Settings (in %APPDATA%\Axdio\settings.json) ----------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let settings = { server: '', bounds: null, maximized: false, closeToTray: true, trayNoticeShown: false, miniBounds: null, discord: null };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '')) }; } catch (e) { /* first run */ }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { /* read-only profile */ }
  }, 300);
}
const LOG_FILE = path.join(app.getPath('userData'), 'axdio-app.log');
function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (e) { /* nowhere to write */ }
}

// One Axdio at a time: opening it again brings the window back (or, from the jump list, plays, skips…).
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('com.xo.axdio.desktop');    // the taskbar and notifications know it as Axdio

let win = null, mini = null, tray = null, quitting = false, updateReady = '', presence = null;
const now = { playing: false, hasTrack: false, title: '', artist: '', album: '', art: '', pos: 0, dur: 0, liked: null };

const origin = () => { try { return new URL(settings.server).origin; } catch (e) { return ''; } };
const isServer = url => { try { return origin() && new URL(url).origin === origin(); } catch (e) { return false; } };

// ---------- The window ----------
function onScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
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
  wc.on('before-input-event', (e, input) => keys(e, input, wc));

  if (settings.server) win.loadURL(settings.server); else showLocal('setup.html');
}

function keys(e, input, wc) {
  if (input.type !== 'keyDown') return;
  const k = input.key, ctrl = input.control || input.meta;
  if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) { e.preventDefault(); input.shift ? wc.reloadIgnoringCache() : wc.reload(); }
  else if (k === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  else if (ctrl && input.shift && k.toLowerCase() === 'i') { e.preventDefault(); wc.toggleDevTools(); }
  else if (ctrl && input.shift && k.toLowerCase() === 'm') { e.preventDefault(); toggleMini(); }
  else if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); wc.setZoomLevel(Math.min(3, wc.getZoomLevel() + 0.5)); }
  else if (ctrl && k === '-') { e.preventDefault(); wc.setZoomLevel(Math.max(-3, wc.getZoomLevel() - 0.5)); }
  else if (ctrl && k === '0') { e.preventDefault(); wc.setZoomLevel(0); }
  else if (input.alt && k === 'ArrowLeft' && wc.navigationHistory.canGoBack()) { e.preventDefault(); wc.navigationHistory.goBack(); }
  else if (input.alt && k === 'ArrowRight' && wc.navigationHistory.canGoForward()) { e.preventDefault(); wc.navigationHistory.goForward(); }
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

// ---------- Driving the player ----------
// The page (preload.js) says what's playing; these drive the player's own controls.
function inPlayer(js) {
  if (!win || win.isDestroyed() || !isServer(win.webContents.getURL())) return Promise.resolve(null);
  return win.webContents.executeJavaScript(`(() => { try { const A = window.AX; if (!A) return null; ${js} } catch (e) { return null; } })()`).catch(() => null);
}
const LIKED_JS = 'const t = A.curTrack(); if (!t) return null; return t.ext ? !!(A.Src && A.Src.liked(t)) : !!(A.U && A.U.likedSet && A.U.likedSet.has(t.rel));';
const control = {
  toggle: () => inPlayer('A.togglePlay(); return 1;'),
  next: () => inPlayer('A.next(); return 1;'),
  prev: () => inPlayer('A.prev(); return 1;'),
  seek: sec => inPlayer(`A.seek(${Math.max(0, +sec || 0)}); return 1;`),
  like: async () => { await inPlayer('const t = A.curTrack(); if (t) A.toggleLike(t); return 1;'); setTimeout(refreshLiked, 250); },
};
async function refreshLiked() {
  const v = await inPlayer(LIKED_JS);
  if (v !== now.liked) { now.liked = v; sendNow(); }
}
function runCommand(c) {
  if (c === 'mini') toggleMini();
  else if (c === 'close-mini') closeMini();
  else if (c === 'expand') { closeMini(); showWindow(); }
  else if (c.startsWith('seek:')) control.seek(c.slice(5));
  else if (control[c]) control[c]();
}
ipcMain.on('axdio:cmd', (e, c) => runCommand(String(c || '')));

ipcMain.on('axdio:state', (e, s) => {
  if (!win || e.sender !== win.webContents) return;
  const changedTrack = s.title !== now.title || s.artist !== now.artist || s.hasTrack !== now.hasTrack;
  const changedPlay = s.playing !== now.playing || s.hasTrack !== now.hasTrack;
  Object.assign(now, {
    playing: !!s.playing, hasTrack: !!s.hasTrack, title: String(s.title || '').slice(0, 200), artist: String(s.artist || '').slice(0, 200),
    album: String(s.album || '').slice(0, 200), art: /^https?:\/\//.test(s.art || '') ? s.art : '', pos: +s.pos || 0, dur: +s.dur || 0,
  });
  if (changedPlay) updateThumbar();
  if (changedTrack) { now.liked = null; refreshLiked(); }
  if (changedTrack || changedPlay) refreshTray();
  sendNow();
});
function sendNow() { if (mini && !mini.isDestroyed()) mini.webContents.send('axdio:now', now); }
ipcMain.handle('axdio:now', () => now);

function updateThumbar() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (!now.hasTrack) { win.setThumbarButtons([]); return; }
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: asset('prev.png'), click: control.prev },
    { tooltip: now.playing ? 'Pause' : 'Play', icon: asset(now.playing ? 'pause.png' : 'play.png'), click: control.toggle },
    { tooltip: 'Next', icon: asset('next.png'), click: control.next },
  ]);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// ---------- Mini player ----------
// A small window that stays on top: the artwork, what's playing, the controls. Opening it puts the main window
// away; its open button brings that back.
function toggleMini(force) {
  const open = !!(mini && !mini.isDestroyed());
  if (force === false || (force == null && open)) { closeMini(); showWindow(); return; }
  if (open) { mini.show(); mini.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = settings.miniBounds && onScreen({ ...settings.miniBounds, ...MINI }) ? { x: settings.miniBounds.x, y: settings.miniBounds.y }
    : { x: wa.x + wa.width - MINI.width - 24, y: wa.y + wa.height - MINI.height - 24 };
  mini = new BrowserWindow({
    ...b, ...MINI, frame: false, resizable: false, maximizable: false, minimizable: true, fullscreenable: false, alwaysOnTop: true,
    show: false, title: 'Axdio mini player', backgroundColor: '#121214', icon: path.join(ASSETS, 'icon.png'), roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  mini.setAlwaysOnTop(true, 'floating');
  mini.setMenu(null);
  mini.loadFile(path.join(__dirname, 'mini.html'));
  mini.once('ready-to-show', () => { mini.show(); sendNow(); });
  mini.on('moved', () => { if (mini && !mini.isDestroyed()) { settings.miniBounds = mini.getBounds(); save(); } });
  mini.on('closed', () => { mini = null; refreshTray(); });
  mini.webContents.on('before-input-event', (e, input) => {
    const k = (input.key || '').toLowerCase();
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && k === 'm') { e.preventDefault(); toggleMini(false); }
  });
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mini.webContents.on('will-navigate', e => e.preventDefault());
  if (win && win.isVisible()) win.hide();
  refreshTray();
  refreshLiked();
}
function closeMini() {
  if (mini && !mini.isDestroyed()) mini.close();
  mini = null;
}

// ---------- Discord status ----------
// The app keeps a key of its own for the server's Discord feed (asked for with the listener's sign-in, through the
// player), and hands what the feed says to Discord on this computer. A helper script set up before stops by itself
// once this key is made (its own stops working).
function discordState() {
  const d = settings.discord;
  return { on: !!(d && d.key && d.server === origin()), connected: presence ? presence.connected : null };
}
function startPresence() {
  if (presence) { presence.stop(); presence = null; }
  const d = settings.discord;
  if (!d || !d.key || d.server !== origin()) return;
  presence = new Presence({
    fetch: (u, o) => net.fetch(u, o), server: d.server, key: d.key,
    onRevoked: () => { log('Discord status was turned off on the server'); settings.discord = null; save(); presence = null; refreshTray(); },
    onChange: () => refreshTray(),
  });
  presence.start();
}
async function setDiscord(on) {
  if (on) {
    const r = await inPlayer("return A.api('/api/user/presence', {}).then(d => d, e => ({ error: e.message }));");
    if (!r) return { error: 'Open the player and sign in first.' };
    if (r.error || !r.key) return { error: r.error || 'This server is older than Axdio 2.22, which Discord status in the app needs.' };
    settings.discord = { server: origin(), key: r.key }; save();
    startPresence();
    log('Discord status on');
  } else {
    if (presence) { await presence.stop(); presence = null; }
    await inPlayer("return A.api('/api/user/presence', undefined, 'DELETE').then(() => 1, () => 0);");
    settings.discord = null; save();
    log('Discord status off');
  }
  refreshTray();
  return discordState();
}
ipcMain.handle('axdio:discord-get', () => discordState());
ipcMain.handle('axdio:discord-set', (e, on) => setDiscord(!!on));

// ---------- Updates ----------
// Installed copies look for a new version (on GitHub, the "windows-latest" release) a little after starting and
// every few hours, download it in the background, and install it when Axdio quits (or now, from the tray).
let updater = null;
function setupUpdates() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;      // the portable app is updated by hand
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { log('updater unavailable: ' + e.message); return; }
  if (process.env.AXDIO_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.AXDIO_UPDATE_URL });
  updater.autoDownload = true;
  updater.disableWebInstaller = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info: m => log('update: ' + m), warn: m => log('update (warn): ' + m), error: m => log('update (error): ' + m), debug: () => {} };
  updater.on('update-downloaded', info => {
    updateReady = info.version;
    refreshTray();
    if (tray) tray.displayBalloon({ title: `Axdio ${info.version} is ready`, content: 'It installs when you quit Axdio. Or right-click the Axdio icon in the tray and choose Restart to update.', icon: asset('icon.png'), noSound: true });
  });
  updater.on('error', e => log('update error: ' + (e && e.message)));
  const check = () => updater.checkForUpdates().catch(e => log('update check failed: ' + e.message));
  setTimeout(check, +process.env.AXDIO_UPDATE_DELAY || 20000);
  setInterval(check, 6 * 3600 * 1000);
}

// ---------- Tray and jump list ----------
function trayMenu() {
  const d = discordState();
  return Menu.buildFromTemplate([
    { label: 'Open Axdio', click: showWindow },
    { label: mini ? 'Close the mini player' : 'Mini player', accelerator: 'Ctrl+Shift+M', click: () => toggleMini() },
    { type: 'separator' },
    ...(now.hasTrack ? [
      { label: (now.title ? `${now.title}${now.artist ? ' · ' + now.artist : ''}` : 'Now playing').slice(0, 64), enabled: false },
      { label: now.playing ? 'Pause' : 'Play', click: control.toggle },
      { label: 'Next', click: control.next },
      { label: 'Previous', click: control.prev },
      { type: 'separator' },
    ] : []),
    { label: 'Show what I play on Discord', type: 'checkbox', checked: d.on, enabled: !!origin(),
      click: m => setDiscord(m.checked).then(r => { if (r && r.error && tray) tray.displayBalloon({ title: 'Discord status', content: r.error, icon: asset('icon.png'), noSound: true }); }) },
    { label: 'Keep playing when the window is closed', type: 'checkbox', checked: settings.closeToTray, click: m => { settings.closeToTray = m.checked; save(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: m => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
    { label: 'Change server…', click: () => { closeMini(); showWindow(); showLocal('setup.html', { server: settings.server }); } },
    { type: 'separator' },
    ...(updateReady ? [{ label: `Restart to update to Axdio ${updateReady}`, click: () => { quitting = true; updater.quitAndInstall(true, true); } }] : []),
    { label: `Axdio for Windows ${app.getVersion()}`, enabled: false },
    { label: 'Quit Axdio', click: () => { quitting = true; app.quit(); } },
  ]);
}
let trayTimer = 0;
function refreshTray() {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => {
    if (!tray) return;
    tray.setToolTip(now.hasTrack && now.title ? `Axdio · ${now.title}`.slice(0, 120) : 'Axdio');
    tray.setContextMenu(trayMenu());
  }, 60);
}

function createTray() {
  const img = asset('tray.png');
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, 'tray@2x.png')) });
  tray = new Tray(img);
  tray.setToolTip('Axdio');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
}

// The jump list (right-click Axdio on the taskbar): play / pause, next, previous and the mini player, without
// opening the window. Each starts Axdio again with a command; the running Axdio gets it (second-instance).
function setJumpList() {
  const pre = process.defaultApp ? `"${app.getAppPath()}" ` : '';
  const task = (cmd, title, description) => ({ program: process.execPath, arguments: `${pre}--axdio=${cmd}`, iconPath: process.execPath, iconIndex: 0, title, description });
  try {
    app.setUserTasks([
      task('toggle', 'Play / pause', 'Play or pause the music'),
      task('next', 'Next', 'Skip to the next song'),
      task('prev', 'Previous', 'Back to the previous song'),
      task('mini', 'Mini player', 'Open the mini player'),
    ]);
  } catch (e) { log('jump list: ' + e.message); }
}
const commandIn = argv => { const a = (argv || []).find(x => /^--axdio=/.test(x)); return a ? a.slice(8) : ''; };

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
        if (url !== settings.server && presence) { presence.stop(); presence = null; }
        settings.server = url; save();
        win.loadURL(url);
        startPresence();
        refreshTray();
        return { ok: true, version: d.version };
      }
    } catch (err) { /* try the next, or say so below */ }
  }
  return { ok: false, error: "Couldn't reach an Axdio server there. Check the address, and that the server is running." };
});
ipcMain.handle('axdio:retry', () => { if (settings.server) win.loadURL(settings.server); });
ipcMain.handle('axdio:info', () => ({ server: settings.server, version: app.getVersion() }));

// ---------- Start ----------
app.on('second-instance', (e, argv) => {
  const c = commandIn(argv);
  if (c) runCommand(c); else showWindow();
});
app.on('before-quit', () => { quitting = true; if (presence) presence.stop(); });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  // The server may ask for the microphone (voice messages) and notifications; nothing else does.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isServer(details.requestingUrl || wc.getURL()) && ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'mediaKeySystem'].includes(permission));
  });
  createWindow();
  createTray();
  setJumpList();
  startPresence();
  setupUpdates();
  log(`started ${app.getVersion()}`);
});
