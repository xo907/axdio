# Axdio

A self-hosted music server with a polished player for desktop and phones. Point it at your music folder and it streams your library to every device, with lossless playback, lyrics, playlists and offline downloads.

Created by [xo.st](https://xo.st).

## Features

**Listening**
- Desktop and mobile web apps you can install to the home screen, with gapless playback, crossfade, EQ, volume boost and normalization
- Synced lyrics, a queue, a sleep timer, radio and mixes built from your library, and search
- Liked songs, playlists and history that sync across devices; downloads for offline listening
- Share links for songs, albums and artists that show the title, artist and artwork in Discord, iMessage, Slack and other apps, and open a page where anyone can listen (after signing in, on a private server)
- Profile photos
- Friends: add people on your server, see what they're playing in Friend Activity, and visit their profiles (everyone can hide their listening or stay out of search)
- Private messages: end-to-end encrypted chats and group chats between friends, with photos, videos and voice messages (encrypted on your device before upload), disappearing messages, songs, albums and artists you can play right from the conversation, reactions and read receipts
- Blend: see how well your taste matches a friend's, and play a mix of the music you both love
- Collaborative playlists: invite friends to add, remove and reorder songs together
- Listening parties: friends listen together in sync, with a shared queue, live reactions and end-to-end encrypted party chat
- Secret chats: end-to-end encrypted chats that only work on one device on each side, so even your other signed-in devices can't read them
- Axdio Daily: a daily game where everyone on the server names the same song from a 1-second clip, then longer ones, with streaks and a shareable result
- Discover: a swipeable feed of songs you've never played, each starting at its catchiest part
- Levels, streaks and achievements: XP for listening, a daily streak, and 15 badges in bronze, silver and gold
- Music notes: a short line and a song for your friends, shown above their chats for 24 hours
- Friends Chart and Time capsule: this week's top 20 among you and your friends, what you played on this day in earlier years, and forgotten favourites
- Sing along: turn the vocals down live and sing to big synced lyrics
- Moments: share a song from an exact second, as a link or in a chat
- Immersive Now Playing: visuals painted from the album cover that react to the music, plus an ambient full-screen mode for TVs
- Rewind: your month or year in music as story cards (minutes, top artists and songs, your listening clock, streaks and new finds), with a card to save, share or send to a friend
- Smart transitions: silence between songs is skipped, crossfades follow each song's own fade-out, albums that run into the next track stay gapless, and volume can be matched from song to song
- Data saver: stream 320, 192 or 128 kbps MP3 instead of lossless files, with a separate setting for mobile data
- Connect: see your other devices and move playback between them
- Works with Subsonic apps (Symfonium, Feishin, DSub, Substreamer, play:Sub, Tempo and more)
- Scrobbling to ListenBrainz and Last.fm
- Sign in with Discord, and show what you're playing as your Discord status (song, artist, album, artwork and time left)

**Running a server**
- An admin panel that covers:
  - branding and a custom domain for links;
  - feature switches;
  - sign-ups (open, invite-only or closed), invites, a private-server mode and maintenance mode;
  - account management, including admin roles, disabling accounts, removing profile photos and signing people out everywhere;
  - login lockout, two-factor sign-in (TOTP) for admins, activity and server logs;
  - Discord and webhook notifications;
  - scheduled backups and restore;
  - library sharing with other Axdio servers, one-way or both ways;
  - plugins you install yourself, like the separate Downloader plugin, with optional automatic updates.
- A library scanner for FLAC, MP3, M4A/AAC, OGG/Opus and WAV, with cover art extraction
- Tools: a library audit that fingerprints songs against their tags and rewrites wrong ones, a fixer for titles and tags ("NERO - 2808" by NERO becomes "2808") that works on a folder, a song or chosen artists, a duplicate finder that keeps the best copy and moves it into its album, and fixers for metadata and lyrics. Whatever deletes or replaces files says so and asks first: Axdio keeps no copies, so its disk doesn't fill up
- One small container: gunicorn, SQLite for accounts, a health check, and a non-root user
- Optional Prometheus metrics at `/metrics` (set a token under **Security**)

## Quick start

You need a machine that stays on (a Linux server, a Raspberry Pi, a NAS, or a Windows or Mac computer with [Docker Desktop](https://www.docker.com/products/docker-desktop/)) with Docker and Compose installed. The image runs on 64-bit Intel/AMD and ARM (Raspberry Pi 4/5).

**1. Make a folder for Axdio** and save this in it as `docker-compose.yml`:

```yaml
services:
  axdio:
    image: ghcr.io/xo907/axdio:latest
    container_name: axdio
    restart: unless-stopped
    ports:
      - "7865:7865"
    volumes:
      - /path/to/your/music:/music            # your music folder
      - ./config:/app/config                  # settings, accounts, caches and backups
      - /var/run/docker.sock:/var/run/docker.sock   # optional: install updates from the admin panel (see Updating)
    environment:
      - PUID=1000                             # the user that owns ./config: run `id -u`
      - PGID=1000                             # and `id -g`
```

**2. Change `/path/to/your/music`** to where your music is. On Windows that looks like `C:/Users/you/Music:/music`. On Linux, set `PUID` and `PGID` to what `id -u` and `id -g` print.

**3. Start it:**

```bash
docker compose up -d
```

**4. Create the admin account** at `http://<server>:7865/admin`, where `<server>` is the machine's address, such as `192.168.1.20` or `localhost`. The first library scan starts by itself; its progress shows under **Maintenance & backups**.

**5. Listen** at `http://<server>:7865/`. Sign-ups are open by default. To choose who can join, use **Accounts & access**, where you can require invite codes, close sign-ups or make accounts yourself.

Next:
- **Outside your home network:** put Axdio behind a reverse proxy with HTTPS (see [Behind a reverse proxy](#behind-a-reverse-proxy)), set **General → Public URL** to its address, and turn on **Security → Redirect HTTP to HTTPS**. Private messages and phone installs need HTTPS.
- **Optional features:** [Plugins](#plugins) such as the Downloader, [Discord](#discord) sign-in and status, and [Library sharing](#library-sharing) with friends' servers.
- **Keep a backup:** copy the `config` folder somewhere safe, or turn on scheduled backups under **Maintenance & backups**.

To build the image yourself instead, clone the repository and replace the `image:` line with `build: .`:

```bash
git clone https://github.com/xo907/axdio.git
cd axdio
docker compose up -d --build
```

## Configuration

Almost everything is set in the admin panel. The container reads these environment variables:

| Variable | Default | What it does |
|---|---|---|
| `CFG_DIR_MUSIC` | `/music` | Music folder inside the container |
| `CONFIG_DIR` | `/app/config` | Where settings, accounts (`axdio.db`), caches and backups live |
| `CHAT_DIR` | `$CONFIG_DIR/chat` | Where private messages and their encrypted photos, videos and voice messages live. Mount a folder of its own here to keep chats on another disk or an encrypted volume |
| `PORT` | `7865` | Port the server listens on |
| `PUID` / `PGID` | `1000` | User and group the server runs as (set `PUID=0` to run as root) |
| `SECRET_KEY` | generated | Signs sessions and encrypts app passwords. By default a random key is created once and kept in `config/secret_key`; if you set it yourself, keep it stable or people get signed out |
| `WEB_THREADS` | `48` | Concurrent requests; each listener holds one while streaming |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning` or `error` |
| `ACCESS_LOG` | off | `true` to log every request |
| `PLUGIN_PIP_ARGS` | none | Extra pip options for installing plugins, e.g. `--index-url https://pypi.example.com/simple` behind a mirror |

See `.env.example` for a copy you can fill in.

## Behind a reverse proxy

Put Axdio behind HTTPS before inviting people. The proxy must pass the original host and the `X-Forwarded-For` / `X-Forwarded-Proto` headers. Then, in the admin panel under **Security**, turn on **Redirect HTTP to HTTPS** and leave **Behind a reverse proxy** on. Under **General**, set **Public URL** so share and invite links, and the images in link previews, use your domain.

Caddy:

```
music.example.com {
    reverse_proxy axdio:7865
}
```

nginx:

```nginx
server {
    server_name music.example.com;
    location / {
        proxy_pass http://127.0.0.1:7865;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # start audio right away
        client_max_body_size 64m;     # backup restores and image uploads
    }
}
```

If the server is exposed directly without a proxy, turn **Behind a reverse proxy** off so visitors can't fake their address.

## Using other apps (Subsonic)

Axdio speaks the Subsonic API (1.16.1, plus the OpenSubsonic `formPost` and `songLyrics` extensions) at `/rest`. Each listener opens **Settings → Other apps → Subsonic-compatible apps** in the web app, creates an app password, and enters the server address, their username and that app password in the app. Starring a song in an app likes it everywhere, and app playlists are the same playlists as in the web app. Admins can switch the API off under **Features**.

## Scrobbling

Listeners connect their own accounts under **Settings → Other apps → Scrobbling**:

- **ListenBrainz** needs only the listener's user token from listenbrainz.org.
- **Last.fm** needs an API account for your server. Create one at <https://www.last.fm/api/account/create> with the callback URL `https://<your domain>/api/user/scrobbling/lastfm/callback`, then enter the key and shared secret under **Features → Last.fm scrobbling**.

A song counts once half of it (or 4 minutes) has played.

## Sharing

Every song, album and artist has a link, like `https://music.example.com/track/B5cqImYpZoB`. Pasted into Discord, iMessage, Slack, Telegram, WhatsApp or X, it shows the title, artist and artwork. The preview image is made once per cover and kept in `config/cards`. Opening the link shows a page with a player:
- On an open server, anyone with the link can listen.
- On a private server (**Accounts & access → Private server**), visitors see the preview and sign in to listen. Turn off **Features → Link previews on a private server** to keep even the preview behind sign-in.

Links stay the same as long as the file (for songs) or the album and artist names don't change. Turn off **Features → Sharing** to switch links off.

## Private messages

Messages are end-to-end encrypted in the browser with Web Crypto (P-256 keys, AES-256-GCM). What the server stores is unreadable to it: public keys, a backup of each person's private keys sealed with a recovery key only they have, conversation keys wrapped for each member, and message ciphertext. Group membership changes are signed by the member who made them, and people can compare a security code (safety number) to be sure nobody swapped keys in between.

- The first time someone opens **Messages**, they turn on private messages and save a 32-character recovery key.
- On another device they either approve it from a device that already works (both show the same six-digit code) or enter the recovery key.
- If a password is reset by an admin, messages stay locked: the password isn't part of the encryption.
- Private messages need HTTPS (browsers only allow Web Crypto on secure connections).

What the server can see: who talks to whom, when, and roughly how long each message is. Like every web app, the encryption code itself is served by your server, so it protects against a curious admin, stolen backups and database leaks, but not against someone who changes the server's code to capture keys as people type.

**Photos, videos and voice messages** are encrypted on the sender's device before they leave it, each with a key of its own that travels inside the (encrypted) message. They're uploaded and downloaded in 512 KB chunks, so large videos don't tie up the server or trip reverse-proxy size limits, and a failed chunk is simply sent again. Photos are redrawn before sending, which removes their location and camera details. People who receive them decrypt them in memory; nothing is saved on their device unless they choose **Save**.

**Disappearing messages**: anyone in a chat can make new messages disappear for everyone after an hour, a day, a week or four weeks. The server deletes them, with their attachments, when the time is up.

Admins can turn messages off, cap group sizes, delete old messages, allow or block photos, videos and voice messages, and set the largest attachment and how much each person can keep stored, all under **Features**.

Chats are stored in their own folder, `CHAT_DIR` (`config/chat` unless you set it): `chat.db` holds conversations and message ciphertext, and `media/` holds the encrypted attachment chunks. To keep chats somewhere else, for example on another disk or an encrypted volume, mount that folder and point `CHAT_DIR` at it:

```yaml
    volumes:
      - /path/to/private/chat:/chat
    environment:
      - CHAT_DIR=/chat
```

Servers from before 2.6.0 kept chats inside `config/axdio.db`; they move into `CHAT_DIR` by themselves the first time the new version starts. Backups include friends and collaborative playlists but not chats, so back up the chat folder too (it's encrypted, so a copy can't be read without people's keys).

## Library sharing

Admins can share their library with other Axdio servers and add the libraries other servers share with them. Shared music appears next to your own, marked with the server it comes from, and plays straight from that server. Nothing is copied.

1. On the server that shares, open **Library sharing → Make a share key**, say who it's for, and send the code to the other admin privately. The code is only shown once.
2. On the other server, open **Library sharing → Add a library** and paste the code. Leave **Share my library with them too** ticked to offer yours back; the first server then sees an offer to accept or decline.

- **One-way or both ways.** Sharing back is optional, and each direction has its own key.
- **Stop at any time.** **Stop sharing** turns a key off at once, and your music disappears from the other server. Removing a library you added tells the other server, so its key for you stops working too.
- **Hide without removing.** Each shared library has a switch that hides it from your listeners.
- Shared libraries are checked for changes every hour (adjustable).
- Your server needs an address the other server can reach. If people reach it by more than one address, set **General → Public URL** first.
- Listeners play shared songs through their own server. The server that shares sees the other server, not who is listening.
- Share links and link previews only cover your own music.

## Discord

**Sign in with Discord.**
1. Make an application at <https://discord.com/developers/applications>.
2. Under **Accounts & access → Discord**, turn on **Sign in with Discord** and enter the application's ID and client secret.
3. On the application's **OAuth2** page, click **Add Redirect**, paste the address shown under the Discord settings (`https://<your domain>/auth/discord/callback`, exactly), and click **Save Changes**.

Discord sends people back to the address they signed in at, so if your server has more than one address, add a redirect for each. "Invalid OAuth2 redirect_uri" from Discord means the address people used isn't in that list.

New accounts made this way follow your sign-up setting (open, invite code or closed). People who already have an account connect Discord under **Settings → Discord**. Accounts made with Discord can add a password later.

**Discord status.** Listeners can show what they're playing (song, artist, album, artwork and time left) as their Discord status. Discord only lets programs on the same computer change someone's status, so each listener sets up a small helper once, on the computer where they use the Discord app:
1. Install Python 3.8 or newer if the computer doesn't have it (free at [python.org](https://www.python.org/downloads/)).
2. Download the helper from **Settings → Discord → Show what I play on Discord**.
3. Open it once: double-click it on Windows, or run `python3 ~/Downloads/axdio-discord.py` on a Mac or Linux.

The helper copies itself into the user's app data folder and starts in the background without a window. From then on it starts by itself at every sign-in:
- Windows: listed as "Axdio Discord status" under Settings → Apps → Startup.
- macOS: a login item (LaunchAgent).
- Linux: a systemd user service, or an autostart entry.

Opening a newly downloaded helper replaces the old one. `axdio-discord.py --run` shows what it's doing in a window, `--stop` stops it until the next sign-in, and `--uninstall` removes it.
- The helper is made for each listener's account. Turning the status off in Settings stops it working, and the helper removes itself the next time it checks in.
- It uses the same application, whose name and icon appear in the status, so name the application after your server.
- Artwork appears when sharing is on and Discord can reach your server's address.
- Discord's phone apps can't show it.

## Plugins

Plugins add things Axdio doesn't come with. They're separate projects with their own code, releases and licenses, and playing music doesn't need any of them. An admin installs them under **Plugins** in the admin panel. They come from the plugin's GitHub releases or from PyPI, and go into `config/plugins`, so they survive restarts and image updates.

- **Downloader** ([xo907/axdio-downloader](https://github.com/xo907/axdio-downloader)) adds a Downloader page that saves songs, albums and playlists from links, keeping only uploads that are the exact recording. It also lets the library audit replace wrong audio. It installs yt-dlp, and optionally spotDL, which then appear under **Plugins** too. Its README explains how it works. Check that using it is allowed where you are, and only download music you have the right to copy.

On the Plugins page:
- **Keep it up to date automatically** installs new versions when they come out. The server checks every 24 hours (adjustable) and waits until nothing that uses the plugin is running. A new version is used without a restart.
- **Remove** takes a plugin off the server again, along with anything it brought with it.

**Coming from 2.7 or earlier:** the downloader used to be part of Axdio. It's now the Downloader plugin, so install it under **Plugins** to keep downloading. The yt-dlp and spotDL you installed are reused, with their automatic-update settings.

**Writing a plugin:** an Axdio plugin is a Python package with a `register(api)` function that can add admin pages, settings, admin routes and add-ons. The Plugins section of `server.py` describes the API, and the Downloader is a full example. To try one from a local folder, set `PLUGIN_SOURCES=<id>=/path/to/it` on the container.

## Backups and restore

Axdio saves a backup every day by default (**Maintenance & backups → Automatic backups**) to `config/backups`, keeping the last 7. A backup holds:
- settings;
- every account with its likes, playlists and history;
- invites.

It doesn't hold music files, artwork or profile photos (those are in `config/avatars`). You can download a backup at any time and restore all of it or just parts. Because backups contain password hashes and webhook URLs, keep copies somewhere private.

To move a server, copy the whole `config` folder (and your chat folder, if you set `CHAT_DIR` somewhere else). It's everything the server knows.

## Updating

Axdio checks for new versions and shows them under **Updates** in the admin panel, with what's new. It also sends a notification if you've set up notifications.

**From the admin panel.** With the Docker socket mounted (the `/var/run/docker.sock` line in the Quick start), **Update now** installs the new version. Tick **Install new versions automatically** to have it happen at night.
- Axdio downloads the new image, and a short-lived helper container recreates Axdio from it with the same settings: ports, folders, environment, networks and restart policy.
- Listeners are interrupted for about a minute.
- If the new version doesn't report healthy within 5 minutes, the helper puts the previous version back, and the Updates page says what went wrong.

Mounting the socket gives Axdio control over Docker on that machine, which it needs to replace its own container. Leave the line out if you'd rather not allow that; the Updates page then shows the commands to run.

**By hand**, in the folder with `docker-compose.yml`:

```bash
docker compose pull
docker compose up -d
```

If you build from source, run `git pull` and then `docker compose up -d --build` instead. Settings and accounts carry over; older `users.json` files are moved into `axdio.db` automatically on first start.

Coming from 2.2 or earlier: `config/python-packages` and `AUTO_UPDATE_EXTRACTORS` aren't used any more; you can delete that folder.

## Privacy: outside connections

Axdio sends no telemetry, and the apps load nothing from other sites (fonts are bundled). The server contacts other services only for features you use:

| Service | When |
|---|---|
| LRCLIB (lrclib.net) | A listener opens lyrics for a song that isn't cached yet (turn off under **Features → Lyrics**) |
| Deezer and iTunes | An admin runs the library audit or metadata fixer, or the duplicate finder moves a song into its album and looks up its track number there |
| GitHub (ghcr.io, raw.githubusercontent.com, api.github.com) | Checking for new versions of Axdio and reading what's new (turn off under **Updates**), and installing or updating plugins that come from GitHub |
| PyPI | An admin installs or updates a plugin, or looks for new versions; plugins with automatic updates check every 24 hours |
| Other Axdio servers | You share libraries with them (songs, artwork and the song list travel between the two servers) |
| Discord | Someone signs in with Discord. The Discord status helper runs on the listener's computer and talks to your server and their Discord app |
| ListenBrainz, Last.fm | A listener connected their account |
| Your Discord or webhook URL | You configured notifications |
| Whatever a plugin needs | You installed that plugin (see its README) |

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

Built-in protections include:
- hashed passwords and login tokens;
- lockout after repeated failed logins;
- `SameSite` cookies and security headers;
- HSTS when HTTPS is enforced;
- no tokens in URLs;
- path checks on every file access;
- a non-root container.

## Legal

Axdio plays music you already have, and doesn't include any way to download music. Plugins are separate projects with their own licenses. If you install one that downloads, only download music you own or have permission to copy. You're responsible for how your server is used.

## Development

```bash
docker build -t axdio .
docker run --rm -v "$PWD":/src -w /src --entrypoint python axdio -m unittest discover -s tests -v
```

The server is `server.py` (Flask, run by gunicorn). The web apps are plain JavaScript in `web/`:
- `web/app/core.js`: the shared player engine;
- `web/app/social.js`: friends, private messages and collaborative playlists;
- `web/desktop/` and `web/mobile/`: the two interfaces;
- `web/admin/`: the admin panel.

Settings pages in the admin panel are generated from `ADMIN_SCHEMA` in `server.py`, so a new setting only needs an entry there.

## License

MIT, see [LICENSE](LICENSE). Created by [xo.st](https://xo.st). Plugins you install have their own licenses.
