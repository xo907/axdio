# Axdio for Windows

Your Axdio server's player as a Windows app (Electron). The server's own web player runs in the window, so the app
works with any Axdio server and gets new player features when the server updates. The app adds:

- a server picker on first launch (Change server… in the tray menu later)
- the player's top bar as the title bar (drag it; the Windows buttons sit in its corner)
- a **mini player** that stays on top of other windows: artwork, what's playing, a progress bar you can click,
  like, previous / play / next (Ctrl+Shift+M, the tray menu, the jump list, or the player's own miniplayer button)
- **Discord status** built in: Settings → Show what I play on Discord (or the tray menu). The app talks to Discord on
  this computer itself; there's no helper to install. Turning it on replaces a helper set up before (that one stops)
- play / pause / next / previous under the taskbar thumbnail, in the **jump list** (right-click Axdio on the taskbar)
  and in the tray menu
- media keys and the Windows media flyout (from the player's own media session)
- **updates itself**: the installed app looks for a new version a little after it starts and every few hours,
  downloads it in the background and installs it when you quit (or now: tray → Restart to update)
- keeps playing in the tray when the window is closed (can be turned off in the tray menu), Start with Windows
- remembers where its windows were; F11 full screen, Ctrl +/−/0 zoom, F5 reload, Alt ←/→ back and forward
- shared song, album and artist links open in the player; the admin panel and other sites open in the browser
- opens without a connection (the player's offline copy), else a "Can't reach your server" page that retries

## Build

```
npm install
npm run dist
```

`dist/Axdio-Setup-<version>.exe` installs for the current user (no admin rights); `dist/Axdio-<version>-portable.exe`
runs without installing. `npm start` runs it from source. The icons are rendered from SVG by `scripts/icons.js`.

Releases: set the version in `package.json`, then push a tag `windows-v<version>`; the *Windows app* workflow builds
both and publishes them as a GitHub release.

Settings live in `%APPDATA%\Axdio\settings.json`, and a log in `axdio-app.log` next to it. To try things without
touching that, start it with `AXDIO_PROFILE=<folder>` (a profile of its own); `AXDIO_UPDATE_URL=<folder URL>` makes it
look for updates there instead. The builds aren't code-signed, so Windows SmartScreen warns the first
time (More info → Run anyway).
