# Changelog

## 2.5.0

- **Updates from the admin panel.** A new **Updates** page shows when a new version of Axdio is out and what's new in it. With the Docker socket mounted, **Update now** installs it: the new image is downloaded, and Axdio is recreated from it with the same settings. If the new version doesn't start properly, the previous one comes back by itself. Updates can also be installed automatically at a chosen hour. New versions are announced by notification too.
- **The Files page keeps the library in step.** Deleting a file or folder removes its songs from the library at once, with no rescan, so the downloader can fetch them again straight away. Renaming moves the songs with their likes, playlist places, offline downloads and history. Renames keep a song's file extension and never overwrite another file.
- A song deleted outside Axdio leaves the library the first time it's played or the downloader looks for it.
- Pages always load the current version of their scripts and styles, so a browser or proxy never holds on to an old copy after an update. For example, the downloader's **Check songs I already have** option could stay hidden.
- To install updates from the panel, add `- /var/run/docker.sock:/var/run/docker.sock` under `volumes:` in `docker-compose.yml` and run `docker compose up -d` once.

## 2.4.0

**Downloader**
- Songs are saved only when a YouTube upload is the exact recording. Its fingerprint must match a preview of that recording on average and throughout, it must be closer to the recording than to the song's other versions (live, remix, instrumental), and its length must match. The old check let official instrumentals and some live performances through as the song, which measurements on real uploads showed. Those are now turned down.
- Streaming links are read from the service's public pages: seconds instead of minutes, with a preview of the exact recording to compare against. Tags carry the linked title, all artists, album, track number, date and artwork. spotDL is now optional (artist links and playlists over 100 songs).
- YouTube links are identified by their audio. Music videos with intros get the plain recording, a video of a featured-artist version gets that version, and covers, live takes and fan edits aren't saved as the original.
- New option **Check songs I already have**. Copies that aren't the right recording (another song, an instrumental, a music-video cut) are replaced at the same path. The old file goes to quarantine. Copies that match are kept without downloading.
- New setting **Save songs that can't be verified**, off by default. Before, such songs were saved silently.
- Deezer's advanced search and ISRC lookups stopped working, so many downloads couldn't be checked. Catalog lookups now use the searches that still work, plus iTunes.
- yt-dlp now installs with Deno, the JavaScript runtime YouTube requires. Existing installs get it automatically.
- The library audit's repairs use the same stricter matching.

## 2.3.0

- Library sharing between servers: admins exchange a share code to add each other's libraries. Sharing can be one-way or both ways, and either side can stop at any time. Shared albums show which server they come from, and their songs play (with seeking), download for offline listening and work in Subsonic apps through your own server.
- Sign in with Discord: sign up or sign in with a Discord account (following the server's sign-up setting), or connect Discord to an existing account. Accounts made with Discord can add a password later. Discord sends people back to the address they signed in at, which works behind reverse proxies that don't pass on the host. The admin panel shows the exact redirect to register, and offers to set the Public URL when the server sees a different address.
- Discord status: listeners can show the song, artist, album, artwork and time left as their Discord status, using a small helper they download from Settings. Opened once, it installs itself, runs in the background without a window, and starts by itself at sign-in on Windows, macOS and Linux. Turning the status off removes it.
- Plugins: yt-dlp and spotDL are no longer part of the image. Admins install them from PyPI on the new **Plugins** page, can tick automatic updates for each one, and can remove them again. The downloader and the audit's repairs say when a plugin they need is missing.
- Admin: a **Library sharing** page, Discord settings under **Accounts & access**, and plugin versions on **About**. The yt-dlp card on About is replaced by the Plugins page.
- Settings: secret fields accept dashes and underscores, and a Discord application ID is checked when it's saved.

**Upgrading from 2.2:** the downloader needs yt-dlp (and spotDL for links to playlists and albums on music streaming services), so install them under **Plugins** after updating. `AUTO_UPDATE_EXTRACTORS` and `config/python-packages` aren't used any more.

## 2.2.0

- Friends: send, accept and cancel friend requests, remove and block people, and find people by name or username. Friend Activity (desktop) and "Friends are listening to" (phones) show what friends are playing; everyone can hide their own listening or stay out of search.
- Profiles for other listeners: what they're playing, their top artists, recent songs and the playlists you share.
- Private messages: end-to-end encrypted one-to-one and group chats between friends. Send songs, albums, artists and playlists as playable cards, react, unsend, and see when a message was read. Keys are made on each device; a recovery key or an approval from another device brings them to a new one. Security codes let people verify each other, and a change of keys is shown.
- Collaborative playlists: create one or turn a playlist collaborative, invite friends, and everyone can add, remove and reorder songs. Songs show who added them.
- Admin: switches for friends, messages and collaborative playlists, a group size limit, message retention, and social numbers on the overview (never message contents). Deleting an account removes it from friends lists, chats and playlists.

## 2.1.0

- Share links: songs, albums and artists get short links (`/track/…`, `/album/…`, `/artist/…`). In Discord and other chat apps they show the title, artist, artwork and a matching colour. Opening one shows a page where anyone can listen, or sign in first on a private server. Admins can keep previews behind sign-in on a private server.
- Profile photos: listeners upload a photo from **Profile → Edit profile** (or by clicking their picture). Photos are cropped, resized and stripped of camera and location data. Admins can remove anyone's photo and turn uploads off.
- Subsonic apps show profile photos (`getAvatar`).
- The accent colour CSS variable is now `--accent` (it was `--sp-green`). Update any custom CSS that used the old name.

## 2.0.0

A rebuild of the apps and the server, ready for public self-hosting.

**Listening**
- New desktop and mobile web apps sharing one player engine.
- The player gains gapless playback, crossfade, EQ, volume boost and normalization, synced lyrics, radio and mixes, and a miniplayer.
- Data saver streaming: 320, 192 or 128 kbps MP3 made on the fly, with seeking during the first play. Phones can use a separate setting on mobile data.
- Subsonic / OpenSubsonic API at `/rest` with per-account app passwords.
- Scrobbling to ListenBrainz and Last.fm.
- Accounts: see and sign out signed-in devices, download your data, delete your account.
- Fonts are bundled; the apps no longer load anything from Google.

**Running a server**
- New admin panel covering:
  - branding, feature switches, sign-up modes and invites, private server and maintenance modes;
  - accounts and admin roles, login lockout, notifications (Discord and webhooks);
  - activity and server logs, library scanning, scheduled backups, yt-dlp updates and restart;
  - two-factor sign-in (TOTP) for admins, and an optional Prometheus `/metrics` endpoint.
- Accounts moved from `users.json` to SQLite (`axdio.db`), migrated automatically. Login tokens are stored hashed.
- The container runs gunicorn as a non-root user (`PUID`/`PGID`), has a health check, pins its dependencies and no longer upgrades packages on every start.
- The library scanner runs on a schedule (every hour by default, instead of every 4 seconds). It reads M4A/AAC, OGG/Opus and WAV besides FLAC and MP3, records album artist and length, and won't empty the library if a network mount drops out.
- Responses are gzip-compressed (the library index shrinks about 8×).
- Security:
  - security headers, and HSTS when HTTPS is enforced;
  - login tokens are no longer accepted in URLs;
  - lyrics lookups verify HTTPS certificates;
  - stricter path checks;
  - signed-out listeners on different networks no longer share Connect devices;
  - the session key survives restarts.
- The downloader is off by default on new installs.
