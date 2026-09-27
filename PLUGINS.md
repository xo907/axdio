# Making Axdio plugins

A plugin adds something Axdio doesn't come with. It can add pages, menu items, song actions, home cards and settings to
the player. It can restyle the player, add pages and tools to the admin panel, and run code on the server with routes,
events, scheduled jobs and storage of its own. Anyone can make one and publish it anywhere. An admin installs it on the
**Plugins** page of the admin panel.

Plugins aren't part of Axdio, and Axdio doesn't check them. A plugin's server code runs inside the server with the same
access as Axdio itself, and its player scripts run in every listener's browser. That's why only admins can install
plugins, and why installing one asks for the admin's password again.

- [A first plugin](#a-first-plugin)
- [axdio-plugin.json](#axdio-pluginjson)
- [In the player](#in-the-player)
- [On the server](#on-the-server)
- [In the admin panel](#in-the-admin-panel)
- [Settings](#settings)
- [Themes](#themes)
- [Plugins that are Python packages](#plugins-that-are-python-packages)
- [Publishing and updates](#publishing-and-updates)
- [Catalogs](#catalogs)
- [Private plugins](#private-plugins)
- [Safe mode and troubleshooting](#safe-mode-and-troubleshooting)
- [Compatibility](#compatibility)

Two complete examples are in [examples/plugins](examples/plugins):
- [Hello](examples/plugins/hello) uses most of what's described here.
- [Midnight](examples/plugins/midnight) is a theme that's only a stylesheet.

## A first plugin

A plugin is a folder with an `axdio-plugin.json` in it:

```
my-plugin/
├── axdio-plugin.json
├── server.py            (optional: code that runs on the server)
└── static/              (files the browser gets: scripts, styles, images)
    ├── my-plugin.js
    └── my-plugin.css
```

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does, in a sentence or two.",
  "author": "You",
  "license": "MIT",
  "homepage": "https://github.com/you/my-plugin",
  "axdio": "2.12.0",
  "server": "server.py",
  "app": { "scripts": ["my-plugin.js"], "styles": ["my-plugin.css"] }
}
```

`static/my-plugin.js` adds a page to the player, and a menu item that opens it:

```js
Axdio.plugin('my-plugin', plugin => {
  plugin.page('main', {
    title: 'My plugin',
    render(el) { el.innerHTML = `<h1>Hello, ${plugin.esc(plugin.user()?.name || 'listener')}</h1>`; },
  });
  plugin.menu({ label: 'My plugin', icon: 'spark', run: () => plugin.go('main') });
});
```

`server.py` adds a route the page can call:

```python
from flask import jsonify

def register(api):
    @api.route("hello", access="user")
    def hello():
        return jsonify({"hello": api.user()})
```

To try it, zip the folder. Then on the admin panel's **Plugins** page, choose **Add a plugin → From a file**. While you're
working on it, **From a folder** installs it from a folder inside Axdio's container (mount one in with `-v`). After you
change files, choose **Reinstall** in the plugin's menu. The Plugins page then also says an update is available.

## axdio-plugin.json

| Key | |
|---|---|
| `id` | Required. 1–40 lowercase letters, digits, `-` or `_`. It's in the plugin's addresses and the start of its setting keys, so don't change it later. |
| `name`, `version`, `description`, `author`, `license`, `homepage` | Shown on the Plugins page and before installing. Use version numbers like `1.2.3`. |
| `axdio` | The oldest Axdio it works with, like `"2.12.0"`. Older servers refuse to install it. |
| `api` | The plugin interface it was made for: `2` (the default, Axdio 2.12). |
| `server` | Its server code: a `.py` file, or a folder with an `__init__.py`. Leave it out for a plugin that only changes the player. |
| `module` | For a plugin that's a Python package: the module to load (see [below](#plugins-that-are-python-packages)). |
| `requires` | Python packages its server code needs, as pip writes them: `["requests>=2.31"]`. They're installed into Axdio's plugin environment. |
| `app` | Scripts and stylesheets for the player: `{"scripts": [...], "styles": [...]}`, paths inside `static/`. |
| `admin` | The same for every page of the admin panel. |
| `share` | The same for shared song, album and artist pages (`/track/…`, `/album/…`, `/artist/…`). |
| `admin_pages` | Pages in the admin panel's menu: `[{"id", "title", "icon", "script", "group"}]` ([more](#in-the-admin-panel)). |
| `settings` | Settings shown in the admin panel ([more](#settings)). |

Files in `static/` are served at `/plugins/<id>/<file>`, to anyone who may use the server, except the ones only the
admin panel uses: its admin pages' scripts, what `admin` lists (unless `app` or `share` lists it too) and everything in
`static/admin/`. Those are served to signed-in admins only. Nothing outside `static/` is served, and nothing in it should
be secret.

## In the player

Every script a plugin adds to the player calls `Axdio.plugin(id, setup)`. `setup(plugin)` runs once the player has
started. It runs on phones and computers alike (`plugin.platform` is `"mobile"` or `"desktop"`). Everything below is a
method of `plugin`:

**Adding things**
- `page(id, { title, icon, render(el, params) })` adds a page at `/x/<plugin id>/<page id>`. `render` fills `el`. It
  may be `async`, and may return a function that's called when the listener leaves the page. `params` are the address's
  query parameters.
- `go(pageId = 'main', params)` opens one of its pages. `link(pageId, params)` gives the page's address.
- `menu({ label, icon, run, when })` adds an item to the account menu on computers, and to **Extras** in Settings on
  phones. `when()` can hide it.
- `trackAction({ label, icon, run(songs), when(songs) })` adds an action to songs' menus.
- `homeCard({ label, title, sub, icon, image, color, run, when })` adds a card to the home page. `color` is a CSS
  background, like a `linear-gradient(…)`. Or pass a function that returns the card's HTML.
- `settings({ title, render(el) })` adds a section to the listener's Settings. `row({ title, sub, toggle, onChange,
  button, onClick, value })` makes a settings row in the player's own style.
- `css(text)` adds a stylesheet from a string.

Icons (`icon`) are the names of the player's own: `spark`, `note`, `album`, `person`, `people`, `heart`, `radio`,
`chart`, `trophy`, `compass`, `history`, `gear`, `tune`, `mic`, `chat`, `share`, `queue`, `search`, `home`, `lib`,
`play`, `pause`, `moon`, `timer`, `image`, `flame`, `party`, `karaoke`, `devices`, `key`, `lock`, `shield`, `smile`,
`copy`, `edit`, `trash`, `external` and others in `web/app/core.js`. `icon(name)` gives an icon's SVG for your own HTML
(and passes an `<svg>` string through as it is).

**What the player does**
- `on(event, fn)` returns a function that stops listening. Events:
  - `track (song)`: another song started.
  - `play (song)`, `pause (song)`.
  - `progress ({ time, duration })`: about once a second while playing.
  - `queue ({ next })`: what plays next changed.
  - `like ({ song, liked })`.
  - `route ({ view, params })`: the listener went to another page.
  - `library`: the library changed.
  - `signin ({ username })`, `signout`.
  - `ready ({ platform })`.
- `track()` is the song playing now. `playing()` says whether it's playing.
- `songs()` lists every song in the library. `song(rel)` is one of them.
- `play(songs, start)` plays a list of songs (paths or song objects). `queue(songs, next)` adds songs to the queue.
- `user()` is `{ username, name, avatar }`, or `null` when nobody is signed in.

A song is `{ id, rel, title, artist, album, cover }`. `rel` is its path in the library.

**Its server, and keeping things**
- `api(path, { method, body })` calls the plugin's own routes (`/api/plugins/<id>/<path>`) as the signed-in listener. It
  returns the JSON answer, or throws an `Error` with the server's message.
- `store.get(key)`, `store.set(key, value)`, `store.remove(key)` and `store.all()` keep small things for the listener on
  the server, so they follow the listener to every device. Without an account, they're kept in the browser instead.
  Each value is at most 64 KB, and a plugin can keep at most 200 per listener.
- `config` holds the plugin's settings that are marked `public` ([Settings](#settings)).
- `url(file)` is the address of a file in `static/`.

**Small things**
- `toast(text)` shows a short message.
- `confirm(title, text, { ok, danger })` resolves to `true` or `false`.
- `esc(text)` escapes text for HTML.
- `id`, `name`, `version`.

`plugin.AX` is the player's whole engine (the library, the player, the queue, the listener's data). It's there for what
the methods above don't cover. It changes between Axdio versions, so prefer the methods where you can.

## On the server

Server code is a Python module with a `register(api)` function. Axdio calls it when the plugin is loaded: at start, and
without a restart when the plugin is installed, updated or turned back on. Whatever it registers is removed again when
the plugin is turned off, updated or removed. Put anything to stop (threads, connections) in a module-level
`unregister()` function. Axdio calls it then.

Server code runs in Axdio's process, with Flask and Axdio's own packages available. A folder plugin's server code is
loaded as the package `axdio_plugins.<id>`, with the plugin's folder as the package's folder, so `from . import helpers`
works.

**Routes and pages**
- `@api.route(path, methods=("GET",), access=...)`. With `access="admin"` (the default), the route is
  `/api/admin/plugins/<id>/<path>`, for signed-in admins only. With `"user"` it's `/api/plugins/<id>/<path>`, for
  signed-in listeners. With `"public"` it's the same address, for anyone who may use the server (on a private server,
  that's signed-in listeners). A `<name>` part of `path` matches one segment and is passed to the handler as a keyword
  argument.
- `@api.web(path, methods=("GET",), access="public")` adds a page of the plugin's own at `/plugins/<id>/<path>`, outside
  the player. Files in `static/` are served when no handler matches. A `"user"` page sends visitors who aren't signed in
  to sign in first. An `"admin"` page is for signed-in admins only.
- `api.user()` is the signed-in listener's username in a route, or `None`. `api.is_admin()` says whether the request
  comes from a signed-in admin.

Handlers are Flask views: use `flask.request`, and return `jsonify(...)`, a dict, a string or a `Response`. An error in
one answers 500, and it's shown with the plugin on the Plugins page. Plugins that change things through routes used from
the player should accept only POST, PUT or DELETE for that, with JSON bodies.

**Events, filters and jobs**
- `@api.on(event)` runs `fn(data)` in the background when something happens. `data` is a dict with the event's name
  (`event`), its time (`at`) and:
  - `play`: `user`, `rel`, `title`, `artist`, `album`, `duration`.
  - `library`: `added`, `updated`, `removed`, each a list of paths.
  - `signed_in`: `user`, `how` (`password` or `link`).
  - `signed_up`: `user`, `display_name`.
  - `settings`: `keys`, the settings that were saved.
  - `activity`: `kind`, `message`, `who`, `level`, for everything the admin panel's Activity page lists.
  - Any event another plugin sends with `api.emit(event, **data)`.

  Accept keys you don't use, since events may carry more of them later.
- `@api.filter(name)` changes a value as Axdio makes it: `fn(value, context)` returns the new value. The filters are:
  - `page_html (html, {"path", "page"})`: the HTML of player pages (`page` is `"app"`) and shared pages (`"share"`).
  - `public_settings (settings, {})`: what the player is told about the server at start.
- `@api.every(seconds, first=None)` runs a function every `seconds` (at least 10) in the background.
- `api.hook(name, fn)` answers questions Axdio asks plugins:
  - `busy`: return `True` while the plugin is doing something, so plugins aren't updated underneath it.
  - `stop`: stop what's running (the disk is nearly full).
  - `replace_audio`: the library audit's repairs.

**Storage**
- `api.data_dir` is a folder of the plugin's own in `config/plugins/data/<id>`. It's kept across updates and restarts,
  and deleted only if the admin asks for that when removing the plugin.
- `api.load(name, default)` and `api.save(name, data)` read and write JSON files there.
- `api.user_data(user, key, default)` and `api.set_user_data(user, key, value)` read and write what the plugin keeps for
  a listener. It's the same place the player's `store` uses. It's included when listeners download their data, and
  deleted with their account.

**The library and the rest**
- `api.library()` gives `{path: {"title", "artist", "album", "track_number", "duration", …}}` for every song. Read it,
  don't change it.
- `api.music_dir()`, `api.tags(rel)`, `api.write_tags(rel, values, cover=None)`, `api.refresh(rel)` (read a song's file
  again) and `api.rescan()`.
- `api.setting(key, default)` reads a setting.
- `api.log(message, level)` writes to the admin panel's Activity page. `api.notify(title, message)` sends a message to
  the server's Discord or webhook notifications.
- `api.client(script=None, style=None, where="app")` adds a file from `static/` to the player (`"app"`), the admin panel
  (`"admin"`) or shared pages (`"share"`), like the manifest's lists do.
- `api.id`, `api.name`, `api.plugin_version`, `api.axdio_version`, `api.manifest`, `api.dir` (the plugin's own folder).

`api.core` is the server module itself: every function and setting of Axdio. It's there for what the methods above
don't cover. Its names change between versions, so a plugin that uses it should say which Axdio versions it works with.

## In the admin panel

A page in the admin panel's menu comes from `admin_pages` in the manifest, or `api.admin_page(id, title, icon, script,
group)`. `group` is the menu group (`Server`, `Library` or `System`), and `script` is a file in `static/`, served to
admins only (so are files in `static/admin/`, for anything else the page loads). The script draws the page:

```js
AxdioAdmin.page('my-page', async el => {
  const data = await AxdioAdmin.api('/api/admin/plugins/my-plugin/status');
  el.innerHTML = `<section class="card"><div class="card-b">${AxdioAdmin.esc(data.text)}</div></section>`
    + AxdioAdmin.settingsCard('my-plugin');
});
```

`AxdioAdmin` has the admin panel's helpers:
- `api`, `toast`, `fail`, `dialog`, `confirmDlg`, `openMenu`, `every` (intervals that stop when the page changes).
- `settingsCard(sectionId)`, `termLine`, `fillTerm`, `esc`, `ic`, `nf`, `ago`, `plural`, `fmtBytes`, `$`, `$$`, `go`.

The admin panel's own pages in `web/admin/admin.js` show how they're used. Scripts in the manifest's `admin` list load on
every page of the panel.

## Settings

A plugin's settings are sections like those of the admin panel, in the manifest's `settings` or with
`api.settings(section)`:

```json
"settings": {
  "id": "my-plugin",
  "title": "My plugin",
  "fields": [
    { "key": "my_plugin_color", "type": "color", "label": "Colour", "default": "#22c55e", "public": true },
    { "key": "my_plugin_limit", "type": "number", "label": "How many", "default": 10, "min": 1, "max": 50,
      "help": "Shown under the setting." }
  ]
}
```

- Types are `bool`, `number`, `select` and `multi` (both with `"options": [["value", "Label"], ...]`), `text`,
  `textarea`, `url`, `code`, `color` and `secret`.
- Keys start with the plugin's id, with `-` written as `_`.
- A plugin without an admin page of its own has its settings shown on the Plugins page.
- On the server, read them with `api.setting(key)`.
- Fields marked `"public": true` also reach the player's scripts, as `plugin.config`. `secret` fields never do.

## Themes

The player's colours are CSS variables. A theme is a plugin with a stylesheet in `app` (and in `share` for shared
pages) that sets them again in `:root`:
- `--bg`, `--panel`, `--elev`, `--elev-2`, `--elev-3`: backgrounds, from the page to raised surfaces.
- `--text`, `--text-2`, `--text-3`: text, from main to faint.
- `--line`: borders.
- `--danger`: warnings.

The accent colour (`--accent`) is chosen by the admin and by each listener, so a theme shouldn't force it.

Any other rule works too, but the player's class names aren't a stable interface.
[Midnight](examples/plugins/midnight) is a complete theme.

## Plugins that are Python packages

A plugin can also be a regular Python package: a `pyproject.toml` that declares an entry point in the `axdio.plugins`
group:

```toml
[project]
name = "axdio-my-plugin"
version = "1.0.0"
dependencies = ["requests>=2.31"]

[project.entry-points."axdio.plugins"]
my-plugin = "axdio_my_plugin"          # plugin id = module
```

Axdio installs it with pip into its plugin environment, with its dependencies, and loads the module named by the entry
point. Its `static/` folder is the one inside the module's folder. Include it with `package-data`. Add an
`axdio-plugin.json` next to `pyproject.toml` for what the manifest describes (settings, scripts, admin pages), and it's
read when the plugin is installed from a repository, a file or a folder.

The module can say which versions it works with:
- `AXDIO_API = 2` is the plugin interface it was made for.
- `AXDIO_MIN = "2.12.0"` is the oldest Axdio it works with.

Packaged plugins can be published on PyPI and installed with `pypi:axdio-my-plugin`.

## Publishing and updates

Put the plugin in a repository on GitHub, GitLab or Codeberg. Axdio installs from a link to the repository.

- **Releases** are tags like `v1.2.0`. Axdio installs the newest tag, and later updates when a newer one appears. Admins
  can have that happen on its own (**Keep it up to date automatically**). Keep `version` in the manifest the same as the
  tag.
- **Without tags**, Axdio installs the newest commit of the repository's main branch, and updates when it changes. A
  link to a branch (`https://github.com/you/my-plugin/tree/dev`) follows that branch.
- **A link to a .zip or .tar.gz** works too. The plugin can be in a folder inside it. When the server that holds the file
  says it changed (its ETag or Last-Modified), that's an update.
- **Files** (**From a file**) are updated by installing the new version's file. Settings, saved data and choices are
  kept.

Axdio looks for new versions once a day (adjustable on the Plugins page). An update is loaded without a restart, once
nothing that uses the plugin is running.

## Catalogs

A catalog is a list of plugins that anyone can publish as a `.json` file. An admin adds it on the Plugins page, and its
plugins are listed there, ready to install:

```json
{
  "name": "Someone's Axdio plugins",
  "plugins": [
    { "id": "my-plugin", "name": "My plugin", "description": "What it does.", "author": "You", "license": "MIT",
      "homepage": "https://github.com/you/my-plugin", "source": "https://github.com/you/my-plugin" }
  ]
}
```

`source` is what an admin would paste into **Add a plugin**. Installing from a catalog still shows what the plugin is,
and asks for the admin's password.

## Private plugins

A plugin can live in a private repository. When adding it, open **It's a private repository** and give an access token
that can read it:
- On GitHub, use a fine-grained personal access token (**Settings → Developer settings → Personal access tokens**), with
  access to only that repository and the read-only **Contents** permission.
- On GitLab, use a token with `read_repository` or `read_api`.
- On Codeberg, use a token with repository read access.

The token is kept in `config/plugins/plugins.json`, readable only by the server's user. It's used only to download that
plugin and check for new versions, and it's never shown again. It's never sent to another address: Axdio drops it when
a download is redirected elsewhere. It can be changed or removed from the plugin's menu. A private plugin can also be
installed from a file, without a token, if it doesn't need updating on its own.

## Safe mode and troubleshooting

- A plugin that can't be loaded (an error in its code, a missing package) is shown on the Plugins page with the error,
  and the rest of Axdio carries on. So are errors in its routes, events, filters and jobs.
- A plugin can be turned off without removing it.
- If a plugin stops the server from starting at all, start it once with the environment variable `AXDIO_SAFE_MODE=1`.
  No plugin is loaded then, and it can be turned off or removed from the Plugins page.
- The server log (**Server logs** in the admin panel) says which plugins were loaded.
- Removing a plugin removes the Python packages only it needed. What it saved is kept unless the admin chooses to delete
  it too.

## Compatibility

This page describes version 2 of the plugin interface (Axdio 2.12). Plugins made for version 1 (Axdio 2.8 to 2.11) keep
working, and can be installed as they are: a package without a manifest or entry point is recognized by its module's
`AXDIO_API` and `register(api)`, and its id is its package name without `axdio-`. Their settings keys aren't checked, and
`api.version` is the interface's version.

The methods of `api` (on the server) and of `plugin` (in the player) are the stable interface: later versions keep them
working, or change the interface's version number. `api.core`, `plugin.AX` and the player's markup and class names are
not stable.
