// The player half of the Hello example plugin. Axdio.plugin() hands it the plugin API once the player has started.
Axdio.plugin('hello', hello => {
  const greeting = () => hello.config.hello_greeting || 'Hello';

  // A page at /x/hello/main, opened from the menu and the home card below.
  hello.page('main', {
    title: 'Hello',
    icon: 'spark',
    async render(el) {
      const me = hello.user();
      el.innerHTML = `<div class="hello"><div class="hello-wave">${hello.icon('spark')}</div><h1>${hello.esc(greeting())}${me ? ', ' + hello.esc(me.name) : ''}!</h1><p class="hello-sub">Loading…</p></div>`;
      const sub = el.querySelector('.hello-sub');
      if (!me) { sub.textContent = 'Sign in, and Hello counts the songs you play.'; return; }
      try {
        const s = await hello.api('stats');
        sub.textContent = `You've played ${s.plays} song${s.plays === 1 ? '' : 's'} since Hello was installed.`;
      } catch (e) { sub.textContent = e.message; }
      const now = hello.track();
      if (now) el.querySelector('.hello').insertAdjacentHTML('beforeend', `<p class="hello-now">Now playing: <b>${hello.esc(now.title)}</b> by ${hello.esc(now.artist)}</p>`);
    },
  });

  hello.menu({ label: 'Hello', icon: 'spark', run: () => hello.go('main') });

  // An action in every song's menu.
  hello.trackAction({
    label: 'Wave at this song',
    icon: 'spark',
    run: async songs => {
      if (hello.user()) await hello.api('wave', { method: 'POST', body: { title: songs[0].title } }).catch(() => {});
      hello.toast(`You waved at ${songs[0].title}`);
    },
  });

  hello.homeCard({ label: 'Example plugin', title: greeting(), sub: 'See what plugins can add', icon: 'spark', color: 'linear-gradient(120deg, #0f766e, #0e7490 55%, #1d4ed8)', run: () => hello.go('main') });

  // A setting in the player's Settings. What it keeps follows the listener to every device (hello.store).
  let announce = false;
  hello.store.get('announce').then(v => { announce = !!v; }).catch(() => {});
  hello.settings({
    title: 'Hello',
    render(el) {
      el.appendChild(hello.row({ title: 'Greet each new song', sub: 'Show a message when a song starts', toggle: announce,
        onChange: on => { announce = on; hello.store.set('announce', on).catch(e => hello.toast(e.message)); } }));
    },
  });
  hello.on('track', song => { if (announce && song) hello.toast(`${greeting()}, ${song.title}!`); });
});
