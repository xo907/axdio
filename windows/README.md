# Axdio for Windows

Your Axdio server's player as a Windows app (Electron). The server's own web player runs in the window, so the app
works with any Axdio server and gets new player features when the server updates. The app adds:

- a server picker on first launch (Change server… in the tray menu later)
- the player's top bar as the title bar (drag it; the Windows buttons sit in its corner)
- play / pause / next / previous under the taskbar thumbnail, and in the tray menu
- media keys and the Windows media flyout (from the player's own media session)
- keeps playing in the tray when the window is closed (can be turned off in the tray menu), Start with Windows
- remembers the window's size and place; F11 full screen, Ctrl +/−/0 zoom, F5 reload, Alt ←/→ back and forward
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

Settings live in `%APPDATA%\Axdio\settings.json`. The builds aren't code-signed, so Windows SmartScreen warns the first
time (More info → Run anyway).
