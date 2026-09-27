# Hello: an example Axdio plugin

A small plugin that shows most of what a plugin can do, to copy and start your own from:

- `axdio-plugin.json` says what it is and what it adds: its id, name and version, its server code, its player script and
  stylesheet, and a setting in the admin panel (`hello_greeting`, which the player script may read).
- `server.py` counts the songs each listener plays (the `play` event), keeps the counts in the plugin's data folder,
  and answers two routes for signed-in listeners: `/api/plugins/hello/stats` and `/api/plugins/hello/wave`.
- `static/hello.js` adds a page (`/x/hello/main`), a menu item, a song action, a home card and a player setting that
  follows the listener to every device.
- `static/hello.css` styles the page.

To try it, zip this folder and install the file on the admin panel's **Plugins** page (**Add a plugin → From a file**),
or copy it into the container and install it **From a folder**. [PLUGINS.md](../../../PLUGINS.md) is the full guide.
