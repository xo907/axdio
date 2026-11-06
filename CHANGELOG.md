# Changelog

## 2.23.1

- **Discord status shows External songs' artwork** instead of the app's icon (the player keeps their artwork as a link through the server, which wasn't passed on).

## 2.23.0

Made for **Axdio for Windows 1.1.1** and **Axdio for Android 1.4** (both work with it as before without updating).

- **Control your other devices, like Spotify Connect.** While one of your devices plays, the others show it as their own player ("Playing on …"): the song, how far in, play or paused. Their controls act there: play and pause, skip, seek, volume, shuffle and repeat, and whatever you pick to play starts on that device. Changes show on every device at once (the players wait for news instead of asking every few seconds). Choose **This computer** / **This phone** in the device menu (or click the green "Playing on" strip) to bring the music over, or another device to send it there.
- **One device plays at a time.** Starting music on one of your devices pauses the one that was playing. (Signed out, devices on one network still see each other but don't pause each other.)
- **Discord status shows External songs**, with their artwork and a "Listen" link that works for whoever clicks it. Before, songs not in the library showed nothing.
- **Discord status no longer flickers off** when another player of yours is open: only the device that's playing says what you're playing.
- Each browser tab is a device of its own, so two tabs no longer contradict each other.

## 2.22.1

- **Liked External songs stay liked when they play.** Starting an External song you liked showed its heart (in its row and the player bar) as not liked, though it stayed in Liked Songs; liking it again then actually removed it. The hearts, the now-playing panel, the miniplayer and the rows on phones now count likes of songs that aren't in the library yet.

## 2.22.0

Made for **Axdio for Windows 1.1** (released alongside it), and fine without it.

- **The player knows when it runs in the Windows app.** Its miniplayer button opens the app's own mini player (a small window that stays on top), and Settings → Discord has a switch instead of a helper to download: the app talks to Discord on the computer itself.
- **Get the Windows app** from Settings when you use the player in a browser on Windows (a new Apps section, linking to the latest release).
- Turning on Discord status gives back the key it made (`POST /api/user/presence`), for apps that talk to Discord themselves. Making a new key still turns off the one before, so a helper set up earlier stops when the app takes over.
- The admin overview shows the start cache (how much it holds, and for how many songs) with the cover and lyrics caches.

## 2.21.0

- **Local songs start as fast as External ones, also from a network share.** The first 2 MB of songs (about 10 seconds of FLAC, a minute of MP3) are kept on the server's own disk: songs played lately, and songs the player expects next (the next in the queue, the first songs of the page or search you're looking at). A kept song starts from there at once while the music folder (a NAS, a drive that went to sleep) catches up with the rest, and asking for them ahead wakes the share's disks before you press play. **Library → Start cache** sets its size (1500 MB, about 750 songs; 0 turns it off).
- Smart transitions measure a song a few seconds after it starts playing, at the lowest disk priority, instead of reading the whole song from the music folder at the same moment it starts streaming.
- Songs stream from the music folder in larger reads (better over a network), and a FLAC's header is read for its length only once, not every play.

## 2.20.1

- **Shared libraries sync one at a time.** When the background sync of a library another server shares with this one ran at the same moment as one started by hand (or by connecting), one of them could fail writing the library's file, and the connection showed an error. Each library now syncs once at a time.

## 2.20.0

- **A queue on shared pages.** The queue button (beside the volume, or in the small player on phones, or Q) opens what's playing and everything after it, in the order it'll play: shuffled, the queue shows the shuffled order, not a surprise. Tap a song to jump to it. On a computer it opens over the right side; on a phone it's a sheet from the bottom.
- **Search looks beyond the library when you press Enter.** Typing still searches your library at once; External music (from library sources such as the Downloader's) is asked for only when you press Enter (the Search key on phones), instead of after each pause in typing. That keeps the search service from being asked once per word and turning the server away. A line under the results says so, and clicking it searches too. Pasted links search on Enter as well.

## 2.19.1

- **The left side of a shared page never scrolls.** On a computer everything on it always shows: the artwork takes the room that's left, and in a short window it sits beside the title with the player underneath. Open in Axdio and Copy link moved up beside the logo.
- **More controls on shared pages:** shuffle, repeat (all or one), and volume with mute, kept on that device. Keys: Space, ←/→ to seek, ↑/↓ for volume, M mute, S shuffle, R repeat, N and P next and previous. Phones and tablets use their own volume buttons.

## 2.19.0

- **Shared pages, redone.** A shared song, album or artist opens a page that is exactly the window: on a computer the artwork on a stage on the left, with a visualizer around it that moves with the music (bars around the edges of an album's artwork, a ring around an artist's photo, sparks on the beat), and the music around it on the right; on a phone one column, with a small player once the controls scroll away. The backdrop takes the artwork's colours and drifts and breathes with the music. Nothing shows a scrollbar; everything still scrolls.
- **More on each page.** A song's page shows its album, track number, release date, length, quality (FLAC, lossless or not) and plays on this server; an album's the same for the album, with how popular each song is here; an artist's page their numbers (songs, releases, plays, years active, counting up), Popular, the whole discography with Albums / Singles & EPs filters, and the songs they're featured on.
- **Similar music.** Every shared page has similar songs (they play on after the page's own, so a shared song carries on like a radio), more by the artist and the artists fans also like. Similar artists come from featured credits, what listeners here play together, and shared compilations.
- **External music can be shared.** Links to External songs, albums and artists work like the library's (Copy link in the menus, and Share a moment). Whoever opens one can listen on the page, also people who can't use External music in the player. Admins can turn that off: **Features → Share External music**.
- **Volume in full screen.** The full-screen view has its own volume control (with the level in percent), kept in step with the player bar's. Full screen also opens and closes on the first click, and leaving it another way (Esc, F11, the browser's button) closes the view.
- The player bar no longer overlaps itself in narrow windows: the least-used buttons (sing along, listening party, miniplayer, now playing view, devices, the volume slider) step aside as the window narrows.

## 2.18.0

- **Albums show when they came out, not when they were added.** An album's page, discographies and album lists show its release year (from the songs' date tags), and the foot of an album's page the whole release date. "Recently added" still sorts by when songs came into the library. Songs are read once more on the first scan after updating, to get their dates.

## 2.17.1

- The lock screen and notifications get covers in the sizes they ask for (96, 192 or 384 pixels, or the full art), instead of the full art for every size.

## 2.17.0

- **The player opens at once, and without a connection.** A service worker keeps the player itself (its page, scripts, stylesheets and fonts) on each device. Pages still come from the server when it answers within a moment; on a slow or missing connection, the copy kept on the device opens instead, with your library and the songs you saved for offline (which the player already kept). Before, saved songs could only be played offline if the player was already open. Browsers allow service workers on HTTPS servers (and on localhost).

## 2.16.0

- **Covers load much faster, and use far less data.** Song rows, cards and lists were sent every cover at the size it's embedded in the file (often 1000+ pixels and hundreds of KB, for a 48-pixel row). They now get small copies (96, 192 or 384 pixels, a few KB to a few tens of KB), made by the server in the background once and kept with the covers; the first time, the full cover is sent while the copy is made. Big places (an album's header, Now Playing) still show the full art. External artwork comes in smaller sizes for rows and cards, too, and pages take their colour from a small copy.
- **A slow start says why.** When an External song takes more than a couple of seconds to start (the first time it's played), the player says it's getting it ready.

## 2.15.9

- **External artwork shows after the server restarts.** Search results kept from before a restart (or an update) asked for artwork the server no longer knew it had given out, and got none. Artwork addresses now carry the server's signature, so they keep working.

## 2.15.8

- **Searching doesn't wait on itself any more.** External sources are asked once typing pauses, not for every few letters on the way (typing a song's name sent a dozen searches, each making songs ready in the background; on a small server that made the one that mattered wait). The search shows it's looking meanwhile.
- **The player loads faster, and from the browser after the first time.** Its scripts and stylesheets are kept by browsers for a year at each version (a new version has a new address), instead of being checked on every visit; the server works out each file's versioned copy and its compressed copy once, not on every request (it did both for every file of every page load); and they're compressed harder. Fonts and images are kept a week. Static files no longer carry a session cookie, which kept browsers from keeping them.
- **The next External song is all ready before it starts.** The server saves it ahead (it starts at once, seeking included), and the one after it is made ready too.

## 2.15.7

- **The hearts line up.** Every song row has the same place for Get (empty for the library's songs), so the hearts are in one column, External songs or not.
- **Faster:** pointing at (or touching) an External album or artist reads its page ahead, so it opens at once; and an External album or artist page gets its first two songs ready to play as soon as it's open.

## 2.15.6

- **Album and playlist links pasted into search are ready to play too.** Their first three songs are made all ready straight away, and the rest as they play.

## 2.15.5

- **A link pasted into search has its song ready to play.** When the search is a link to a song, the player asks the library source to have all of it ready (`preload(id)`, see PLUGINS.md), so it starts at once when played.

## 2.15.4

- **Searching again finds what wasn't there before.** A search that found nothing outside the library isn't cached any more (on the server or the device), so a link pasted into search, say, finds its song as soon as the library source can read it. Searches cached by 2.15.3 are asked again.

## 2.15.3

- **External music is cached.** What a library source said is kept: by the server for every listener (searches for 15 minutes, artist and album pages and recommendations for an hour), and by each device (searches for 6 hours, the rest for a day), so going back to a search or a page is instant. Cached answers are refreshed in the background once they're 10 minutes old. Artwork is kept on the server's disk (`config/covers/sources`) and in the browser for 30 days.

## 2.15.2

- **External songs liked while signed out go with you.** Signing in adds them to your account, like the library's songs you liked.
- **It's plain that search is still looking.** While the library's results are shown and more are still coming, a banner says so ("Searching for more…"), over placeholder rows that shimmer until the rest is in.

## 2.15.1

- **Liked External songs are on every device.** They're kept with your account, so they're in Liked Songs wherever you sign in. Those liked on a device before this version are added to your account the first time it signs in.

## 2.15.0

- **Liked External songs are in Liked Songs.** A song liked before it's in the library shows in Liked Songs straight away (on this device), and is liked for real once it's in.
- **An artist's page has what the library doesn't.** Under the library's songs and releases, **More songs by** and **More releases by** list the rest of what they made, from the library sources.
- **Recommendations reach beyond the library.** Made for you mixes mix in External songs like theirs, and **More like** and **Something different** on the home page mix in External albums, picked from songs like the ones you listen to. (Library sources can now give songs like a song: `radio(id)`, see PLUGINS.md.)
- **External songs start sooner.** The next two songs up are made ready ahead, and so is a song as the pointer rests on it (or a finger touches it).

## 2.14.7

- **Search shows it's still looking.** While a library source is being searched, the results show a live searching state instead of "No results" (and a moving line above the library's results), until its answers are in.
- **A search for a song puts the song first.** When a song has the name searched for, it's the top result, unless an artist of that name has most of the top songs. Artists are still listed.
- **The heart shows on every song**, not only when the pointer is over it.

## 2.14.6

- **Searching for an artist finds them, whether or not the library has them.** When a library source has the artist, search shows the source's (with all they made, and their own picture), also where the library has only a song they're featured on. Their page links to what the library has with **In your library**.

## 2.14.5

- A library source's switch (**Show <name> in the library**) is with its plugin's own settings, on the plugin's page (for the Downloader: Library > Downloader). A plugin without settings of its own has it under Library scanning on the Maintenance page.

## 2.14.4

- Liking an External song no longer gets it: only **Get** does. A liked one goes into Liked Songs once it's in the library.

## 2.14.3

- **External songs have the heart, where it always is, next to Get.** Liking one gets it into the library, and it goes into Liked Songs once it's in.

## 2.14.2

- **Library sources are on by default.** An admin can still turn one off (**Show <name> in the library**, on the Maintenance page under Library scanning).
- The player doesn't name a source anywhere: its artist and album pages look like the library's, its songs are marked **External**, and a library artist's page links to the rest of what they made with **More releases**.

## 2.14.1

- **A library source's results are part of the search results.** Its songs, artists and albums are in the same Songs, Artists and Albums lists as the library's (after them), instead of sections of their own, and its songs are marked **External**.

## 2.14.0

- **Library sources: music from elsewhere, in the player's own search, artist and album pages.** A plugin can now add a source (a streaming service, say). Once an admin turns it on (**Show <name> in the library**, under Library in the settings), searching shows what the source has after the library's results, or instead of "No results", marked with the source's name. Artists and albums the library doesn't have open in the normal artist and album pages, read from the source.
  - Its songs play right away, streamed from the source through the server, and work like any song: in the queue, the now playing bar, on the lock screen. The first few results, and the next song up, are made ready ahead so they start without waiting.
  - Nothing is saved by playing. **Get** (on songs, albums and artists, when the source's plugin can get them) asks the plugin to bring it into the library. Once it's in, the player reads the library again: it shows up straight away, and a song that's playing becomes the library's copy without stopping.
  - Songs that aren't in the library yet can't be liked, put in playlists or saved for offline, and their plays aren't written into listening history.
  - A library artist's page links to the same artist on the source, for the rest of what they made.
  - Their artwork is fetched by the server, so listeners' browsers don't contact the source's image hosts.
  - For plugin makers: `api.source(...)`, described in [PLUGINS.md](PLUGINS.md#library-sources).

## 2.13.1

- **The library audit no longer stops without saying why, and it goes on by itself when it can.**
  - When the disk Axdio's settings and working files are on gets nearly full (under 1 GB free), Axdio stops its background jobs to keep its database safe. The audit's page just said "Stopped"; now its log and progress line say it was the disk, and the audit goes on where it left off once there's room again (1.5 GB free). The duplicate finder and the fixers say why in their logs too.
  - An audit cut short by a restart (an update, the Restart button, the container restarting) goes on where it left off after the server's first library scan. A re-check skips the songs it already re-checked.
  - Stopping it by hand is noted with who stopped it, and it stays stopped.
  - A song that trips up the audit in an unexpected way is noted in the log, and the audit carries on with the rest instead of ending early.

## 2.13.0

- **Fixed songs go where their tags say.** When the library audit's Fix tags, or Titles & tags, finds that a song is another artist's or on another album, the song now moves into that artist's and album's folder (Artist/Album/song), which is made if there isn't one yet. Before, its tags were fixed but it stayed in the old folder, so an album tagged under the wrong artist stayed there too.
  - Only a song that was filed under its old tags moves; folders an admin arranged by hand stay as they are. A folder that's already there is used however it's spelled.
  - Albums stay together. When most of an album moves, the rest of it follows (even a song that couldn't be verified) and takes the album artist the others were given. A song whose album already lives in the new artist's folder joins it there. When only a few songs of an album were fixed and the album isn't in the new place yet, they stay with it, and the log says so.
  - Lyrics files go along, and so does a cover image once no songs are left. Emptied folders are removed. Likes, playlists, history, the listening log and the audit follow every move, and `config/refiled.json` notes each one.
  - Titles & tags' Undo moves a song back. Songs that moved only because their album did are listed as "Moved with its album", and can be put back too.
- **Songs fixed before this version are filed once**, after the first library scan: those the audit re-tagged, or Titles & tags gave another artist or album.
- **Titles & tags replaces the album details of a song that turns out to be another song** (when its fingerprint says so): the album, album artist, date, track number and the rest, as Fix tags already did. Before, it only filled in the ones that were missing, so the wrong song's album could stay.

## 2.12.0

- **Plugins come from wherever you choose.** Axdio doesn't come with, link to or suggest any plugin. Admins add them on the Plugins page (**Add a plugin**) from:
  - a GitHub, GitLab or Codeberg repository, public or private (with an access token that's kept on the server and never shown again);
  - a link to a .zip or .tar.gz, a file uploaded from the admin's computer, a folder inside the container, or PyPI.
- **Installing is safer.** Before anything is installed, Axdio downloads the plugin and shows what it is, where it's from, who made it and what it will be able to do (run code on the server, add to the player or the admin panel, install Python packages), with a warning. It's installed only after the admin types their password again. Archives are unpacked safely (no links, nothing outside the plugin's folder, size limits), and tokens are never sent to another address.
- **More control over installed plugins:** turn one off without removing it, reinstall it, update it from its repository's release tags (or the newest commit of a branch) by hand or automatically, and remove it along with the Python packages only it needed and, if you want, what it saved. A plugin that can't start, or whose code runs into an error, shows why on the Plugins page.
- **Catalogs:** anyone can publish a list of plugins as a .json file. An admin adds it on the Plugins page, and its plugins show up there, ready to install.
- **Safe mode:** `AXDIO_SAFE_MODE=1` starts the server without loading any plugin, so a broken one can be turned off or removed.
- **Plugins can do much more** (version 2 of the plugin interface; plugins made for version 1 keep working). [PLUGINS.md](PLUGINS.md) is the new guide, and [examples/plugins](examples/plugins) has a complete example and a theme.
  - A plugin can be just a folder with an `axdio-plugin.json`, without Python packaging: a theme can be a single stylesheet.
  - In the player, on phones and computers: pages of their own (`/x/<plugin>/<page>`), menu items, song actions, home cards, settings sections, events (song changes, play and pause, likes, the queue, sign-in), and storage that follows each listener to every device.
  - On the server: routes for listeners or for everyone (not just admins), pages of their own, events (plays, library changes, sign-ins and sign-ups, settings, activity), filters for the pages and settings the player gets, scheduled jobs, a data folder, and helpers for the library, settings, the activity log and notifications.
  - Scripts and styles for the player, the admin panel and shared pages, and settings the player's scripts can read.
- What plugins keep for a listener is included when they download their data, and deleted with their account.
