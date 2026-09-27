# Changelog

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
