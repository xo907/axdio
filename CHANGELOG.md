# Changelog

## 2.9.0

- **Fix titles and tags of a folder, a song or chosen artists.** A new **Fix** button on the Files page (and a **Titles & tags** tool under **Metadata & lyrics**) cleans up titles that carry something that isn't the title:
  - the artist's own name ("NERO - 2808" by NERO), track numbers and video IDs from file names, and labels like "(Official Video)";
  - songs without tags get their title and artist from the file name and folder.
  - Each song is then looked up, and when its audio fingerprint confirms the match, its title and artists are written as the catalog has them, with a missing album, track number, date and cover filled in. Your spelling is kept where the catalog only differs in capitals ("NERO" stays "NERO") or adds "(Original Mix)".
  - **Only clean up titles** skips the lookups, for a quick pass.
  - Every change is listed with what it was before, and can be undone one by one or all at once.
- **Run the library audit and the metadata fixer on chosen folders or artists** instead of the whole library.
- Fixed: when a song's tags couldn't be read during a scan (for example, a network mount that didn't answer in time), the file name was kept as its title until the file changed. Such songs are now read again on the next scan, and the first scan after updating reads songs that look affected once more.

## 2.8.0

- **The downloader is now a plugin of its own.** Axdio no longer contains any code that downloads music. The downloader lives in its own repository, [xo907/axdio-downloader](https://github.com/xo907/axdio-downloader), and you install it under **Plugins** like any other plugin.
  - Installing it brings back the Downloader page and the library audit's audio repairs, working as before. yt-dlp comes with it, and spotDL is an optional add-on. Both are still updated from the Plugins page.
  - Servers that had yt-dlp installed see a note on the Plugins page. The tools installed before are reused, with their automatic-update settings.
  - Without the plugin, the library audit still finds wrong audio and rewrites wrong tags.
- **Plugins can add to Axdio.** A plugin comes from GitHub releases or from PyPI. An Axdio plugin can add admin pages, settings, admin routes and add-ons of its own. Plugins are loaded, updated and removed without a restart.
- The About page lists whatever plugins are installed.
- Fixed: a test of levels and badges failed between midnight and 5 am UTC.

## 2.7.1

- Fixed: photos, videos and voice messages in chats never loaded and kept spinning, for both the sender and the recipient. This had been broken since 2.6.0.
- Fixed: a new message could be missed until the next one arrived, if it came in while the app was already refreshing your chats.

## 2.7.0

- **Axdio Daily.** Every day everyone on the server gets the same song, picked from what's popular there, and names it from a 1-second clip, then 2, 4, 7, 11 and 16 seconds.
  - It has streaks, win stats and a result to share, plus how your friends did.
  - The clips are cut once a day without tags, and each one is handed out only once you've used enough tries to earn it, so there's no peeking.
- **Discover.** A full-screen feed of songs you've never played, one swipe at a time, each starting at its most energetic part.
  - It mixes what your friends have on repeat, more from artists you love, and deep cuts.
  - Double-tap to like, add to the queue, or play the whole song.
- **Levels, streaks and achievements.** You earn XP for every minute you listen, plus bonuses for Daily wins, Discover finds and hosting parties.
  - Keep a daily listening streak going, and unlock 15 badges in bronze, silver and gold (Night Owl, Explorer, Album Purist, Name That Tune…) with a celebration when you do.
  - Friends see your level, streak and best badges on your profile.
- **Music notes.** Leave a short line and a song for your friends for 24 hours, shown above their chats. Replies and reactions arrive as end-to-end encrypted messages.
- **Friends Chart.** This week's top 20 among you and your friends, with how each song moved and who's been playing it.
- **Time capsule.** What you were playing on this day in earlier years (or a month ago), and forgotten favourites you haven't played in a while.
- **Sing along.** Turn the vocals down live and sing to big lyrics that fill as they're sung.
  - On desktop and Android the lead vocal is taken out of the song itself, by cancelling what's in the centre of the mix and keeping the bass. iPhones keep the vocals but get the lyrics.
- **Moments.** Share a song from an exact second ("listen from 1:13"), as a link or straight into a chat. Links open the share page and the app at that second.
- **Secret chats.** Chats that only work on one device on each side: the one that started it and the one the other person opens it on.
  - The chat's key is sealed to those two devices' own keys, which never leave them and aren't part of the recovery backup.
  - Your other signed-in devices, and anyone who gets your password or recovery key, can't read them or even see them.
  - Only the two devices can change the chat's key.
  - Signing out ends this device's secret chats.
  - Start one from a chat's menu.
- **Listening parties** got a roomier, clearer panel, which widens on desktop while you're in a party, and **party chat is now end-to-end encrypted**:
  - the host's app makes a chat key and seals it for each member's private-message key;
  - removing someone changes the key;
  - the server only relays ciphertext.
- The home screen has a row of cards for all of this. Admins can turn each feature off under **Features**.
- Fixed: the collaborative playlists switch under **Features** blocks their API again.

## 2.6.0

- **Listening parties.** Start a party from the headphones button in the player (desktop) or Now Playing (phones). Everyone who joins hears the same moment of the same song, wherever they are, typically within a few hundredths of a second of each other.
  - There's one shared queue; tapping a song plays it for everyone.
  - The host decides whether guests can add songs and control playback.
  - Emoji reactions float across everyone's screen, and there's party chat.
  - People join with a six-character code or an invite link (`/party/CODE`). Friends see your party in Friend Activity and join with one tap.
  - The server keeps the party's clock and moves to the next song exactly when one ends. Each app follows it, correcting drift by nudging the playback speed.
  - Admins can turn parties off under **Features**.
- **Immersive Now Playing.** Full screen on the desktop, and Now Playing on phones, come alive with the music.
  - The background is painted from the album cover's own colours, drifting slowly and swelling with the bass.
  - A frame of spectrum bars grows out of the cover's edges, and the cover pulses on each beat.
  - On desktop and Android the visuals react to the real audio. iPhones get a gentle rhythm instead, because routing audio through the browser's audio engine stops playback in the background on iOS.
  - Ambient mode on desktop: when the mouse rests, the controls and cursor fade away, and a clock and "Up next" appear, so a TV or spare screen makes a good music display. The screen is kept awake while music plays.
  - Turn the visuals on or off with the sparkle button (or Alt V in full screen).
- **Photos, videos and voice messages in private chats.** They're encrypted on the sender's device, each with its own key that travels inside the encrypted message, so the server stores only scrambled chunks it can't read.
  - Files move in 512 KB chunks, several at a time, with retries. Big videos upload and play without straining the server, and they fit under reverse-proxy size limits.
  - Photos are redrawn before sending, which removes their location and camera details.
  - Voice messages are recorded right in the chat, with a live waveform. Music pauses while a voice message or video plays, and carries on afterwards.
  - Paste or drag photos into a chat on desktop, and tap a photo to see it full screen and save it.
  - Admins choose, under **Features**, whether photos, videos and voice messages are allowed, the largest attachment, and how much each person can keep stored.
- **Disappearing messages.** Anyone in a chat can make new messages vanish for everyone after an hour, a day, a week or four weeks, attachments included.
- **Chats in a folder of their own.** Conversations, message ciphertext and attachments now live in `CHAT_DIR` (`config/chat` by default), so they can sit on another disk or an encrypted volume. Existing chats move there by themselves; the old tables stay in `axdio.db`, renamed, in case you want them.
- **Rewind.** Your month or year in music, told as full-screen story cards: minutes listened, your top artists and songs, your listening clock and the kind of listener it makes you, your longest streak and biggest day, and the songs you found.
  - The last card is a poster you can save as an image, share, or send to a friend as an end-to-end encrypted photo.
  - Open it from the card on Home or from your account menu, and switch between this month, this year, earlier years and all time.
  - Axdio now keeps a log of when each song is played. Your existing history is brought in on the first start (counted for top songs and minutes, but not for times of day). Only you can see your Rewind; the log is included in your data export and deleted with your account.
  - Admins can turn Rewind off under **Features**.
- **Smart transitions.** Each song is measured once (its loudness, and where its sound starts, fades and ends), in the background at low priority, and the player uses that:
  - silence at the start and end of songs is skipped, so songs follow each other without dead air;
  - with crossfade on, the fade starts where the song really ends and stretches over the song's own fade-out, and tracks of an album that run straight into each other stay gapless;
  - **Match volume between songs** brings loud recordings down to the level of the rest (not on iPhone, where the browser controls the volume).
  - Turn them on or off in Settings → Playback. Admins can turn the measuring off under **Features**.
- **Blend.** A friend's profile shows how well your tastes match and a mix of the music you both love, built only from listening that both of you share with friends.
- **Party invites in chat.** Start a listening party from a chat's menu, and the invite lands in the conversation. Tapping a party link in a chat joins right away.
- Messages (desktop): with no conversations yet, one "Your messages" panel is shown instead of two, and the chat now always fills its panel, so the message box can't be pushed off the bottom.

## 2.5.1

- Admin panel: cards that end with a line of text, like the Updates card when you're up to date, no longer cut that line off at the bottom.
- Commands shown inline in the admin panel no longer break across lines.

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
