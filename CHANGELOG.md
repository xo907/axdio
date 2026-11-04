# Changelog

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
