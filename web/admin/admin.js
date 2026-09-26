/* ==========================================================================
   Axdio admin panel

   Settings pages are generated from the server's schema (/api/admin/v2/config),
   so a new setting only needs a schema entry in server.py. Tool pages (library audit,
   metadata & lyrics, files) talk to the older /api/admin/* endpoints. Plugins can add
   pages of their own through window.AxdioAdmin (see "Pages from plugins").
   ========================================================================== */
(() => {
'use strict';

/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const nf = n => Number(n || 0).toLocaleString();
const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : (many || one + 's')}`;
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const toMs = t => typeof t === 'number' ? t * 1000 : Date.parse(t);
function ago(t) {
  const ms = toMs(t); if (!ms || isNaN(ms)) return '—';
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}
const fmtTime = t => { const ms = toMs(t); return ms ? new Date(ms).toLocaleString() : '—'; };

async function api(path, body, method) {
  const init = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: {}, cache: 'no-store' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  if (res.status === 401 && path.startsWith('/api/admin/')) { location.href = '/admin/login'; throw new Error('Your admin session ended.'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; throw err; }
  return data;
}

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, bad ? 5000 : 2600);
}
const fail = e => toast(e.message || String(e), true);

async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); }
  catch (e) { window.prompt('Copy this:', text); }
}

/* Modal dialog. `fields` renders labelled inputs; resolves with their values, or null when cancelled. */
function dialog({ title, text = '', html = '', fields = [], ok = 'OK', cancel = 'Cancel', danger = false, validate }) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const fieldHtml = fields.map(f => f.type === 'check'
      ? `<label class="check"><input type="checkbox" name="${f.name}"${f.value ? ' checked' : ''}> ${esc(f.label)}</label>`
      : f.type === 'select'
        ? `<label>${esc(f.label)}<select class="select" name="${f.name}">${f.options.map(([v, l]) => `<option value="${esc(v)}"${String(f.value) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`
        : `<label>${esc(f.label)}<input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} autocomplete="${f.autocomplete || 'off'}"></label>`).join('');
    back.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate><h3>${esc(title)}</h3><div class="m-b">${text ? `<div>${esc(text)}</div>` : ''}${html}${fieldHtml}<div class="m-err" role="alert"></div></div><div class="m-f">${cancel ? `<button type="button" class="btn ghost" data-x>${esc(cancel)}</button>` : ''}<button type="submit" class="btn ${danger ? 'danger solid' : 'primary'}">${esc(ok)}</button></div></form>`;
    const form = back.firstChild;
    const values = () => Object.fromEntries(fields.map(f => { const el = form.elements[f.name]; return [f.name, f.type === 'check' ? el.checked : el.value]; }));
    const close = v => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    form.addEventListener('submit', e => {
      e.preventDefault();
      const v = fields.length ? values() : true;
      const err = validate && validate(v);
      if (err) { $('.m-err', form).textContent = err; return; }
      close(v);
    });
    back.addEventListener('mousedown', e => { if (e.target === back) close(null); });
    $('[data-x]', form)?.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    $('#layer').appendChild(back);
    (form.querySelector('input:not([type=checkbox]), select') || form.querySelector('[type=submit]')).focus();
  });
}
const confirmDlg = (title, text, ok = 'Continue', danger = false) => dialog({ title, text, ok, danger }).then(Boolean);

/* Choosing folders or artists for a job (audit, metadata fixer, titles & tags). Empty means the whole library. */
const SCOPES = {};
const scopeOf = id => (SCOPES[id] = SCOPES[id] || { paths: [], artists: [] });
const scopeBody = id => ({ paths: scopeOf(id).paths.slice(), artists: scopeOf(id).artists.slice() });
const scopeHtml = id => `<div class="scope" id="scope-${id}" data-scope="${id}"></div>`;
function drawScope(id) {
  const el = $('#scope-' + id); if (!el) return;
  const s = scopeOf(id), n = s.paths.length + s.artists.length;
  const chip = (kind, v) => `<span class="scope-chip">${ic(kind === 'paths' ? 'folder' : 'access', 'sm')}<span>${esc(v)}</span><button type="button" data-act="scope-drop" data-scope="${id}" data-kind="${kind}" data-v="${encodeURIComponent(v)}" aria-label="Remove ${esc(v)}">${ic('close', 'sm')}</button></span>`;
  el.innerHTML = (n ? s.paths.map(v => chip('paths', v)).join('') + s.artists.map(v => chip('artists', v)).join('') : '<span class="scope-all">Whole library</span>')
    + `<button type="button" class="btn ghost sm" data-act="scope-pick" data-scope="${id}">${n ? 'Change' : 'Choose folders or artists'}</button>`;
}
function pickScope(id) {
  const cur = scopeOf(id), sel = { paths: new Set(cur.paths), artists: new Set(cur.artists) };
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal scope-modal" role="dialog" aria-modal="true" aria-label="Choose folders or artists"><h3>Choose folders or artists</h3>
    <div class="m-b"><input class="input" id="sc-q" placeholder="Search folders and artists" autocomplete="off" aria-label="Search folders and artists"><div class="sc-list" id="sc-list"><div class="empty">Loading…</div></div><div class="muted" id="sc-count"></div></div>
    <div class="m-f"><button type="button" class="btn ghost" data-sc="all" style="margin-right:auto">Whole library</button><button type="button" class="btn ghost" data-sc="cancel">Cancel</button><button type="button" class="btn primary" data-sc="ok">Done</button></div></div>`;
  const list = $('#sc-list', back), q = $('#sc-q', back);
  const count = () => { const n = sel.paths.size + sel.artists.size; $('#sc-count', back).textContent = n ? `${plural(n, 'choice')}: songs in any of them are included.` : 'Nothing chosen: the whole library.'; };
  const row = (kind, v, songs) => `<label class="sc-row"><input type="checkbox" data-kind="${kind}" data-v="${encodeURIComponent(v)}"${sel[kind].has(v) ? ' checked' : ''}>${ic(kind === 'paths' ? 'folder' : 'access', 'sm')}<span class="grow">${esc(v)}</span>${songs != null ? `<span class="muted">${plural(songs, 'song')}</span>` : ''}</label>`;
  let seq = 0, timer = 0;
  const load = async () => {
    const my = ++seq;
    const d = await api('/api/admin/library/scope?q=' + encodeURIComponent(q.value.trim())).catch(() => ({ folders: [], artists: [] }));
    if (my !== seq) return;
    const shown = { paths: new Set(d.folders.map(f => f.path)), artists: new Set(d.artists.map(a => a.name)) };
    const chosen = [...sel.paths].filter(v => !shown.paths.has(v)).map(v => row('paths', v)).concat([...sel.artists].filter(v => !shown.artists.has(v)).map(v => row('artists', v)));
    list.innerHTML = (chosen.length ? `<div class="sc-h">Chosen</div>${chosen.join('')}` : '')
      + (d.folders.length ? `<div class="sc-h">Folders</div>${d.folders.map(f => row('paths', f.path, f.songs)).join('')}` : '')
      + (d.artists.length ? `<div class="sc-h">Artists</div>${d.artists.map(a => row('artists', a.name, a.songs)).join('')}` : '')
      || '<div class="empty">Nothing matches.</div>';
  };
  const close = save => {
    if (save) { cur.paths = [...sel.paths]; cur.artists = [...sel.artists]; drawScope(id); }
    back.remove(); document.removeEventListener('keydown', onKey, true);
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
  list.addEventListener('change', e => { const c = e.target.closest('[data-kind]'); if (!c) return; const v = decodeURIComponent(c.dataset.v); c.checked ? sel[c.dataset.kind].add(v) : sel[c.dataset.kind].delete(v); count(); });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  back.addEventListener('click', e => {
    const b = e.target.closest('[data-sc]'); if (!b) return;
    if (b.dataset.sc === 'all') { sel.paths.clear(); sel.artists.clear(); close(true); }
    else close(b.dataset.sc === 'ok');
  });
  back.addEventListener('mousedown', e => { if (e.target === back) close(false); });
  document.addEventListener('keydown', onKey, true);
  $('#layer').appendChild(back);
  count(); load(); q.focus();
}

function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu'; m.id = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
  m.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { closeMenu(); items[+b.dataset.i].act(); } });
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenu(); }
  m._off = () => document.removeEventListener('mousedown', outside);
}
function closeMenu() { const m = $('#menu'); if (m) { m._off(); m.remove(); } }

/* ---------- State & page lifecycle ---------- */
const ST = { me: {}, schema: [], fields: {}, values: {}, draft: {}, page: null };
let pageTimers = [];
const every = (fn, ms) => pageTimers.push(setInterval(fn, ms));
const dirty = () => Object.keys(ST.draft).length > 0;

/* ---------- Settings forms (generated from the schema) ---------- */
const ACCENTS = ['#22c55e', '#1ed760', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#14b8a6', '#f5f5f5'];
const val = k => (k in ST.draft ? ST.draft[k] : ST.values[k]);

function fieldHtml(f) {
  const v = val(f.key), k = esc(f.key);
  const help = f.help ? `<div class="help">${esc(f.help)}</div>` : '';
  const head = `<div><div class="lab">${esc(f.label)}</div>${help}</div>`;
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  let ctl;
  switch (f.type) {
    case 'bool':
      return `<div class="field bool" data-f="${k}">${head}<label class="toggle"><input type="checkbox" data-k="${k}"${v ? ' checked' : ''} aria-label="${esc(f.label)}"><span></span></label></div>`;
    case 'textarea':
      ctl = `<textarea class="textarea" data-k="${k}" maxlength="${f.max || 2000}"${ph}>${esc(v)}</textarea>`; break;
    case 'code':
      return `<div class="field wide" data-f="${k}">${head}<div class="ctl"><textarea class="textarea code" data-k="${k}" spellcheck="false" autocapitalize="off"${ph}>${esc(v)}</textarea><div class="err"></div></div></div>`;
    case 'number':
      ctl = `<input class="input" type="number" data-k="${k}" value="${esc(v)}" min="${f.min}" max="${f.max}" style="max-width:140px">`; break;
    case 'select': {
      const short = f.options.length <= 8 && f.options.every(o => o[1].length <= 14);
      ctl = short
        ? `<div class="seg" role="radiogroup" aria-label="${esc(f.label)}">${f.options.map(([o, l]) => `<button type="button" role="radio" aria-checked="${o === v}" class="${o === v ? 'on' : ''}" data-k="${k}" data-v="${esc(o)}">${esc(l)}</button>`).join('')}</div>`
        : `<select class="select" data-k="${k}">${f.options.map(([o, l]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      break;
    }
    case 'multi':
      ctl = `<div class="checks">${f.options.map(([o, l]) => `<label class="check"><input type="checkbox" data-k="${k}" data-v="${esc(o)}"${(v || []).includes(o) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</div>`; break;
    case 'color':
      ctl = `<div class="color-ctl"><input type="color" data-k="${k}" value="${esc(v)}" aria-label="${esc(f.label)}"><input class="input" data-k="${k}" data-hex value="${esc(v)}" maxlength="7" spellcheck="false"></div><div class="swatches">${ACCENTS.map(c => `<button type="button" class="swatch${c === v ? ' on' : ''}" style="background:${c}" data-k="${k}" data-v="${c}" aria-label="${c}"></button>`).join('')}</div>`; break;
    case 'secret': case 'secret-text':
      ctl = `<div class="input-wrap"><input class="input" type="password" data-k="${k}" value="${esc(v)}" autocomplete="off" spellcheck="false"${ph}><button type="button" class="icon-btn" data-act="reveal" aria-label="Show">${ic('eye')}</button></div>`; break;
    default:
      ctl = `<input class="input" type="${f.type === 'url' ? 'url' : 'text'}" data-k="${k}" value="${esc(v)}" maxlength="${f.max || 2000}" spellcheck="false"${ph}>`;
  }
  return `<div class="field" data-f="${k}">${head}<div class="ctl">${ctl}<div class="err"></div></div></div>`;
}

function settingsCard(sectionId, { title, desc, extra = '' } = {}) {
  const sec = ST.schema.find(s => s.id === sectionId);
  if (!sec) return '';
  return `<section class="card">${title !== false ? `<div class="card-h"><h2>${esc(title || sec.title)}</h2>${extra}</div>` : ''}${desc ? `<p class="desc">${desc}</p>` : ''}<div class="fields">${sec.fields.map(fieldHtml).join('')}</div></section>`;
}

function readField(el) {
  const k = el.dataset.k, f = ST.fields[k];
  if (f.type === 'bool') return el.checked;
  if (f.type === 'number') return el.value === '' ? ST.values[k] : Number(el.value);
  if (f.type === 'multi') return $$(`input[data-k="${k}"]`).filter(x => x.checked).map(x => x.dataset.v);
  if (el.dataset.v != null) return el.dataset.v;
  return el.value;
}
function setDraft(k, v) {
  const same = JSON.stringify(v) === JSON.stringify(ST.values[k]);
  if (same) delete ST.draft[k]; else ST.draft[k] = v;
  const row = $(`.field[data-f="${k}"]`);
  if (row) { row.classList.toggle('changed', !same); const e = $('.err', row); if (e) e.textContent = ''; }
  if (k === 'accent_color' && /^#[0-9a-f]{6}$/i.test(v)) applyAccent(v);
  $('#savebar').hidden = !dirty();
}
function onFieldInput(e) {
  const el = e.target.closest('[data-k]');
  if (!el || !ST.fields[el.dataset.k]) return;
  const k = el.dataset.k, f = ST.fields[k];
  if (el.matches('.seg button, .swatch')) {
    if (f.type === 'select') $$(`.seg button[data-k="${k}"]`).forEach(b => { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  }
  const v = readField(el);
  if (f.type === 'color') {
    $$(`[data-k="${k}"]`).forEach(x => { if (x !== el && x.matches('input')) x.value = v; });
    $$(`.swatch[data-k="${k}"]`).forEach(s => s.classList.toggle('on', s.dataset.v.toLowerCase() === String(v).toLowerCase()));
  }
  setDraft(k, v);
}
document.addEventListener('input', onFieldInput);
document.addEventListener('change', e => { if (e.target.matches('select[data-k], input[type=checkbox][data-k]')) onFieldInput(e); });
document.addEventListener('click', e => { if (e.target.closest('.seg button[data-k], .swatch[data-k]')) onFieldInput(e); });

async function saveDraft() {
  if (!dirty()) return true;
  const btn = $('#savebar [data-act=save]');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/v2/config', { values: ST.draft });
    ST.values = r.values; ST.draft = {};
    $$('.field.changed').forEach(x => x.classList.remove('changed'));
    $('#savebar').hidden = true;
    toast(r.changed.length ? 'Settings saved' : 'Nothing changed');
    applyBrand();
    return true;
  } catch (e) {
    const fields = (e.data && e.data.fields) || {};
    Object.entries(fields).forEach(([k, m]) => { const row = $(`.field[data-f="${k}"] .err`); if (row) row.textContent = m; });
    fail(e);
    return false;
  } finally { btn.disabled = false; }
}
function discardDraft() {
  ST.draft = {};
  $('#savebar').hidden = true;
  applyAccent(ST.values.accent_color);
  render();
}

/* ---------- Branding ---------- */
function applyAccent(c) {
  if (!c) return;
  document.documentElement.style.setProperty('--accent', c);
  const n = parseInt(c.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  document.documentElement.style.setProperty('--on-accent', lum > 0.6 ? '#000' : '#fff');
}
function applyBrand() {
  const title = ST.values.site_title || ST.me.site_title || 'Axdio';
  $('#nav-site').textContent = title;
  document.title = `${title} · Admin`;
  applyAccent(ST.values.accent_color || ST.me.accent_color);
}

/* ---------- Pages ---------- */
const PAGES = [
  { id: 'overview', title: 'Overview', icon: 'overview', render: pageOverview },
  { group: 'Server' },
  { id: 'general', title: 'General', icon: 'general', render: el => simpleSettings(el, 'general', 'Name, links and how your server shows up in search engines and link previews.') },
  { id: 'appearance', title: 'Appearance', icon: 'appearance', render: pageAppearance },
  { id: 'features', title: 'Features', icon: 'features', render: el => { simpleSettings(el, 'features', 'Turn features on or off for everyone, and choose the playback settings new listeners start with.'); el.insertAdjacentHTML('beforeend', settingsCard('scrobbling', { title: 'Last.fm scrobbling' })); } },
  { id: 'access', title: 'Accounts & access', icon: 'access', render: pageAccess },
  { id: 'security', title: 'Security', icon: 'security', render: pageSecurity },
  { id: 'notifications', title: 'Notifications', icon: 'notifications', render: pageNotifications },
  { group: 'Library' },
  { id: 'audit', title: 'Library audit', icon: 'audit', render: pageAudit },
  { id: 'duplicates', title: 'Duplicates', icon: 'copy', render: pageDuplicates },
  { id: 'metadata', title: 'Metadata & lyrics', icon: 'metadata', render: pageMetadata },
  { id: 'files', title: 'Files', icon: 'files', render: pageFiles },
  { id: 'sharing', title: 'Library sharing', icon: 'sharing', render: pageSharing },
  { group: 'System' },
  { id: 'plugins', title: 'Plugins', icon: 'plugins', render: pagePlugins },
  { id: 'updates', title: 'Updates', icon: 'refresh', render: pageUpdates },
  { id: 'maintenance', title: 'Maintenance & backups', icon: 'maintenance', render: pageMaintenance },
  { id: 'activity', title: 'Activity', icon: 'activity', render: pageActivity },
  { id: 'logs', title: 'Server logs', icon: 'logs', render: pageLogs },
  { id: 'about', title: 'About', icon: 'about', render: pageAbout },
];
const pageById = id => PAGES.find(p => p.id === id);

function renderNav() {
  $('#nav-list').innerHTML = PAGES.map(p => p.group
    ? `<div class="nav-group">${esc(p.group)}</div>`
    : `<a class="nav-item${p.id === ST.page ? ' on' : ''}" href="#/${p.id}" data-page="${p.id}">${ic(p.icon)}<span>${esc(p.title)}</span>${p.id === 'updates' && ST.update ? '<span class="pill">New</span>' : ''}</a>`).join('');
}

async function render() {
  const page = pageById(ST.page) || PAGES[0];
  pageTimers.forEach(clearInterval); pageTimers = [];
  closeMenu();
  $$('.nav-item').forEach(a => a.classList.toggle('on', a.dataset.page === page.id));
  $('#page-title').textContent = page.title;
  $('#top-actions').innerHTML = '';
  const el = $('#page');
  el.innerHTML = '';
  window.scrollTo(0, 0);
  try { await page.render(el); }
  catch (e) { el.innerHTML = `<div class="card"><div class="empty">Couldn't load this page: ${esc(e.message)}</div></div>`; }
}

async function go(id) {
  if (id === ST.page) return;
  if (dirty()) {
    const ok = await dialog({ title: 'Unsaved changes', text: 'Save your changes before leaving this page?', ok: 'Save', cancel: 'Discard' });
    if (ok) { if (!(await saveDraft())) { history.replaceState(null, '', '#/' + ST.page); return; } }
    else { ST.draft = {}; $('#savebar').hidden = true; applyAccent(ST.values.accent_color); }
  }
  ST.page = id;
  if (location.hash !== '#/' + id) history.pushState(null, '', '#/' + id);
  document.body.classList.remove('nav-open');
  render();
}
window.addEventListener('popstate', () => go((location.hash.slice(2) || 'overview')));
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

function simpleSettings(el, id, intro) {
  el.innerHTML = (intro ? `<p class="page-intro">${esc(intro)}</p>` : '') + settingsCard(id, { title: false });
}

/* Overview */
async function pageOverview(el) {
  const draw = async () => {
    const d = await api('/api/admin/v2/overview');
    const sys = d.system, lib = d.library, s = d.settings;
    const memPct = sys.mem_total_mb ? Math.round(100 * sys.mem_used_mb / sys.mem_total_mb) : 0;
    const loadPct = Math.min(100, Math.round(100 * sys.load[0] / sys.cpus));
    const lvl = p => p > 90 ? ' bad' : p > 75 ? ' warn' : '';
    const disk = (name, x) => x ? `<div class="bar-row"><div class="row"><span>${name} <span class="dim mono">${esc(x.path)}</span></span><span class="muted">${fmtBytes(x.used)} of ${fmtBytes(x.total)}</span></div><div class="meter${lvl(100 * x.used / x.total)}"><i style="width:${(100 * x.used / x.total).toFixed(1)}%"></i></div></div>` : '';
    const reg = { open: ['ok', 'Sign-ups open'], invite: ['info', 'Invite-only sign-ups'], closed: ['warn', 'Sign-ups closed'] }[s.registration] || ['', s.registration];
    const chips = [
      `<a class="chip" href="#/access"><span class="dot ${reg[0]}"></span>${reg[1]}</a>`,
      `<a class="chip" href="#/access"><span class="dot ${s.require_login ? 'info' : ''}"></span>${s.require_login ? 'Private server' : 'Public listening'}</a>`,
      `<a class="chip" href="#/maintenance"><span class="dot ${s.maintenance_mode ? 'warn' : 'ok'}"></span>${s.maintenance_mode ? 'Maintenance mode on' : 'Online'}</a>`,
      `<a class="chip" href="#/security"><span class="dot ${s.force_ssl ? 'ok' : ''}"></span>${s.force_ssl ? 'HTTPS enforced' : 'HTTPS not enforced'}</a>`,
    ].join('');
    const stat = (k, v, sub, href) => `<${href ? `a href="${href}" style="text-decoration:none"` : 'div'} class="stat"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</${href ? 'a' : 'div'}>`;
    const listening = d.listening.length
      ? d.listening.map(x => `<div class="li"><span class="dot ${x.is_playing ? 'ok' : 'info'}"></span><div class="grow"><div class="t ell">${esc(x.path)}</div><div class="s">${esc(x.ua)} · <span class="mono">${esc(x.ip)}</span></div></div><span class="n">${ago(x.last_seen)}</span></div>`).join('')
      : '<div class="empty">Nobody is listening right now.</div>';
    const top = d.top_tracks.length
      ? d.top_tracks.map((t, i) => `<div class="li"><span class="rank">${i + 1}</span><div class="grow"><div class="t ell">${esc(t.title)}</div><div class="s ell">${esc(t.artist)}</div></div><span class="n">${plural(t.plays, 'play')}</span></div>`).join('')
      : '<div class="empty">Plays by signed-in listeners show up here.</div>';
    const people = d.users.top.filter(u => u.plays).length
      ? d.users.top.filter(u => u.plays).map((u, i) => `<div class="li"><span class="rank">${i + 1}</span><div class="avatar">${esc((u.display_name || u.username)[0].toUpperCase())}</div><div class="grow"><div class="t ell">${esc(u.display_name)}</div><div class="s">@${esc(u.username)}</div></div><span class="n">${plural(u.plays, 'play')}</span></div>`).join('')
      : '<div class="empty">No listening history yet.</div>';
    const formats = Object.entries(lib.formats).map(([k, n]) => `<span class="badge">${esc(k.toUpperCase())} · ${nf(n)}</span>`).join(' ');
    const caches = d.caches;
    el.innerHTML = `<div class="chips">${chips}</div>
      <div class="stats">
        ${stat('Songs', nf(lib.tracks), formats ? '' : '')}
        ${stat('Artists', nf(lib.artists))}
        ${stat('Releases', nf(lib.albums))}
        ${stat('Accounts', nf(d.users.total), `${plural(d.users.admins, 'admin')} · ${plural(d.users.invites, 'open invite')}`, '#/access')}
        ${stat('Listening now', nf(d.listening.length), 'last 5 minutes')}
        ${stat('Uptime', fmtUptime(sys.uptime), 'since last restart', '#/about')}
      </div>
      <div class="grid two" style="margin-bottom:20px">
        <section class="card"><div class="card-h"><h2>Listening now</h2></div><div class="card-b flush list">${listening}</div></section>
        <section class="card"><div class="card-h"><h2>Server</h2><span class="sub">${sys.cpus} CPU${sys.cpus > 1 ? 's' : ''}</span></div><div class="card-b bars">
          <div class="bar-row"><div class="row"><span>CPU load</span><span class="muted">${sys.load.map(x => x.toFixed(2)).join(' · ')}</span></div><div class="meter${lvl(loadPct)}"><i style="width:${loadPct}%"></i></div></div>
          <div class="bar-row"><div class="row"><span>Memory</span><span class="muted">${nf(sys.mem_used_mb)} of ${nf(sys.mem_total_mb)} MB</span></div><div class="meter${lvl(memPct)}"><i style="width:${memPct}%"></i></div></div>
          ${disk('Music', sys.disks.music)}${disk('Config', sys.disks.config)}
        </div></section>
        <section class="card"><div class="card-h"><h2>Most played</h2></div><div class="card-b flush list">${top}</div></section>
        <section class="card"><div class="card-h"><h2>Most active listeners</h2></div><div class="card-b flush list">${people}</div></section>
      </div>
      <section class="card"><div class="card-h"><h2>Library</h2><a class="link" href="#/audit">Audit</a></div><div class="card-b"><dl class="kv">
        <dt>Music folder</dt><dd class="mono">${esc(lib.music_dir)}</dd>
        <dt>Scanning</dt><dd>${esc(scanLine(d.scan))} · <a class="link" href="#/maintenance">Settings</a></dd>
        <dt>Formats</dt><dd>${formats || '—'}</dd>
        <dt>Without embedded artwork</dt><dd>${nf(lib.missing_art)} songs · <a class="link" href="#/metadata">Fix artwork</a></dd>
        <dt>Cover cache</dt><dd>${fmtBytes(caches.covers.bytes)} · ${plural(caches.covers.files, 'image')}</dd>
        <dt>Lyrics cache</dt><dd>${fmtBytes(caches.lyrics.bytes)} · ${plural(caches.lyrics.files, 'song')}</dd>
        <dt>Quarantine</dt><dd>${fmtBytes(caches.quarantine.bytes)} · ${plural(caches.quarantine.files, 'file')}</dd>
      </dl></div></section>
      ${d.social ? `<section class="card"><div class="card-h"><h2>Social</h2><a class="link" href="#/features">Settings</a></div><div class="card-b"><dl class="kv">
        <dt>Friendships</dt><dd>${nf(d.social.friendships)}</dd>
        <dt>Private messages</dt><dd>${plural(d.social.messaging, 'account')} set up · ${plural(d.social.conversations, 'conversation')} · ${plural(d.social.messages, 'message')} (${fmtBytes(d.social.message_bytes)})</dd>
        ${d.social.media_files != null ? `<dt>Photos, videos and voice</dt><dd>${plural(d.social.media_files, 'attachment')} (${fmtBytes(d.social.media_bytes)})</dd>` : ''}
        <dt>Collaborative playlists</dt><dd>${nf(d.social.collab_playlists)}</dd>
        ${d.social.chat_dir ? `<dt>Stored in</dt><dd><code>${esc(d.social.chat_dir)}</code></dd>` : ''}
      </dl><p class="dim" style="margin-top:12px;font-size:12.5px">Messages and their attachments are end-to-end encrypted on listeners' devices. The server only stores scrambled data, so nobody here, including admins, can read them. Set <code>CHAT_DIR</code> to keep them in a folder of their own.</p></div></section>` : ''}
      <section class="card"><div class="card-h"><h2>Recent activity</h2><a class="link" href="#/activity">See all</a></div><div class="card-b flush list">${activityRows(d.activity) || '<div class="empty">Nothing yet.</div>'}</div></section>`;
  };
  await draw();
  every(() => { if (!document.hidden) draw().catch(() => {}); }, 10000);
}

const KIND = { login_failed: ['warn', 'Login'], lockout: ['bad', 'Security'], register: ['ok', 'Sign-up'], admin_login: ['info', 'Admin'], admin_logout: ['', 'Admin'],
  settings: ['accent', 'Settings'], user: ['info', 'Accounts'], invite: ['info', 'Invites'], branding: ['accent', 'Branding'], backup: ['', 'Backup'],
  restore: ['warn', 'Restore'], library: ['', 'Library'], maintenance: ['', 'Maintenance'], server: ['ok', 'Server'], admin_account: ['warn', 'Admin'],
  admin_setup: ['warn', 'Admin'], account: ['info', 'Accounts'], system: ['warn', 'System'] };
function activityRows(items) {
  return items.map(e => {
    const [cls, label] = KIND[e.kind] || ['', e.kind];
    return `<div class="li"><span class="badge ${cls}" style="min-width:74px;justify-content:center">${esc(label)}</span><div class="grow"><div class="ell">${esc(e.msg)}</div><div class="s">${e.who ? esc(e.who) + ' · ' : ''}${e.ip ? `<span class="mono">${esc(e.ip)}</span> · ` : ''}${fmtTime(e.t)}</div></div><span class="n hide-sm">${ago(e.t)}</span></div>`;
  }).join('');
}

/* Appearance: schema fields + logo/favicon/app icon */
async function pageAppearance(el) {
  const b = await api('/api/admin/v2/branding');
  const asset = (kind, title, sub, accept) => `<div class="asset"><div class="pv">${b[kind] ? `<img src="${esc(b[kind])}" alt="">` : '<span class="dim">Default</span>'}</div><div><div class="t">${title}</div><div class="s">${sub}</div></div><div class="row"><label class="btn ghost sm">${ic('upload')}Upload<input type="file" accept="${accept}" data-upload="${kind}" hidden></label>${b[kind] ? `<button class="btn ghost sm" data-act="asset-remove" data-kind="${kind}">Remove</button>` : ''}</div></div>`;
  el.innerHTML = `<p class="page-intro">How your server looks for everyone. Listeners can still choose their own accent colour.</p>
    <section class="card"><div class="card-h"><h2>Logo & icons</h2></div><div class="card-b"><div class="assets">
      ${asset('logo', 'Logo', 'Shown in the app header. PNG, JPG, WEBP or SVG up to 2 MB.', 'image/png,image/jpeg,image/webp,image/svg+xml')}
      ${asset('favicon', 'Browser icon', 'The tab icon. PNG or ICO up to 512 KB.', 'image/png,image/x-icon,.ico')}
      ${asset('app_icon', 'App icon', 'Home-screen and media-notification icon. Square PNG, 512×512.', 'image/png')}
    </div></div></section>` + settingsCard('appearance', { title: 'Theme & announcements' });
  el.addEventListener('change', async e => {
    const inp = e.target.closest('[data-upload]'); if (!inp || !inp.files[0]) return;
    const fd = new FormData(); fd.append('file', inp.files[0]);
    try { await api('/api/admin/v2/upload/' + inp.dataset.upload, fd); toast('Uploaded'); render(); loadNavMark(); }
    catch (err) { fail(err); inp.value = ''; }
  });
}

/* Accounts & access */
async function pageAccess(el) {
  el.innerHTML = settingsCard('access', { title: 'Access' })
    + settingsCard('discord', { title: 'Discord' }).replace('</section>', '<div class="desc" id="dc-redirect" style="padding-bottom:18px"></div></section>')
    + `<section class="card" id="users-card"><div class="card-h"><h2>Accounts <span class="sub" id="users-count"></span></h2><input class="input" id="users-q" placeholder="Search accounts" style="max-width:220px" aria-label="Search accounts"><button class="btn primary sm" data-act="user-new">${ic('plus')}New account</button></div><div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>Account</th><th class="hide-sm">Last active</th><th class="num hide-sm">Plays</th><th class="num hide-sm">Liked</th><th class="num hide-sm">Devices</th><th></th></tr></thead><tbody id="users-body"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div></div></section>`
    + `<section class="card" id="invites-card"><div class="card-h"><h2>Invites</h2><button class="btn ghost sm" data-act="invite-new">${ic('plus')}Create invite</button></div><p class="desc" id="invite-hint"></p><div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>Code</th><th>Uses</th><th class="hide-sm">Expires</th><th>Status</th><th></th></tr></thead><tbody id="invites-body"></tbody></table></div></div></section>`;
  $('#users-q').addEventListener('input', drawUsers);
  api('/api/admin/v2/discord').then(drawDiscordRedirect, () => {});
  await Promise.all([loadUsers(), loadInvites()]);
}
/* The redirect Discord must have on file: the address people sign in at, exactly. */
function drawDiscordRedirect(d) {
  const el = $('#dc-redirect'); if (!el) return;
  const urls = [location.origin + d.redirect_path];
  if (d.public_url && d.public_url !== location.origin) urls.push(d.public_url + d.redirect_path);
  const proxyHides = !d.public_url && d.server_sees !== location.origin;
  const named = !/^https?:\/\/(localhost|127\.|\d+\.\d+\.\d+\.\d+|\[)/.test(location.origin);
  el.innerHTML = `<b>For signing in:</b> in the Discord developer portal, open your application's <b>OAuth2</b> page, click <b>Add Redirect</b>, paste ${urls.length > 1 ? 'each of these' : 'this'} exactly, and click <b>Save Changes</b>.`
    + urls.map(u => `<div class="row" style="margin-top:8px"><span class="mono grow" style="user-select:all;word-break:break-all;color:var(--text)">${esc(u)}</span><button type="button" class="btn ghost sm" data-act="copy-text" data-v="${esc(u)}">${ic('copy', 'sm')}Copy</button></div>`).join('')
    + '<div style="margin-top:8px">If people also reach this server at another address, add that address with the same ending.</div>'
    + (proxyHides ? `<div style="margin-top:12px"><span class="badge warn">Check the Public URL</span> This server sees its own address as <span class="mono">${esc(d.server_sees)}</span>, not <span class="mono">${esc(location.origin)}</span>: your reverse proxy doesn't pass on the address. Signing in with Discord works anyway, but share links, link previews and library sharing use the address the server sees.${named ? `<div style="margin-top:10px"><button type="button" class="btn primary sm" data-act="use-origin">Use ${esc(location.origin)} as the Public URL</button></div>` : ''}</div>` : '');
}
let USERS = [];
async function loadUsers() { USERS = (await api('/api/admin/v2/users')).users; drawUsers(); }
function drawUsers() {
  const body = $('#users-body'); if (!body) return;
  const q = ($('#users-q')?.value || '').trim().toLowerCase();
  const rows = USERS.filter(u => !q || u.username.includes(q) || (u.display_name || '').toLowerCase().includes(q));
  $('#users-count').textContent = USERS.length ? `· ${nf(USERS.length)}` : '';
  body.innerHTML = rows.length ? rows.map(u => {
    const last = [u.last_login, u.last_played].filter(Boolean).sort().pop();
    return `<tr><td><div class="who"><div class="avatar">${/^(https?:|\/|data:image)/.test(u.avatar) ? `<img src="${esc(u.avatar)}" alt="">` : esc((u.display_name || u.username)[0].toUpperCase())}</div><div style="min-width:0"><div class="row" style="gap:8px"><b class="ell">${esc(u.display_name)}</b>${u.is_admin ? '<span class="badge accent">Admin</span>' : ''}${u.disabled ? '<span class="badge bad">Disabled</span>' : ''}</div><div class="dim" style="font-size:12.5px">@${esc(u.username)}${u.invited_with ? ` · invite ${esc(u.invited_with)}` : ''}</div></div></div></td>
      <td class="hide-sm muted">${last ? ago(last) : 'Never'}</td><td class="num hide-sm">${nf(u.plays)}</td><td class="num hide-sm">${nf(u.liked)}</td><td class="num hide-sm">${nf(u.devices)}</td>
      <td class="act"><button class="icon-btn" data-act="user-menu" data-u="${esc(u.username)}" aria-label="Actions for ${esc(u.username)}">${ic('more')}</button></td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">${q ? 'No accounts match.' : 'No accounts yet.'}</td></tr>`;
}
async function userAction(u, action, body = {}) {
  try { const r = await api(`/api/admin/v2/users/${encodeURIComponent(u)}/${action}`, body); await loadUsers(); return r; }
  catch (e) { fail(e); return null; }
}
function userMenu(btn) {
  const u = USERS.find(x => x.username === btn.dataset.u); if (!u) return;
  const minPw = ST.values.min_password_length || 6;
  openMenu(btn, [
    { label: 'Rename', act: async () => { const v = await dialog({ title: `Rename ${u.username}`, fields: [{ name: 'name', label: 'Display name', value: u.display_name }], ok: 'Save' }); if (v && await userAction(u.username, 'update', { display_name: v.name })) toast('Renamed'); } },
    { label: 'Reset password', act: async () => {
      const v = await dialog({ title: `New password for ${u.username}`, text: 'They will be signed out on every device.', fields: [{ name: 'pw', label: 'New password', type: 'password', autocomplete: 'new-password' }], ok: 'Set password', validate: x => x.pw.length < minPw ? `Use at least ${minPw} characters.` : '' });
      if (v && await userAction(u.username, 'password', { password: v.pw })) toast('Password changed');
    } },
    { label: 'Sign out everywhere', act: async () => { if (await userAction(u.username, 'signout')) toast(`Signed ${u.username} out`); } },
    u.avatar ? { label: 'Remove profile photo', act: async () => {
      if (!(await confirmDlg(`Remove ${u.username}'s photo?`, 'Their profile shows their initial instead. They can upload a new photo unless you turn off Profile photos under Features.', 'Remove photo', true))) return;
      if (await userAction(u.username, 'remove_avatar')) toast('Photo removed');
    } } : null,
    { label: u.is_admin ? 'Remove admin access' : 'Make admin', act: async () => {
      if (!u.is_admin && !(await confirmDlg(`Make ${u.username} an admin?`, 'Admins can sign in to this panel with their own username and password and change everything here.', 'Make admin'))) return;
      if (await userAction(u.username, 'update', { is_admin: !u.is_admin })) toast(u.is_admin ? 'Admin access removed' : `${u.username} is now an admin`);
    } },
    { label: u.disabled ? 'Enable account' : 'Disable account', act: async () => {
      if (!u.disabled && !(await confirmDlg(`Disable ${u.username}?`, "They'll be signed out and won't be able to sign in until you enable the account again. Their playlists and likes are kept.", 'Disable', true))) return;
      if (await userAction(u.username, 'update', { disabled: !u.disabled })) toast(u.disabled ? 'Account enabled' : 'Account disabled');
    } },
    '-',
    { label: 'Delete account', danger: true, act: async () => {
      if (!(await confirmDlg(`Delete ${u.username}?`, `This permanently removes the account with its ${plural(u.playlists, 'playlist')}, ${plural(u.liked, 'liked song')} and listening history.`, 'Delete account', true))) return;
      if (await userAction(u.username, 'delete')) toast('Account deleted');
    } },
  ].filter(Boolean));
}
async function newUser() {
  const minPw = ST.values.min_password_length || 6;
  const v = await dialog({ title: 'New account', ok: 'Create account', fields: [
    { name: 'username', label: 'Username', placeholder: 'e.g. alex', autocomplete: 'off' },
    { name: 'display_name', label: 'Display name (optional)' },
    { name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password' },
    { name: 'is_admin', label: 'Can use this admin panel', type: 'check' },
  ], validate: x => !/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(x.username.trim().toLowerCase()) ? 'Usernames are 2–32 characters: letters, numbers, dots, dashes or underscores.' : x.password.length < minPw ? `Use at least ${minPw} characters for the password.` : '' });
  if (!v) return;
  try { await api('/api/admin/v2/users', { ...v, username: v.username.trim().toLowerCase() }); toast(`Created ${v.username.trim().toLowerCase()}`); loadUsers(); }
  catch (e) { fail(e); }
}
let INVITES = [];
async function loadInvites() {
  const d = await api('/api/admin/v2/invites');
  INVITES = d.invites; drawInvites(d.registration);
}
function drawInvites(mode) {
  const hint = { open: "Sign-ups are open, so anyone can join without a code. Switch Sign-ups to 'Invite code required' above to make these necessary.",
    invite: 'Share a link or code. Each invite works until it runs out of uses or expires.',
    closed: "Sign-ups are closed, so invites won't work. Switch Sign-ups to 'Invite code required' to use them." }[mode] || '';
  $('#invite-hint').textContent = hint;
  const stateBadge = { active: 'ok', used: '', expired: 'warn', revoked: 'bad' };
  $('#invites-body').innerHTML = INVITES.length ? INVITES.map(i => `<tr>
    <td><div class="mono" style="font-weight:600">${esc(i.code)}</div>${i.note ? `<div class="dim" style="font-size:12.5px">${esc(i.note)}</div>` : ''}</td>
    <td class="muted">${nf(i.uses)} / ${i.max_uses ? nf(i.max_uses) : '∞'}${i.used_by && i.used_by.length ? `<div class="dim ell" style="font-size:12px;max-width:160px">${esc(i.used_by.join(', '))}</div>` : ''}</td>
    <td class="hide-sm muted">${i.expires ? new Date(i.expires * 1000).toLocaleDateString() : 'Never'}</td>
    <td><span class="badge ${stateBadge[i.state]}">${esc(i.state[0].toUpperCase() + i.state.slice(1))}</span></td>
    <td class="act">${i.state === 'active' ? `<button class="btn ghost sm" data-act="invite-copy" data-code="${esc(i.code)}">${ic('copy', 'sm')}Copy link</button> ` : ''}${i.state !== 'revoked' ? `<button class="icon-btn" data-act="invite-revoke" data-code="${esc(i.code)}" aria-label="Revoke">${ic('close')}</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No invites yet.</td></tr>';
}
async function newInvite() {
  const v = await dialog({ title: 'Create invite', ok: 'Create', fields: [
    { name: 'max_uses', label: 'Number of sign-ups', type: 'select', value: '1', options: [['1', '1 person'], ['5', '5 people'], ['10', '10 people'], ['25', '25 people'], ['0', 'Unlimited']] },
    { name: 'expires_days', label: 'Expires after', type: 'select', value: '7', options: [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['0', 'Never']] },
    { name: 'note', label: 'Note (optional)', placeholder: 'Who is it for?' },
  ] });
  if (!v) return;
  try {
    const d = await api('/api/admin/v2/invites', v);
    INVITES = d.invites; drawInvites(d.registration);
    copy(INVITES[0].link, 'Invite link copied');
  } catch (e) { fail(e); }
}

/* Library sharing between servers */
let FED = null;
async function pageSharing(el) {
  el.innerHTML = settingsCard('federation', { title: 'Library sharing', desc: 'Swap libraries with people who run their own Axdio server. Your listeners see the music they share next to yours, and theirs see yours. Songs play straight from the server that has them, and nothing is copied. Either side can stop at any time.' })
    + `<section class="card"><div class="card-h"><h2>Share your library</h2><button class="btn primary sm" data-act="fed-share">${ic('plus', 'sm')}Make a share key</button></div><p class="desc">Make a key for each server you share with, and send it to its admin privately. Anyone with the key can play your music, so stop sharing if it ends up somewhere it shouldn't.</p><p class="desc" id="fed-warn" hidden></p><div class="card-b flush list" id="fed-shares"></div></section>`
    + `<section class="card" id="fed-offers-card" hidden><div class="card-h"><h2>Offered to you</h2></div><p class="desc">These servers added your library and offered theirs back.</p><div class="card-b flush list" id="fed-offers"></div></section>`
    + `<section class="card"><div class="card-h"><h2>Libraries shared with you</h2><button class="btn ghost sm" data-act="fed-add">${ic('plus', 'sm')}Add a library</button></div><div class="card-b flush list" id="fed-remotes"></div></section>`;
  await loadFed();
  every(() => { if (!document.hidden && !$('.modal-back')) loadFed().catch(() => {}); }, 20000);
}
let fedQuick = 0;
async function loadFed(d) {
  FED = d || await api('/api/admin/v2/federation'); drawFed();
  // A library that was just added downloads its song list in the background; show it as soon as it's there.
  clearTimeout(fedQuick);
  if (FED.remotes.some(r => r.status === 'new') && $('#fed-remotes')) fedQuick = setTimeout(() => loadFed().catch(() => {}), 2000);
}
function drawFed() {
  const d = FED; if (!d || !$('#fed-shares')) return;
  const warn = $('#fed-warn');
  warn.hidden = d.public_url_set;
  warn.innerHTML = `<span class="badge warn">Public URL not set</span> Other servers reach yours at <span class="mono">${esc(d.self_url || location.origin)}</span>. If that isn't the address they can use, set a <a class="link" href="#/general">Public URL</a> first.`;
  const peerOf = s => s.peer_name ? `${esc(s.peer_name)}${s.peer_url ? ` · <span class="mono">${esc(s.peer_url.replace(/^https?:\/\//, ''))}</span>` : ''}` : '';
  const twoWay = url => url && d.shares.some(s => s.peer_url === url) && d.remotes.some(r => r.url === url && r.status !== 'revoked');
  $('#fed-shares').innerHTML = d.shares.length ? d.shares.map(s => `<div class="li"><div class="grow"><div class="t">${esc(s.label)}${twoWay(s.peer_url) ? ' <span class="badge info">Two-way</span>' : ''}</div><div class="s">${peerOf(s) ? `Used by ${peerOf(s)} · ` : ''}${s.last_seen ? `last used ${ago(s.last_seen)}` : 'Not used yet'} · made ${ago(s.created)}</div></div><button class="btn ghost sm" data-act="fed-unshare" data-id="${esc(s.id)}">Stop sharing</button></div>`).join('')
    : '<div class="li"><div class="grow muted">Your library isn\'t shared with any server.</div></div>';
  $('#fed-offers-card').hidden = !d.offers.length;
  $('#fed-offers').innerHTML = d.offers.map(o => `<div class="li"><div class="grow"><div class="t">${esc(o.name)}</div><div class="s"><span class="mono">${esc(o.url)}</span> · offered ${ago(o.created)}</div></div><button class="btn primary sm" data-act="fed-offer" data-id="${esc(o.id)}" data-a="accept">Add their library</button><button class="btn ghost sm" data-act="fed-offer" data-id="${esc(o.id)}" data-a="decline">No thanks</button></div>`).join('');
  const state = r => r.status === 'revoked' ? '<span class="badge bad">Stopped sharing</span>'
    : r.status === 'error' ? '<span class="badge warn">Can\'t reach</span>'
    : !r.enabled ? '<span class="badge">Hidden</span>'
    : r.status === 'ok' ? '<span class="badge ok">Connected</span>' : '<span class="badge">Connecting…</span>';
  $('#fed-remotes').innerHTML = d.remotes.length ? d.remotes.map(r => `<div class="li"><div class="grow"><div class="t">${esc(r.name)} ${state(r)}${twoWay(r.url) ? ' <span class="badge info">Two-way</span>' : ''}</div><div class="s"><span class="mono">${esc(r.url.replace(/^https?:\/\//, ''))}</span> · ${plural(r.tracks || 0, 'song')}${r.synced ? ` · updated ${ago(r.synced)}` : ''}</div>${r.error && r.status !== 'ok' ? `<div class="s" style="color:${r.status === 'revoked' ? '#f87171' : '#fbbf24'}">${esc(r.error)}</div>` : ''}</div>${r.status !== 'revoked' ? `<label class="toggle" title="${r.enabled ? 'Showing to listeners' : 'Hidden from listeners'}"><input type="checkbox" data-fed-show="${esc(r.id)}"${r.enabled ? ' checked' : ''} aria-label="Show ${esc(r.name)}'s music to listeners"><span></span></label>` : ''}<button class="icon-btn" data-act="fed-menu" data-id="${esc(r.id)}" aria-label="Actions for ${esc(r.name)}">${ic('more')}</button></div>`).join('')
    : '<div class="li"><div class="grow muted">No servers share their library with you yet. When an admin sends you a share code, add it here.</div></div>';
}
async function fedShare() {
  const v = await dialog({ title: 'Make a share key', ok: 'Make key', fields: [{ name: 'label', label: 'Who is it for?', placeholder: "e.g. Sam's server" }],
    validate: x => x.label.trim() ? '' : "Name the server or person, so you know which key to stop later." });
  if (!v) return;
  try {
    const d = await api('/api/admin/v2/federation/shares', { label: v.label.trim() });
    loadFed(d.view);
    await dialog({ title: `Share key for ${v.label.trim()}`, ok: 'Done', cancel: null,
      html: `<p>Send this code to their admin. They add it under <b>Library sharing › Add a library</b>. It's only shown this once.</p>
        <textarea class="textarea code" readonly rows="3" style="min-height:0;white-space:pre-wrap;word-break:break-all">${esc(d.code)}</textarea>
        <div class="row wrap" style="margin-top:10px"><button type="button" class="btn primary sm" data-act="copy-text" data-v="${esc(d.code)}">${ic('copy', 'sm')}Copy code</button></div>
        <details style="margin-top:14px"><summary class="muted" style="cursor:pointer">Address and key separately</summary><div class="stack" style="margin-top:10px"><div><div class="muted" style="font-size:12.5px">Address</div><div class="mono" style="user-select:all;word-break:break-all">${esc(d.url)}</div></div><div><div class="muted" style="font-size:12.5px">Key</div><div class="mono" style="user-select:all;word-break:break-all">${esc(d.key)}</div></div></div></details>` });
  } catch (e) { fail(e); }
}
async function fedAdd() {
  const v = await dialog({ title: 'Add a library', ok: 'Add library', html: '<p>Paste the share code another admin sent you, or their server address and key separated by a space.</p>',
    fields: [{ name: 'code', label: 'Share code', placeholder: 'axdio-share:…' }, { name: 'share_back', label: 'Share my library with them too', type: 'check', value: true }],
    validate: x => /^\s*axdio-share:\S+\s*$/.test(x.code) || /^\s*\S+\s+axs_\S+\s*$/.test(x.code) ? '' : 'That doesn\'t look like a share code. It starts with "axdio-share:".' });
  if (!v) return;
  const m = v.code.trim().match(/^(\S+)\s+(axs_\S+)$/);
  toast('Connecting…');
  try {
    const d = await api('/api/admin/v2/federation/remotes', m ? { url: m[1], key: m[2], share_back: v.share_back } : { code: v.code.trim(), share_back: v.share_back });
    loadFed(d.view);
    toast(d.message || 'Library added');
  } catch (e) { fail(e); }
}
function fedMenu(btn) {
  const r = FED && FED.remotes.find(x => x.id === btn.dataset.id); if (!r) return;
  openMenu(btn, [
    r.status !== 'revoked' ? { label: 'Check for changes now', act: () => { toast('Checking…'); api(`/api/admin/v2/federation/remotes/${r.id}`, { sync: true }).then(d => { loadFed(d); const n = d.remotes.find(x => x.id === r.id); toast(n && n.status === 'ok' ? 'Up to date' : (n && n.error) || 'Checked', n && n.status !== 'ok'); }, fail); } } : null,
    { label: 'Copy address', act: () => copy(r.url, 'Address copied') },
    '-',
    { label: 'Remove library', danger: true, act: async () => {
      if (!(await confirmDlg(`Remove ${r.name}'s library?`, `Its music disappears for your listeners, and playlists skip those songs. ${r.status === 'revoked' ? '' : `${r.name} is told, so their key for you stops working. `}To add it again you'll need a new share code.`, 'Remove', true))) return;
      api(`/api/admin/v2/federation/remotes/${r.id}`, undefined, 'DELETE').then(d => { loadFed(d); toast('Library removed'); }, fail);
    } },
  ].filter(Boolean));
}
document.addEventListener('change', e => {
  const t = e.target.closest('[data-fed-show]'); if (!t) return;
  api(`/api/admin/v2/federation/remotes/${t.dataset.fedShow}`, { enabled: t.checked }).then(d => { loadFed(d); toast(t.checked ? 'Showing to listeners' : 'Hidden from listeners'); }, e2 => { t.checked = !t.checked; fail(e2); });
});

/* Plugins: tools Axdio doesn't come with, which an admin can install */
let PLUG = null, plugTimer = 0;
async function pagePlugins(el) {
  el.innerHTML = `<section class="card"><div class="card-h"><h2>Plugins</h2><button class="btn ghost sm" data-act="plug-check">${ic('refresh', 'sm')}Check for updates</button></div>
    <p class="desc">Plugins aren't part of Axdio, and playing music doesn't need any of them. They're separate projects with their own code and licenses. Installing one downloads it onto this server, from GitHub or from PyPI, the Python package index. Check that using a plugin is allowed where you are.</p>
    <p class="desc" id="plug-checked" style="padding-bottom:18px"></p></section><div id="plug-list" class="stack"></div>`
    + settingsCard('plugins', { title: 'Updates' });
  await loadPlugins();
  if (!PLUG.checked || Date.now() / 1000 - PLUG.checked > 86400) api('/api/admin/v2/plugins/check', {}).then(d => loadPlugins(d), () => {});
  every(() => { if (!document.hidden && !$('.modal-back') && PLUG && PLUG.job.state !== 'running') loadPlugins().catch(() => {}); }, 30000);
}
async function loadPlugins(d) {
  const was = PLUG && PLUG.job.state;
  PLUG = d || await api('/api/admin/v2/plugins');
  drawPlugins();
  clearTimeout(plugTimer);
  if (PLUG.job.state === 'running') plugTimer = setTimeout(() => loadPlugins().catch(() => {}), 1500);
  else if (was === 'running') { if (PLUG.job.message) toast(PLUG.job.message, PLUG.job.state === 'error'); loadPluginPages().then(renderNav); }
}
function drawPlugins() {
  const d = PLUG, list = $('#plug-list'); if (!d || !list) return;
  const j = d.job, running = j.state === 'running';
  $('#plug-checked').textContent = d.checked ? `Last looked for new versions ${ago(d.checked)}.` : '';
  list.innerHTML = (d.downloader_moved ? `<section class="card"><div class="card-b"><span class="badge info">Moved</span> The downloader isn't part of Axdio any more. It's now the Downloader plugin below: install it to keep downloading. The tools you installed for it before are reused.</div></section>` : '') + d.plugins.map(p => {
    const mine = j.plugin === p.id && j.state !== 'idle' && (running || Date.now() / 1000 - j.started < 900);
    const dis = running ? ' disabled' : '';
    const state = p.installed ? `<span class="badge ok">Installed · ${esc(p.installed)}</span>` : '<span class="badge">Not installed</span>';
    const btns = running && j.plugin === p.id ? `<span class="muted" style="font-size:13px">${esc(j.message)}</span>`
      : p.installed ? `${p.update ? `<button class="btn primary sm" data-act="plug-do" data-id="${p.id}" data-a="update"${dis}>Update to ${esc(p.latest)}</button>` : ''}${p.part ? '' : `<button class="btn ghost sm" data-act="plug-do" data-id="${p.id}" data-a="remove"${dis || (p.needed_by.length ? ' disabled' : '')}${p.needed_by.length ? ` title="${esc(p.needed_by.join(' and '))} needs it"` : ''}>Remove</button>`}`
      : `<button class="btn primary sm" data-act="plug-do" data-id="${p.id}" data-a="install"${dis}>${ic('downloader', 'sm')}Install</button>`;
    const notes = [p.needs.length ? `Installing it also installs ${p.needs.join(' and ')}.` : '', p.needed_by.length && p.installed ? `${p.needed_by.join(' and ')} needs it.` : ''].filter(Boolean).join(' ');
    const sub = p.addon_of ? `<span class="sub">${p.part ? 'Comes with' : 'Add-on for'} ${esc(p.addon_of)}</span>` : '';
    return `<section class="card${p.addon_of ? ' plug-addon' : ''}"><div class="card-h"><h2>${esc(p.name)}</h2>${sub}${state}${p.update ? `<span class="badge info">${esc(p.latest)} available</span>` : ''}<div class="row" style="margin-left:auto">${btns}</div></div>
      <p class="desc">${esc(p.desc)}${notes ? ' ' + esc(notes) : ''}</p>
      <div class="card-b" style="padding-top:0">
        ${p.installed ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" data-plug-auto="${p.id}"${p.auto_update ? ' checked' : ''}${dis}> Keep it up to date automatically</label>` : ''}
        ${p.error ? `<p style="color:#f87171;margin-bottom:10px;font-size:13px">It's installed but couldn't be loaded: ${esc(p.error)}</p>` : ''}
        <div class="muted" style="font-size:12.5px">${esc(p.license)} license · from ${esc(p.source)} · <a class="link" href="${esc(p.home)}" target="_blank" rel="noopener">${esc(p.home.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a>${!p.installed && p.latest ? ` · newest version ${esc(p.latest)}` : ''}</div>
        ${mine && j.log.length ? `<div class="term" style="height:auto;max-height:220px;margin-top:14px">${j.log.map(termLine).join('')}</div>` : ''}
        ${mine && j.state === 'error' ? `<p style="color:#f87171;margin-top:10px;font-size:13px">${esc(j.message)}</p>` : ''}
      </div></section>`;
  }).join('');
  list.querySelectorAll('.term').forEach(t => { t.scrollTop = t.scrollHeight; });
}
document.addEventListener('change', e => {
  const t = e.target.closest('[data-plug-auto]'); if (!t) return;
  api(`/api/admin/v2/plugins/${t.dataset.plugAuto}`, { auto_update: t.checked }).then(d => { loadPlugins(d); toast(t.checked ? 'Automatic updates on' : 'Automatic updates off'); }, e2 => { t.checked = !t.checked; fail(e2); });
});

/* Updates: new versions of Axdio, installed from here when the container can reach Docker */
function mdLite(text) {
  return esc(text).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    return l.startsWith('- ') ? `<li>${l.slice(2)}</li>` : `<p>${l}</p>`;
  }).join('').replace(/(<li>.*?<\/li>)+/g, m => `<ul>${m}</ul>`);
}
const UPDATE_WHY = {
  'no-socket': "Axdio can't reach Docker, so it can tell you about new versions but not install them.",
  'no-permission': "The Docker socket is mounted, but the server isn't allowed to use it. Recreate the container so it starts with the new setting.",
  'no-docker': "The Docker socket is mounted, but Docker didn't answer.",
  'not-found': "Docker doesn't know this container (is the socket from another machine?).",
  'other-image': "This server wasn't installed from the published image (it was built from source), so it's updated the way it was built.",
  'dev': "This server runs code from a folder on the host (a development setup). Updating the image wouldn't change that code.",
  'no-config-volume': "The config folder isn't a volume, so settings wouldn't survive a new container.",
};
let UPD = null, updTimer = 0;
async function pageUpdates(el) {
  el.innerHTML = `<section class="card" id="upd-card"><div class="card-b"><p class="muted">Checking…</p></div></section><div id="upd-extra" class="stack"></div>` + settingsCard('updates', { title: 'Automatic updates' });
  await loadUpdates(false);
}
async function loadUpdates(check) {
  const was = UPD && UPD.job.state;
  try { UPD = await api('/api/admin/v2/updates' + (check ? '?check=1' : '')); }
  catch (e) { if (UPD && ['running', 'restarting'].includes(UPD.job.state)) return waitForRestart(); throw e; }
  ST.update = UPD.available ? UPD.latest : null; renderNav();
  drawUpdates();
  clearTimeout(updTimer);
  if (UPD.job.state === 'running') updTimer = setTimeout(() => loadUpdates(false).catch(() => waitForRestart()), 1500);
  else if (UPD.job.state === 'restarting') waitForRestart();
  else if (was === 'running' && UPD.job.state === 'error') toast(UPD.job.message, true);
}
async function waitForRestart() {
  const card = $('#upd-card'); if (!card) return;
  const from = UPD ? UPD.current : '';
  card.innerHTML = `<div class="card-b"><p><b>Restarting with the new version…</b></p><p class="muted">This page reloads when the server is back, usually within a minute or two.</p></div>`;
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60000) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (h.version && h.version !== from) { toast(`Updated to ${h.version}`); setTimeout(() => location.reload(), 800); return; }
      const u = await api('/api/admin/v2/updates').catch(() => null);
      if (u && u.job.state !== 'restarting' && u.last && u.last.state === 'failed') { UPD = u; drawUpdates(); return; }
    } catch (e) { /* still restarting */ }
  }
  card.innerHTML = `<div class="card-b"><p>The server hasn't come back yet. Check the container on the host (for example with <code>docker ps -a</code>).</p></div>`;
}
function drawUpdates() {
  const d = UPD, card = $('#upd-card'); if (!d || !card) return;
  const s = d.setup, busy = ['running', 'restarting'].includes(d.job.state);
  const head = d.available
    ? `<span class="badge info">Axdio ${esc(d.latest)} is available</span> This server runs ${esc(d.current)}.`
    : d.latest ? `<span class="badge ok">Up to date</span> Axdio ${esc(d.current)} is the newest version.` : `Axdio ${esc(d.current)}.`;
  const last = d.last && d.last.state === 'failed' ? `<p class="desc" style="color:#f87171">The last update didn't work: ${esc(d.last.message || '')}</p>`
    : d.last && d.last.state === 'done' && d.last.to === d.current ? `<p class="desc">Updated from ${esc(d.last.from)} to ${esc(d.last.to)} ${d.last.at ? ago(d.last.at) : ''}.</p>` : '';
  const btn = d.available && s.can_update ? `<button class="btn primary sm" data-act="upd-install"${busy ? ' disabled' : ''}>${ic('downloader', 'sm')}Update to ${esc(d.latest)}</button>` : '';
  card.innerHTML = `<div class="card-h"><h2>Axdio ${esc(d.current)}</h2><div class="row" style="margin-left:auto">${btn}<button class="btn ghost sm" data-act="upd-check"${busy ? ' disabled' : ''}>${ic('refresh', 'sm')}Check now</button></div></div>
    <p class="desc">${head}${d.checked ? ` <span class="muted">Checked ${ago(d.checked)}.</span>` : ''}</p>${d.error ? `<p class="desc" style="color:#fbbf24">${esc(d.error)}</p>` : ''}${last}
    ${busy || d.job.log.length ? `<div class="card-b" style="padding-top:0"><div class="term" style="height:auto;max-height:200px">${d.job.log.map(termLine).join('')}</div></div>` : ''}
    ${d.available && d.notes.length ? `<div class="card-b" style="padding-top:0"><div class="notes">${d.notes.map(n => `<h3>What's new in ${esc(n.version)}</h3>${n.notes ? mdLite(n.notes) : '<p class="muted">No notes for this version.</p>'}`).join('')}</div></div>` : ''}`;
  const extra = $('#upd-extra');
  if (s.can_update) { extra.innerHTML = ''; return; }
  const manual = `<pre class="code-block">docker compose pull\ndocker compose up -d</pre>`;
  extra.innerHTML = `<section class="card"><div class="card-h"><h2>Installing updates</h2></div><p class="desc">${esc(UPDATE_WHY[s.reason] || 'Updates can\'t be installed from here.')}</p>
    ${s.reason === 'no-socket' || s.reason === 'no-permission' ? `<div class="card-b" style="padding-top:0"><p>To install updates from this page, give Axdio access to Docker. In <code>docker-compose.yml</code>, add this line under <code>volumes:</code>, then run <code>docker compose up -d</code> once:</p>
      <pre class="code-block">      - /var/run/docker.sock:/var/run/docker.sock</pre>
      <p class="muted" style="font-size:12.5px">This lets Axdio control Docker on this machine (which it needs in order to replace its own container). Leave it out if other people's containers run here and you'd rather update by hand.</p></div>` : ''}
    <div class="card-b" style="padding-top:0"><p>${s.reason === 'other-image' || s.reason === 'dev' ? 'To update, rebuild it: <code>git pull</code> and <code>docker compose up -d --build</code>.' : 'To update by hand, run these in the folder with <code>docker-compose.yml</code>:'}</p>${s.reason === 'other-image' || s.reason === 'dev' ? '' : manual}</div></section>`;
}

/* Security: schema fields + admin credentials */
function pageSecurity(el) {
  el.innerHTML = settingsCard('security', { title: 'Connections & logins' })
    + `<section class="card"><div class="card-h"><h2>Admin account</h2></div><p class="desc">The built-in admin account. People you make admins in <a class="link" href="#/access">Accounts</a> sign in with their own passwords.</p>
      <form class="fields" id="admin-form" autocomplete="off">
        <div class="field"><div><div class="lab">Username</div></div><div class="ctl"><input class="input" name="username" value="${esc(ST.me.admin_user || '')}" autocomplete="username"></div></div>
        <div class="field"><div><div class="lab">New password</div><div class="help">Leave empty to keep the current one. At least 8 characters.</div></div><div class="ctl"><input class="input" name="new_password" type="password" autocomplete="new-password"></div></div>
        <div class="field"><div><div class="lab">Current password</div><div class="help">Required to change either.</div></div><div class="ctl"><input class="input" name="current_password" type="password" autocomplete="current-password"><div class="row"><button class="btn primary sm" type="submit">Update admin account</button></div></div></div>
      </form></section>
    <section class="card"><div class="card-h"><h2>Two-factor sign-in</h2><span class="badge" id="tfa-badge"></span></div>
      <p class="desc">After your password, ask for a code from an authenticator app (Aegis, Google Authenticator, 1Password, Bitwarden…) when signing in to this panel. Applies to the account you're signed in with.</p>
      <div class="card-b" id="tfa-body"><span class="muted">Loading…</span></div></section>`;
  drawTfa();
  $('#admin-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, body = { username: f.username.value.trim(), new_password: f.new_password.value, current_password: f.current_password.value };
    try { await api('/api/admin/v2/admin_account', body); toast('Admin account updated'); f.new_password.value = f.current_password.value = ''; ST.me.admin_user = body.username; $('#nav-user').textContent = body.username; }
    catch (err) { fail(err); }
  });
}

async function drawTfa(setup) {
  const body = $('#tfa-body'); if (!body) return;
  const d = await api('/api/admin/v2/2fa').catch(e => ({ error: e.message }));
  $('#tfa-badge').className = 'badge ' + (d.enabled ? 'ok' : '');
  $('#tfa-badge').textContent = d.enabled ? 'On' : 'Off';
  if (setup) {
    body.innerHTML = `<ol class="muted" style="padding-left:18px;display:flex;flex-direction:column;gap:10px;font-size:13.5px">
      <li>In your authenticator app, add an account with this key${/Android|iPhone|iPad/.test(navigator.userAgent) ? ` (or <a class="link" href="${esc(setup.uri)}">open it in the app</a>)` : ''}:<div class="mono" style="font-size:16px;color:var(--text);margin-top:6px;letter-spacing:.08em">${esc(setup.secret.match(/.{1,4}/g).join(' '))}</div></li>
      <li>Enter the 6-digit code it shows:</li></ol>
      <form class="row" id="tfa-form" style="margin-top:10px"><input class="input mono" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="max-width:160px"><button class="btn primary sm">Turn on</button><button class="btn ghost sm" type="button" data-act="tfa-cancel">Cancel</button></form>`;
    $('#tfa-form').addEventListener('submit', async e => {
      e.preventDefault();
      try { await api('/api/admin/v2/2fa', { action: 'confirm', code: e.target.code.value }); toast('Two-factor sign-in is on'); drawTfa(); }
      catch (err) { fail(err); }
    });
    return;
  }
  body.innerHTML = d.enabled
    ? `<div class="row wrap"><span class="muted grow">Signing in as <b>${esc(d.who)}</b> asks for a code.</span><button class="btn danger sm" data-act="tfa-off">Turn off</button></div>`
    : `<div class="row wrap"><span class="muted grow">Off for <b>${esc(d.who || '')}</b>.</span><button class="btn primary sm" data-act="tfa-on">Set up</button></div>`;
}

/* Notifications */
function pageNotifications(el) {
  el.innerHTML = `<p class="page-intro">Get a message when something happens on the server.</p>`
    + settingsCard('notifications', { title: 'Where and when', extra: `<button class="btn ghost sm" data-act="notify-test">Send a test</button>` });
}

/* Log lines in the job terminals (the audit, plugins, and pages from plugins) */
const TAG_CLASS = [
  [/\[(ACCEPT|SAVED|REPLACED|FINISH|FIXED|RESTORED|OK|FOUND)\]/g, 'c-ok'], [/\[(SKIP|SKIPPED|FLAGGED|FILTER|PAUSED|STOPPED|VERIFY|UNVERIFIED|TAGS_WRONG|WRONG_VERSION|UNCERTAIN|WARN|KEEP)\]/g, 'c-warn'],
  [/\[((?:FATAL )?ERR(?:OR)?|MISMATCH|FAILED)\]/g, 'c-bad'], [/\[(INIT|FIX|PROGRESS|RESUMED|INFO|CHECK|IDENTIFY|CLEANED|RE-READ)\]/g, 'c-info'], [/\[(DISCOVERY)\]/g, 'c-vio'],
  [/\[(CONFIG|REJECT|download|ExtractAudio)\]/g, 'c-dim'],
];
function termLine(line) {
  let s = esc(line);
  TAG_CLASS.forEach(([re, cls]) => { s = s.replace(re, `<span class="${cls}">$&</span>`); });
  return `<span class="ln">${s}</span>`;
}
function fillTerm(term, lines) {
  const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  term.innerHTML = lines.map(termLine).join('');
  if (atBottom) term.scrollTop = term.scrollHeight;
}
/* Duplicates */
function pageDuplicates(el) {
  el.innerHTML = `<section class="card"><div class="card-h"><h2>Find duplicates</h2><span class="badge" id="dp-badge">Idle</span></div>
      <p class="desc">Finds songs you have more than once, in the same folder or different ones. Two files count as the same only when the audio says so: the same title and artist, the same length, and fingerprints that match closely. Remixes, live takes and clean or radio edits aren't duplicates. Of each set, the copy with the most complete tags stays (a lossless copy always beats a lossy one) and gets whatever tags, cover or lyrics it was missing from the others. The others go to quarantine under Library audit, where they can be restored, and likes, playlists and history move to the copy that stays. If that copy isn't in its album's folder and another one was, it moves there.</p>
      <div class="card-b">${scopeHtml('dups')}
        <div class="row wrap" style="margin-top:12px"><button class="btn primary" id="dp-start">Find duplicates</button><button class="btn danger" id="dp-stop" disabled>Stop</button><label class="check"><input type="checkbox" id="dp-auto"> Remove them as soon as they're confirmed</label></div>
        <div class="progress"><i id="dp-bar"></i></div><div class="muted" id="dp-progress" style="font-size:13px">Checking a big library takes a while: every song that shares a title with another is fingerprinted.</div>
        <div class="term" id="dp-term" style="margin-top:14px;height:180px"><span class="ln c-dim">Ready.</span></div></div></section>
    <section class="card" id="dp-res" hidden><div class="card-h"><h2>Duplicates found</h2><button class="btn primary sm" id="dp-all">Remove all duplicates</button></div><div id="dp-list" class="stack" style="padding:0 20px 20px"></div></section>`;
  let seen = '';
  const fmt = c => `${esc(c.format)}${c.lossless ? ' · lossless' : c.bitrate ? ` · ${c.bitrate} kbps` : ''}`;
  const poll = async () => {
    const d = await api('/api/admin/dups/status').catch(() => null); if (!d || !$('#dp-term')) return;
    const busy = d.status === 'running';
    $('#dp-start').disabled = busy; $('#dp-stop').disabled = !busy;
    $('#dp-badge').textContent = busy ? 'Running' : d.status[0].toUpperCase() + d.status.slice(1);
    $('#dp-badge').className = 'badge ' + (busy ? 'ok' : '');
    $('#dp-bar').style.width = d.total ? Math.round(100 * d.scanned / d.total) + '%' : (busy ? '5%' : '0');
    if (d.started_at) $('#dp-progress').textContent = `${d.total ? `${nf(d.scanned)} of ${plural(d.total, 'file')} fingerprinted` : 'Looking for titles that appear more than once…'} in ${d.scope} · ${plural(d.groups.length, 'set')} found${d.removed ? ` · ${nf(d.removed)} removed` : ''}`;
    if (d.logs && d.logs.length) fillTerm($('#dp-term'), d.logs);
    const key = JSON.stringify(d.groups.map(g => [g.id, g.state]));
    if (key === seen) return;
    seen = key;
    $('#dp-res').hidden = !d.groups.length;
    $('#dp-all').hidden = !d.groups.some(g => g.state === 'found');
    $('#dp-list').innerHTML = d.groups.map(g => `<div class="dup${g.state !== 'found' ? ' done' : ''}">
      ${g.copies.map(c => `<div class="dup-row"><span class="badge ${c.role === 'keep' ? 'ok' : 'warn'}">${c.role === 'keep' ? 'Keep' : 'Remove'}</span>
        <div class="grow"><div class="mono" style="font-size:12.5px;word-break:break-all">${esc(c.rel)}</div>
        <div class="muted" style="font-size:12.5px">${esc(c.title || '—')}${c.artist ? ' · ' + esc(c.artist) : ''}${c.album ? ' · ' + esc(c.album) : ''} · ${fmt(c)}${c.missing.length ? ` · missing ${esc(c.missing.join(', '))}` : ' · complete tags'}${c.lyrics ? ' · lyrics' : ''}</div></div></div>`).join('')}
      ${g.move_to ? `<div class="muted" style="font-size:12.5px;margin-top:6px">The copy that stays moves to its album: ${esc(g.move_to)}/${esc(g.move_as || '')}</div>` : ''}
      <div class="row" style="margin-top:10px">${g.state === 'found' ? `<button class="btn primary sm" data-dp="resolve" data-id="${g.id}">Remove ${g.copies.length > 2 ? 'duplicates' : 'duplicate'}</button><button class="btn ghost sm" data-dp="ignore" data-id="${g.id}">Not duplicates</button>`
        : g.state === 'resolved' ? `<span class="badge ok">Done</span><span class="muted" style="font-size:12.5px">Kept ${esc(g.final || g.keep)}</span>` : g.state === 'ignored' ? '<span class="badge">Left alone</span>' : `<span class="badge bad">Error</span><span class="muted" style="font-size:12.5px">${esc(g.error || '')}</span>`}</div></div>`).join('');
  };
  try { $('#dp-auto').checked = localStorage.getItem('axdio-dp-auto') === '1'; } catch (e) { /* storage unavailable */ }
  $('#dp-auto').onchange = e => { try { localStorage.setItem('axdio-dp-auto', e.target.checked ? '1' : '0'); } catch (x) { /* ignore */ } };
  $('#dp-start').onclick = () => api('/api/admin/dups/start', Object.assign(scopeBody('dups'), { auto: $('#dp-auto').checked })).then(poll, fail);
  $('#dp-stop').onclick = () => api('/api/admin/dups/stop', {}).then(poll, fail);
  $('#dp-all').onclick = async () => {
    if (!(await confirmDlg('Remove every duplicate?', 'Of each set, the copy shown as Keep stays. The others go to quarantine, where they can be restored.', 'Remove all'))) return;
    api('/api/admin/dups/resolve', { all: true }).then(r => { toast(`Removed ${plural(r.removed, 'duplicate')}`); poll(); }, fail);
  };
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-dp]'); if (!b) return;
    b.disabled = true;
    api('/api/admin/dups/' + b.dataset.dp, { id: b.dataset.id }).then(() => { toast(b.dataset.dp === 'resolve' ? 'Removed; the copy that stays has everything' : 'Left alone, and left out of later searches'); poll(); }, err => { b.disabled = false; fail(err); });
  });
  drawScope('dups'); poll();
  every(poll, 2000);
}

/* Library audit (existing /api/admin/audit endpoints) */
const AUDIT_LABELS = { ok: 'Verified', mismatch: 'Wrong audio', tags_wrong: 'Wrong tags', wrong_version: 'Wrong cut', uncertain: 'Uncertain', unverified: 'Unverifiable', fixed: 'Repaired', ignored: 'Ignored', error: 'Errors' };
const AUDIT_ORDER = ['ok', 'mismatch', 'tags_wrong', 'wrong_version', 'uncertain', 'unverified', 'fixed', 'error'];
const encArg = v => encodeURIComponent(v);
function fmtSecs(s) { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; }
function pageAudit(el) {
  el.innerHTML = `<section class="card"><div class="card-h"><h2>Check the library</h2><span class="badge" id="au-badge">Idle</span></div>
    <p class="desc">Fingerprints each song and compares it with the Deezer/iTunes preview of the song its tags name. Wrong tags can be rewritten from the song the audio really is. With the Downloader plugin, wrong audio can also be replaced by a verified download at the same path, so likes and playlists keep working. Replaced originals go to quarantine and can be restored.</p>
    <div class="card-b">
      ${scopeHtml('audit')}
      <div class="row wrap" style="margin-top:12px">
        <select class="select" id="au-workers" style="width:auto" aria-label="Parallel reads"><option value="1">1 worker</option><option value="2">2 workers</option><option value="3" selected>3 workers</option><option value="4">4 workers</option></select>
        <button class="btn primary" id="au-start">Start audit</button><button class="btn danger" id="au-stop" disabled>Stop</button></div>
      <div class="row wrap" style="margin-top:12px;gap:18px"><label class="check"><input type="checkbox" id="au-fix"> Repair confirmed problems automatically</label><label class="check"><input type="checkbox" id="au-recheck"> Re-check songs that were already audited</label></div>
      <div class="progress"><i id="au-bar"></i></div><div class="muted" id="au-progress" style="font-size:13px">No audit has run since the server started.</div>
      <div class="audit-totals" id="au-totals"></div>
      <div class="term" id="au-term" style="margin-top:14px;height:220px"><span class="ln c-dim">A first pass reads every file from storage, so expect several hours for a large library. Results are saved as it goes; later runs only check new or changed files.</span></div>
    </div></section>
    <section class="card"><div class="card-h"><h2>Flagged songs</h2><select class="select" id="au-filter" style="width:auto" aria-label="Show">
      <option value="mismatch,tags_wrong,wrong_version,uncertain">Needs attention</option><option value="mismatch">Wrong audio</option><option value="tags_wrong">Wrong tags</option><option value="wrong_version">Wrong cut</option><option value="uncertain">Uncertain</option><option value="unverified">Unverifiable</option><option value="fixed">Repaired</option><option value="ignored">Ignored</option><option value="error">Errors</option></select>
      <input class="input" id="au-q" placeholder="Filter by path" style="max-width:180px"><button class="btn ghost sm" id="au-fixall">Repair all confirmed</button></div>
      <p class="desc" id="au-note"></p><div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>Song</th><th>Problem</th><th>Evidence</th><th></th></tr></thead><tbody id="au-body"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div></div></section>
    <section class="card"><div class="card-h"><h2>Quarantine</h2><button class="btn danger sm" id="qu-purge">Delete all</button></div><p class="desc">Originals of repaired songs (config/quarantine). Restoring puts the original back and marks the song as ignored.</p>
      <div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>When</th><th>Song</th><th>Repair</th><th></th></tr></thead><tbody id="qu-body"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div></div></section>`;
  let wasBusy = false;
  const status = async () => {
    const d = await api('/api/admin/audit/status').catch(() => null); if (!d || !$('#au-badge')) return;
    const running = d.status === 'running', busy = running || !!d.fixing || d.fix_queue > 0;
    $('#au-start').disabled = running; $('#au-stop').disabled = !busy;
    const badge = $('#au-badge');
    badge.textContent = d.fixing && !running ? 'Repairing' : d.status[0].toUpperCase() + d.status.slice(1);
    badge.className = 'badge ' + (busy ? 'ok' : d.status === 'error' ? 'bad' : '');
    const pct = d.total ? Math.round(100 * d.scanned / d.total) : 0;
    $('#au-bar').style.width = pct + '%';
    let line = d.total ? `${nf(d.scanned)} of ${nf(d.total)} checked (${pct}%) · ${nf(d.cached)} from earlier runs` : 'No audit has run since the server started.';
    const fresh = d.scanned - d.cached;
    if (running && fresh > 3 && d.started_at) { const rate = fresh / (Date.now() / 1000 - d.started_at); if (rate > 0) line += ` · about ${fmtSecs((d.total - d.scanned) / rate)} left`; }
    if (d.fixing) line += ` · repairing ${d.fixing}` + (d.fix_queue ? ` (+${d.fix_queue} queued)` : '');
    $('#au-progress').textContent = line;
    const t = d.library_totals || {};
    $('#au-totals').innerHTML = AUDIT_ORDER.map(k => `<button data-act="au-show" data-k="${k}"><div class="k">${AUDIT_LABELS[k]}</div><div class="v st-${k}">${nf(t[k])}</div></button>`).join('');
    if (d.logs && d.logs.length) fillTerm($('#au-term'), d.logs);
    if (wasBusy && !busy) { results(); quarantine(); }
    wasBusy = busy;
  };
  const evidence = r => {
    const out = [esc(r.reason || '')], ref = r.ref;
    if (ref && ref.source === 'deezer' && ref.id) out.push(`<a href="https://www.deezer.com/track/${encodeURIComponent(ref.id)}" target="_blank" rel="noopener">Catalog: ${esc(ref.artist)} – ${esc(ref.title)}</a>`);
    if (r.source_id) out.push(`<a href="https://www.youtube.com/watch?v=${encodeURIComponent(r.source_id)}" target="_blank" rel="noopener">Downloaded from YouTube</a>`);
    if (r.fix && r.fix.source) out.push(`<a href="${esc(r.fix.source)}" target="_blank" rel="noopener">New source</a>`);
    if (r.fix_error) out.push(`<span class="st-error">Repair failed: ${esc(r.fix_error)}</span>`);
    return out.filter(Boolean).join('<br>');
  };
  const actions = r => {
    const rel = encArg(r.rel_path), out = [];
    if (['mismatch', 'wrong_version', 'uncertain'].includes(r.status)) out.push(`<button class="btn ghost sm" data-act="au-fix" data-rel="${rel}">Replace audio</button>`);
    if (r.status === 'tags_wrong') out.push(`<button class="btn ghost sm" data-act="au-fix" data-rel="${rel}">Fix tags</button>`);
    if (['mismatch', 'wrong_version', 'uncertain', 'tags_wrong', 'unverified', 'error'].includes(r.status)) out.push(`<button class="btn ghost sm" data-act="au-ignore" data-rel="${rel}">Ignore</button>`);
    return `<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">${out.join('')}</div>`;
  };
  const results = async () => {
    const body = $('#au-body'); if (!body) return;
    try {
      const d = await api(`/api/admin/audit/results?status=${encodeURIComponent($('#au-filter').value)}&q=${encodeURIComponent($('#au-q').value.trim())}`);
      $('#au-note').textContent = d.total > d.items.length ? `Showing ${nf(d.items.length)} of ${nf(d.total)}.` : '';
      body.innerHTML = d.items.length ? d.items.map(r => `<tr><td style="min-width:220px"><b>${r.label ? `${esc(r.label.artist)} – ${esc(r.label.title)}` : esc(r.rel_path.split('/').pop())}</b><div class="path"><a class="link" href="/api/stream_path?path=${encodeURIComponent(r.rel_path)}" target="_blank" rel="noopener" title="Listen">▶</a> ${esc(r.rel_path)}</div></td>
        <td><b class="st-${esc(r.status)}">${esc(AUDIT_LABELS[r.status] || r.status)}</b>${r.status === 'mismatch' ? `<div class="dim" style="font-size:12px">${r.confidence === 'high' ? 'confirmed' : 'needs review'}</div>` : ''}</td>
        <td class="evidence" style="min-width:240px">${evidence(r)}</td><td class="act">${actions(r)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Nothing here.</td></tr>';
    } catch (e) { body.innerHTML = `<tr><td colspan="4" class="empty">Couldn't load results: ${esc(e.message)}</td></tr>`; }
  };
  const quarantine = async () => {
    const body = $('#qu-body'); if (!body) return;
    try {
      const d = await api('/api/admin/audit/quarantine');
      body.innerHTML = d.items.length ? d.items.map(i => `<tr><td class="muted" style="white-space:nowrap">${fmtTime(i.at)}</td><td><div class="path" style="color:var(--text)">${esc(i.rel_path)}</div><div class="evidence">${esc(i.reason || '')}</div></td>
        <td>${i.kind === 'tags' ? 'Tags rewritten' : 'Audio replaced'}${i.exists ? '' : '<div class="st-error" style="font-size:12px">file missing</div>'}</td>
        <td class="act"><button class="btn ghost sm" data-act="qu-restore" data-id="${encArg(i.id)}"${i.exists ? '' : ' disabled'}>Restore</button> <button class="icon-btn" data-act="qu-delete" data-id="${encArg(i.id)}" aria-label="Delete">${ic('close')}</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">Empty.</td></tr>';
    } catch (e) { body.innerHTML = `<tr><td colspan="4" class="empty">Couldn't load quarantine.</td></tr>`; }
  };
  $('#au-start').onclick = async () => {
    try { await api('/api/admin/audit/start', Object.assign(scopeBody('audit'), { workers: +$('#au-workers').value, auto_fix: $('#au-fix').checked, recheck: $('#au-recheck').checked })); status(); }
    catch (e) { fail(e); }
  };
  $('#au-stop').onclick = () => api('/api/admin/audit/stop', {}).then(status, fail);
  drawScope('audit');
  $('#au-filter').onchange = results;
  let qt; $('#au-q').oninput = () => { clearTimeout(qt); qt = setTimeout(results, 300); };
  $('#au-fixall').onclick = async () => {
    if (!(await confirmDlg('Repair every confirmed problem?', 'Wrong tags are rewritten, and wrong audio is replaced if the Downloader plugin is installed. Originals go to quarantine.', 'Repair all'))) return;
    api('/api/admin/audit/fix', { all: true }).then(status, fail);
  };
  $('#qu-purge').onclick = async () => {
    if (!(await confirmDlg('Delete all quarantined originals?', 'They are removed from disk permanently.', 'Delete all', true))) return;
    api('/api/admin/audit/purge', {}).then(quarantine, fail);
  };
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'au-show') { const sel = $('#au-filter'); if ([...sel.options].some(o => o.value === b.dataset.k)) { sel.value = b.dataset.k; results(); sel.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
    else if (act === 'au-fix') api('/api/admin/audit/fix', { rel_paths: [decodeURIComponent(b.dataset.rel)] }).then(status, fail);
    else if (act === 'au-ignore') { await api('/api/admin/audit/ignore', { rel_path: decodeURIComponent(b.dataset.rel) }).catch(fail); results(); status(); }
    else if (act === 'qu-restore') {
      if (!(await confirmDlg('Put the original back?', 'The song will be marked as ignored by future audits.', 'Restore'))) return;
      await api('/api/admin/audit/restore', { id: decodeURIComponent(b.dataset.id) }).catch(fail); quarantine(); results(); status();
    } else if (act === 'qu-delete') {
      if (!(await confirmDlg('Delete this original?', 'It is removed from disk permanently.', 'Delete', true))) return;
      await api('/api/admin/audit/purge', { id: decodeURIComponent(b.dataset.id) }).catch(fail); quarantine();
    }
  });
  status(); results(); quarantine();
  every(status, 2500);
}

/* Metadata & lyrics (existing scrape endpoints) */
const FIX_LABELS = { fixed: ['Fixed', 'ok'], cleaned: ['Cleaned up', 'info'], refreshed: ['Re-read', 'info'], flagged: ['Check the audio', 'warn'], skipped: ['Skipped', ''], error: ['Error', 'bad'], undone: ['Undone', ''] };
function pageMetadata(el) {
  el.innerHTML = `<section class="card"><div class="card-h"><h2>Titles & tags</h2><span class="badge" id="tf-badge">Idle</span></div>
      <p class="desc">Cleans up titles: an artist's name in front of the title ("NERO - 2808" by NERO), track numbers and video IDs from file names, and labels like "(Official Video)". Songs without tags get their title and artist from the file name and folder. Then each song is looked up, and when its fingerprint confirms the match, its title and artists are written as the catalog has them, with a missing album, track number, date and cover filled in. Every change can be undone below.</p>
      <div class="card-b">${scopeHtml('tagfix')}
        <div class="row wrap" style="margin-top:12px"><button class="btn primary" id="tf-start">Fix titles & tags</button><button class="btn danger" id="tf-stop" disabled>Stop</button><label class="check"><input type="checkbox" id="tf-quick"> Only clean up titles (faster, no lookups)</label></div>
        <div class="progress"><i id="tf-bar"></i></div><div class="muted" id="tf-progress" style="font-size:13px">Choose folders or artists, or fix the whole library. The Files page can also fix a single folder or song.</div>
        <div class="term" id="tf-term" style="margin-top:14px;height:200px"><span class="ln c-dim">Ready.</span></div></div></section>
    <section class="card" id="tf-res" hidden><div class="card-h"><h2>Changes</h2><button class="btn ghost sm" id="tf-undo-all">Undo all</button></div>
      <div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>Song</th><th>Before</th><th>After</th><th></th></tr></thead><tbody id="tf-body"></tbody></table></div></div></section>
    <section class="card"><div class="card-h"><h2>Metadata & artwork</h2><span class="badge" id="art-badge">Idle</span></div>
      <p class="desc">Fills in missing albums, track numbers and cover art from the catalog entry of the same song, matched by ISRC or by exact title and artist plus an audio fingerprint check. It never renames a song. Songs whose audio doesn't match their tags are left alone and listed under Library audit.</p>
      <div class="card-b">${scopeHtml('meta')}<div class="row wrap" style="margin-top:12px"><button class="btn primary" id="art-start">Fix missing metadata & artwork</button><label class="check"><input type="checkbox" id="art-force"> Also replace low-resolution covers (under 40 KB)</label></div>
      <div class="term" id="art-term" style="margin-top:14px;height:240px"><span class="ln c-dim">Ready.</span></div></div></section>
    <section class="card"><div class="card-h"><h2>Synced lyrics</h2><span class="badge" id="lrc-badge">Idle</span></div>
      <p class="desc">Finds songs without synced lyrics, looks them up on LRCLIB and saves .lrc files next to the audio.</p>
      <div class="card-b"><div class="row wrap"><button class="btn primary" id="lrc-start">Fetch missing lyrics</button><button class="btn ghost" id="lrc-clear">Clear lyrics cache</button></div>
      <div class="term" id="lrc-term" style="margin-top:14px;height:240px"><span class="ln c-dim">Ready.</span></div></div></section>`;
  const pollArt = async () => {
    const d = await api('/api/admin/scrape_status').catch(() => null); if (!d || !$('#art-term')) return;
    const busy = d.status === 'scraping';
    $('#art-start').disabled = busy;
    $('#art-badge').textContent = busy ? 'Running' : (d.status || 'idle')[0].toUpperCase() + (d.status || 'idle').slice(1);
    $('#art-badge').className = 'badge ' + (busy ? 'ok' : '');
    if (d.logs && d.logs.length) fillTerm($('#art-term'), (d.total ? [`[PROGRESS] ${nf(d.scanned)} of ${nf(d.total)} checked · ${nf(d.scraped)} updated`] : []).concat(d.logs));
  };
  const pollLrc = async () => {
    const d = await api('/api/admin/lyrics_status').catch(() => null); if (!d || !$('#lrc-term')) return;
    const busy = d.status === 'scraping';
    $('#lrc-start').disabled = busy;
    $('#lrc-badge').textContent = busy ? 'Running' : (d.status || 'idle')[0].toUpperCase() + (d.status || 'idle').slice(1);
    $('#lrc-badge').className = 'badge ' + (busy ? 'ok' : '');
    if (d.logs && d.logs.length) fillTerm($('#lrc-term'), d.logs);
  };
  $('#art-start').onclick = () => api('/api/admin/scrape_art', Object.assign(scopeBody('meta'), { force: $('#art-force').checked })).then(pollArt, e => { if (!/already/i.test(e.message)) fail(e); pollArt(); });
  let tfSeen = '';
  const pollFix = async () => {
    const d = await api('/api/admin/tagfix/status').catch(() => null); if (!d || !$('#tf-term')) return;
    const busy = d.status === 'running';
    $('#tf-start').disabled = busy; $('#tf-stop').disabled = !busy;
    $('#tf-badge').textContent = busy ? 'Running' : d.status[0].toUpperCase() + d.status.slice(1);
    $('#tf-badge').className = 'badge ' + (busy ? 'ok' : '');
    const pct = d.total ? Math.round(100 * d.scanned / d.total) : 0;
    $('#tf-bar').style.width = pct + '%';
    if (d.total) $('#tf-progress').textContent = `${nf(d.scanned)} of ${plural(d.total, 'song')} checked in ${d.scope} · ${nf(d.changed)} changed`;
    if (d.logs && d.logs.length) fillTerm($('#tf-term'), d.logs);
    const key = JSON.stringify(d.results.map(r => [r.rel, r.result]));
    if (key === tfSeen) return;
    tfSeen = key;
    $('#tf-res').hidden = !d.results.length;
    $('#tf-undo-all').hidden = !d.results.some(r => r.id && (r.result === 'fixed' || r.result === 'cleaned'));
    const who = x => x ? `<div class="t">${esc(x.title || '—')}</div><div class="s muted">${esc(x.artist || '')}</div>` : '';
    $('#tf-body').innerHTML = d.results.map(r => { const [label, cls] = FIX_LABELS[r.result] || [r.result, '']; return `<tr>
      <td><div class="mono" style="font-size:12px;word-break:break-all">${esc(r.rel)}</div><span class="badge ${cls}" style="margin-top:6px">${esc(label)}</span></td>
      <td>${who(r.before)}</td><td>${r.after ? who(r.after) + `<div class="s muted" style="font-size:12px;margin-top:4px">${esc(r.how || '')}${(r.changed || []).filter(k => k !== 'title' && k !== 'artists').length ? ` · filled ${esc(r.changed.filter(k => k !== 'title' && k !== 'artists').join(', '))}` : ''}</div>` : `<div class="s muted">${esc(r.why || '')}</div>`}</td>
      <td class="act">${r.id && (r.result === 'fixed' || r.result === 'cleaned') ? `<button class="btn ghost sm" data-tf-undo="${esc(r.id)}">Undo</button>` : ''}</td></tr>`; }).join('');
  };
  $('#tf-start').onclick = async () => {
    const quick = $('#tf-quick').checked, s = scopeBody('tagfix');
    if (!s.paths.length && !s.artists.length && !(await confirmDlg('Fix the whole library?', quick ? 'Every title is cleaned up. Changes can be undone.' : 'Every song is looked up and fingerprinted, which takes hours on a big library. Changes can be undone.', 'Fix everything'))) return;
    api('/api/admin/tagfix/start', Object.assign(s, { quick })).then(pollFix, fail);
  };
  $('#tf-stop').onclick = () => api('/api/admin/tagfix/stop', {}).then(pollFix, fail);
  $('#tf-undo-all').onclick = async () => {
    if (!(await confirmDlg('Undo every change?', 'The songs get back the titles and tags they had before. Covers that were added stay.', 'Undo all'))) return;
    api('/api/admin/tagfix/undo', { all: true }).then(r => { toast(`Undid ${plural(r.undone, 'change')}`); pollFix(); }, fail);
  };
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-tf-undo]'); if (!b) return;
    b.disabled = true;
    api('/api/admin/tagfix/undo', { id: b.dataset.tfUndo }).then(() => { toast('Undone'); pollFix(); }, err => { b.disabled = false; fail(err); });
  });
  drawScope('tagfix'); drawScope('meta'); pollFix();
  $('#lrc-start').onclick = () => api('/api/admin/scrape_lyrics', {}).then(pollLrc, e => { if (!/already/i.test(e.message)) fail(e); pollLrc(); });
  $('#lrc-clear').onclick = async () => {
    if (!(await confirmDlg('Clear the lyrics cache?', 'Lyrics are looked up again the next time each song plays. Saved .lrc files are kept.', 'Clear'))) return;
    api('/api/admin/v2/cache/lyrics/clear', {}).then(r => toast(`Cleared ${plural(r.removed, 'entry', 'entries')}`), fail);
  };
  pollArt(); pollLrc();
  every(() => { pollArt(); pollLrc(); pollFix(); }, 2000);
}

/* Files (existing /api/admin/files endpoints) */
let filesPath = '';
async function pageFiles(el) {
  el.innerHTML = `<section class="card"><div class="crumbs" id="crumbs"></div><div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th class="num">Size</th><th></th></tr></thead><tbody id="files-body"></tbody></table></div></div></section>`;
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const p = b.dataset.path != null ? decodeURIComponent(b.dataset.path) : '';
    if (b.dataset.act === 'dir') loadDir(p);
    else if (b.dataset.act === 'file-fix') {
      const name = p.split('/').pop();
      const v = await dialog({ title: `Fix ${name}?`, text: b.dataset.dir ? 'Every song in this folder gets its title cleaned up, and is looked up and confirmed by its fingerprint before its title, artists and missing details are written. Every change can be undone.' : 'The title is cleaned up, and the song is looked up and confirmed by its fingerprint before its title, artists and missing details are written. The change can be undone.', fields: [{ type: 'check', name: 'quick', label: 'Only clean up titles (faster, no lookups)' }], ok: 'Fix' });
      if (!v) return;
      api('/api/admin/tagfix/start', { paths: [p], quick: v.quick }).then(r => { toast(`Fixing ${plural(r.total, 'song')}. Follow along under Metadata & lyrics.`); go('metadata'); }, fail);
    } else if (b.dataset.act === 'file-rename') {
      const old = p.split('/').pop();
      const v = await dialog({ title: 'Rename', fields: [{ name: 'name', label: 'New name', value: old }], ok: 'Rename' });
      if (v && v.name.trim() && v.name.trim() !== old) api('/api/admin/files/rename', { path: p, new_name: v.name.trim() }).then(r => { toast(r.moved_songs ? `Renamed; ${plural(r.moved_songs, 'song')} kept their likes and playlists` : 'Renamed'); loadDir(filesPath); }, fail);
    } else if (b.dataset.act === 'file-delete') {
      if (!(await confirmDlg(`Delete ${p.split('/').pop()}?`, (b.dataset.dir ? 'The folder and everything in it is deleted from disk' : 'The file is deleted from disk') + ' and leaves the library right away.', 'Delete', true))) return;
      api('/api/admin/files/delete', { path: p }).then(r => { toast(r.removed_songs ? `Deleted; ${plural(r.removed_songs, 'song')} left the library` : 'Deleted'); loadDir(filesPath); }, fail);
    }
  });
  loadDir(filesPath);
}
async function loadDir(p) {
  filesPath = p;
  const parts = p.split('/').filter(Boolean);
  let acc = '';
  $('#crumbs').innerHTML = `<button data-act="dir" data-path="">${ic('folder', 'sm')} Music</button>` + parts.map(x => { acc += (acc ? '/' : '') + x; return `<span class="sep">/</span><button data-act="dir" data-path="${encArg(acc)}">${esc(x)}</button>`; }).join('');
  const body = $('#files-body');
  body.innerHTML = '<tr><td colspan="3" class="empty">Loading…</td></tr>';
  try {
    const d = await api('/api/admin/files/list?path=' + encodeURIComponent(p));
    body.innerHTML = (d.items || []).length ? d.items.map(it => `<tr>
      <td>${it.is_dir ? `<div class="fname dir" data-act="dir" data-path="${encArg(it.rel_path)}">${ic('folder')}${esc(it.name)}</div>` : `<div class="fname">${ic('note')}${esc(it.name)}</div>`}</td>
      <td class="num muted">${it.is_dir ? '' : fmtBytes(it.size_bytes)}</td>
      <td class="act">${it.is_dir || /\.(flac|mp3|m4a|aac|ogg|opus|wav)$/i.test(it.name) ? `<button class="btn ghost sm" data-act="file-fix" data-path="${encArg(it.rel_path)}"${it.is_dir ? ' data-dir="1"' : ''}>Fix</button> ` : ''}<button class="btn ghost sm" data-act="file-rename" data-path="${encArg(it.rel_path)}">Rename</button> <button class="icon-btn" data-act="file-delete" data-path="${encArg(it.rel_path)}"${it.is_dir ? ' data-dir="1"' : ''} aria-label="Delete">${ic('close')}</button></td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">Empty folder.</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="3" class="empty">${esc(e.message)}</td></tr>`; }
}

/* Maintenance & backups */
function scanLine(sc) {
  if (!sc) return '';
  if (sc.running) return 'Scanning the music folder now…';
  if (!sc.last) return 'The first scan starts a few seconds after the server starts.';
  const parts = [`Last scan ${ago(sc.last)} took ${sc.took < 60 ? sc.took + ' s' : fmtSecs(sc.took)} and found ${plural(sc.files, 'song')}`];
  const ch = [sc.added && `${nf(sc.added)} new`, sc.updated && `${nf(sc.updated)} changed`, sc.removed && `${nf(sc.removed)} removed`].filter(Boolean);
  if (ch.length) parts.push(ch.join(', '));
  return parts.join(' · ') + (sc.error ? ` — ${sc.error}` : '');
}
async function pageMaintenance(el) {
  const ov = await api('/api/admin/v2/overview').catch(() => ({}));
  el.innerHTML = settingsCard('maintenance', { title: 'Maintenance mode' })
    + settingsCard('library', { title: 'Library scanning', extra: `<button class="btn ghost sm" data-act="lib-scan">${ic('refresh', 'sm')}Scan now</button>` }).replace('</section>', `<p class="desc" id="scan-line" style="padding-bottom:18px">${esc(scanLine(ov.scan))}</p></section>`)
    + `<section class="card"><div class="card-h"><h2>Tools</h2></div><div class="card-b flush list">
      <div class="li"><div class="grow"><div class="t">Rebuild the library index</div><div class="s">Re-sorts artists and albums from the current tags and tells every app to resync. New files are picked up automatically.</div></div><button class="btn ghost sm" data-act="lib-refresh">${ic('refresh', 'sm')}Rebuild</button></div>
      <div class="li" id="restart-row" hidden><div class="grow"><div class="t">Restart the server</div><div class="s">Reloads the server process to apply code changes. The site stays reachable.</div></div><button class="btn ghost sm" data-act="restart">Restart</button></div>
      <div class="li"><div class="grow"><div class="t">Remove leftover temp files</div><div class="s">Deletes .part, .ytdl, .temp and .tmp files that interrupted downloads left in the music folder.</div></div><button class="btn ghost sm" data-act="clean-temp">Clean up</button></div>
    </div></section>
    <section class="card"><div class="card-h"><h2>Backup & restore</h2><button class="btn ghost sm" data-act="backup-now">${ic('plus', 'sm')}Back up now</button></div><p class="desc">A backup holds settings (including webhook URLs and password hashes), every account with its likes, playlists and history, and invites. Music files and artwork aren't included. Keep copies somewhere private, ideally off this machine.</p>
      <div class="fields">${settingsCard('backups', { title: false }).replace(/^<section class="card">|<\/section>$/g, '')}</div>
      <div class="card-b flush"><div class="table-wrap"><table><thead><tr><th>Backup</th><th class="num hide-sm">Size</th><th></th></tr></thead><tbody id="backups-body"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody></table></div></div>
      <div class="card-b row wrap"><a class="btn primary sm" href="/api/admin/v2/backup" download>${ic('downloader', 'sm')}Download a fresh backup</a><label class="btn ghost sm">${ic('upload', 'sm')}Restore from a file…<input type="file" accept="application/json,.json,.gz" id="restore-file" hidden></label></div></section>`;
  loadBackups();
  api('/api/admin/v2/system').then(d => { const r = $('#restart-row'); if (r) r.hidden = !d.restart_available; }).catch(() => {});
  $('#restore-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    let data;
    try {
      const text = /\.gz$/i.test(file.name) ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await file.text();
      data = JSON.parse(text);
    } catch (err) { fail(new Error("That file isn't a readable backup.")); return; }
    if (data.format !== 'axdio-backup' && !(data.settings && data.users)) { fail(new Error("That file isn't an Axdio backup.")); return; }
    const users = data.users ? Object.keys(data.users).length : 0, invites = data.invites ? Object.keys(data.invites).length : 0;
    const v = await dialog({ title: 'Restore from backup', text: `Made ${data.exported_at ? fmtTime(data.exported_at) : 'at an unknown time'}. The parts you pick replace what's on the server now.`, ok: 'Restore', danger: true, fields: [
      { name: 'settings', label: 'Settings', type: 'check', value: !!data.settings },
      { name: 'users', label: `Accounts (${nf(users)})`, type: 'check', value: users > 0 },
      { name: 'invites', label: `Invites (${nf(invites)})`, type: 'check', value: invites > 0 },
    ], validate: x => !(x.settings || x.users || x.invites) ? 'Pick at least one part.' : '' });
    if (!v) return;
    const parts = Object.keys(v).filter(k => v[k]).join(',');
    try { const r = await api('/api/admin/v2/restore?parts=' + parts, data); toast('Restored ' + r.restored.join(', ')); await loadConfig(); render(); }
    catch (err) { fail(err); }
  });
}

async function loadBackups() {
  const body = $('#backups-body'); if (!body) return;
  try {
    const d = await api('/api/admin/v2/backups');
    body.innerHTML = d.backups.length ? d.backups.map(b => `<tr><td><div style="font-weight:600">${fmtTime(b.time)}</div><div class="dim" style="font-size:12px">${b.manual ? 'Made by hand' : 'Automatic'} · <span class="mono">${esc(b.name)}</span></div></td>
      <td class="num hide-sm muted">${fmtBytes(b.size)}</td>
      <td class="act"><a class="btn ghost sm" href="/api/admin/v2/backups/${encodeURIComponent(b.name)}" download>Download</a> <button class="btn ghost sm" data-act="backup-restore" data-name="${esc(b.name)}">Restore</button> <button class="icon-btn" data-act="backup-delete" data-name="${esc(b.name)}" aria-label="Delete">${ic('close')}</button></td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">No backups saved on the server yet.</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="3" class="empty">${esc(e.message)}</td></tr>`; }
}

/* Activity */
async function pageActivity(el) {
  el.innerHTML = `<section class="card"><div class="card-h"><h2>Activity</h2><select class="select" id="act-kind" style="width:auto" aria-label="Filter"><option value="">Everything</option>${[...new Set(Object.values(KIND).map(x => x[1]))].map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select></div><div class="card-b flush list" id="act-list"><div class="empty">Loading…</div></div></section>`;
  const draw = async () => {
    const d = await api('/api/admin/v2/activity');
    const want = $('#act-kind').value;
    const items = d.items.filter(e => !want || (KIND[e.kind] || ['', e.kind])[1] === want);
    $('#act-list').innerHTML = activityRows(items) || '<div class="empty">Nothing recorded yet.</div>';
  };
  $('#act-kind').onchange = draw;
  await draw();
  every(() => { if (!document.hidden) draw().catch(() => {}); }, 10000);
}

/* Server logs */
function pageLogs(el) {
  const LOG = { last: 0, lines: [], paused: false };
  el.innerHTML = `<section class="card"><div class="card-b"><div class="term-head"><input class="input" id="log-q" placeholder="Filter" style="max-width:240px" aria-label="Filter logs"><label class="check"><input type="checkbox" id="log-web" checked> Hide web requests</label><span class="grow"></span><button class="btn ghost sm" id="log-pause">Pause</button><button class="btn ghost sm" id="log-save">Download</button></div><div class="term tall" id="log-term"></div></div></section>`;
  const isWeb = l => /"(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) \S+ HTTP\/[\d.]+" \d{3}/.test(l);
  const cls = l => /traceback|error|exception|\[err/i.test(l) ? 'c-bad' : /warn/i.test(l) ? 'c-warn' : '';
  const draw = () => {
    const q = $('#log-q').value.trim().toLowerCase(), hideWeb = $('#log-web').checked;
    const rows = LOG.lines.filter(x => (!hideWeb || !isWeb(x.line)) && (!q || x.line.toLowerCase().includes(q)));
    const term = $('#log-term');
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    term.innerHTML = rows.length ? rows.map(x => `<span class="ln ${cls(x.line)}"><span class="ts">${new Date(x.t * 1000).toLocaleTimeString()}</span>${esc(x.line)}</span>`).join('') : '<span class="ln c-dim">No matching lines.</span>';
    if (atBottom) term.scrollTop = term.scrollHeight;
  };
  const poll = async () => {
    if (LOG.paused) return;
    const d = await api('/api/admin/v2/logs?since=' + LOG.last).catch(() => null); if (!d || !$('#log-term')) return;
    if (d.lines.length) { LOG.lines = LOG.lines.concat(d.lines).slice(-2000); LOG.last = d.last; draw(); }
    else if (!LOG.lines.length) draw();
  };
  $('#log-q').oninput = draw; $('#log-web').onchange = draw;
  $('#log-pause').onclick = e => { LOG.paused = !LOG.paused; e.target.textContent = LOG.paused ? 'Resume' : 'Pause'; if (!LOG.paused) poll(); };
  $('#log-save').onclick = () => {
    const blob = new Blob([LOG.lines.map(x => `${new Date(x.t * 1000).toISOString()} ${x.line}`).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `server-log-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  poll(); every(poll, 2000);
}

/* About */
async function pageAbout(el) {
  const d = await api('/api/admin/v2/system');
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  el.innerHTML = `<section class="card"><div class="card-h"><h2>${esc(ST.values.site_title || 'Axdio')}</h2><span class="sub">${esc(d.app_version ? 'v' + d.app_version : '')}</span></div><div class="card-b"><dl class="kv">
      ${row('Uptime', fmtUptime(d.uptime))}${row('Music folder', `<span class="mono">${esc(d.music_dir)}</span>`)}${row('Config folder', `<span class="mono">${esc(d.config_dir)}</span>`)}
      ${row('Session key', d.secret_key_source === 'environment' ? 'From FLASK_SECRET_KEY' : 'Stored in config/secret_key (kept across restarts)')}
    </dl></div></section>
    <section class="card"><div class="card-h"><h2>Components</h2></div><div class="card-b"><dl class="kv">
      ${row('Python', esc(d.python))}${row('Flask', esc(d.flask))}${row('Web server', esc(d.server))}${row('Mutagen', esc(d.mutagen))}${row('FFmpeg', esc(d.ffmpeg) || '<span class="st-error">not found</span>')}${row('Platform', `<span class="mono">${esc(d.platform)}</span>`)}
    </dl></div></section>
    <section class="card"><div class="card-h"><h2>Plugins</h2><a class="btn ghost sm" href="#/plugins">Manage</a></div><div class="card-b"><dl class="kv">
      ${Object.keys(d.plugins || {}).length ? Object.entries(d.plugins).map(([n, v]) => row(esc(n), esc(v))).join('') : '<dt>None installed</dt><dd></dd>'}
    </dl></div></section>
    <section class="card"><div class="card-b row" style="justify-content:space-between"><span class="muted">Axdio</span><a class="link" href="${esc(d.credit.url)}" target="_blank" rel="noopener">${esc(d.credit.text)}</a></div></section>`;
}

/* ---------- Global actions ---------- */
document.addEventListener('click', async e => {
  const nav = e.target.closest('a.nav-item[data-page]');
  if (nav && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(nav.dataset.page); return; }
  const link = e.target.closest('a[href^="#/"]');
  if (link && !nav) { e.preventDefault(); go(link.getAttribute('href').slice(2)); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  switch (b.dataset.act) {
    case 'save': saveDraft(); break;
    case 'scope-pick': pickScope(b.dataset.scope); break;
    case 'scope-drop': { const s = scopeOf(b.dataset.scope); s[b.dataset.kind] = s[b.dataset.kind].filter(v => v !== decodeURIComponent(b.dataset.v)); drawScope(b.dataset.scope); break; }
    case 'discard': discardDraft(); break;
    case 'nav-open': document.body.classList.add('nav-open'); break;
    case 'nav-close': document.body.classList.remove('nav-open'); break;
    case 'reveal': { const inp = b.previousElementSibling; inp.type = inp.type === 'password' ? 'text' : 'password'; break; }
    case 'user-new': newUser(); break;
    case 'user-menu': userMenu(b); break;
    case 'invite-new': newInvite(); break;
    case 'copy-text': copy(b.dataset.v); break;
    case 'upd-check': b.disabled = true; loadUpdates(true).then(() => toast(UPD.available ? `Axdio ${UPD.latest} is available` : 'Up to date'), fail); break;
    case 'upd-install':
      if (!(await confirmDlg(`Update to Axdio ${UPD.latest}?`, "The server downloads the new version and restarts with it: listeners are interrupted for about a minute. If the new version doesn't start, the current one comes back.", 'Update'))) break;
      api('/api/admin/v2/updates/install', {}).then(d => { UPD = d; drawUpdates(); loadUpdates(false); }, fail);
      break;
    case 'use-origin':
      try { const r = await api('/api/admin/v2/config', { values: { public_url: location.origin } }); ST.values = r.values; toast('Public URL saved'); render(); }
      catch (e) { fail(e); }
      break;
    case 'fed-share': fedShare(); break;
    case 'fed-add': fedAdd(); break;
    case 'fed-menu': fedMenu(b); break;
    case 'fed-unshare': {
      const s = FED && FED.shares.find(x => x.id === b.dataset.id); if (!s) break;
      if (await confirmDlg(`Stop sharing with ${s.peer_name || s.label}?`, "Their key stops working right away and your music disappears from their server. You can make a new key later if you change your mind.", 'Stop sharing', true))
        api(`/api/admin/v2/federation/shares/${s.id}`, undefined, 'DELETE').then(d => { loadFed(d); toast('Stopped sharing'); }, fail);
      break;
    }
    case 'fed-offer':
      api(`/api/admin/v2/federation/offers/${b.dataset.id}/${b.dataset.a}`, {}).then(d => { loadFed(d); toast(b.dataset.a === 'accept' ? 'Library added' : 'Offer declined'); }, fail);
      break;
    case 'invite-copy': { const i = INVITES.find(x => x.code === b.dataset.code); if (i) copy(i.link, 'Invite link copied'); break; }
    case 'invite-revoke':
      if (await confirmDlg(`Revoke invite ${b.dataset.code}?`, "The code stops working. Accounts already created with it aren't affected.", 'Revoke', true))
        api(`/api/admin/v2/invites/${encodeURIComponent(b.dataset.code)}/revoke`, {}).then(loadInvites, fail);
      break;
    case 'notify-test':
      if (dirty()) { toast('Save your changes first', true); break; }
      b.disabled = true;
      api('/api/admin/v2/notify/test', {}).then(r => toast('Sent to ' + Object.keys(r.result).join(' and ')), fail).finally(() => { b.disabled = false; });
      break;
    case 'asset-remove':
      api(`/api/admin/v2/upload/${b.dataset.kind}/delete`, {}).then(() => { toast('Removed'); render(); loadNavMark(); }, fail);
      break;
    case 'lib-refresh': api('/api/admin/v2/library/refresh', {}).then(() => toast('Library index rebuilt'), fail); break;
    case 'plug-check':
      b.disabled = true;
      try { const d = await api('/api/admin/v2/plugins/check', {}); loadPlugins(d); const n = d.plugins.filter(p => p.update).length; toast(n ? `${plural(n, 'update')} available` : 'Everything is up to date'); }
      catch (e) { fail(e); }
      b.disabled = false;
      break;
    case 'plug-do': {
      const p = PLUG && PLUG.plugins.find(x => x.id === b.dataset.id); if (!p) break;
      const a = b.dataset.a;
      if (a === 'remove' && !(await confirmDlg(`Remove ${p.name}?`, 'What it adds to Axdio goes away until you install it again.', 'Remove', true))) break;
      if (a === 'install' && !(await confirmDlg(`Install ${p.name}?`, `${p.name}${p.needs.length ? ` and ${p.needs.join(' and ')}` : ''} will be downloaded from ${p.source} onto this server. It's a separate project with its own license (${p.license}).`, 'Install'))) break;
      api(`/api/admin/v2/plugins/${p.id}`, { action: a }).then(loadPlugins, fail);
      break;
    }
    case 'restart':
      if (!(await confirmDlg('Restart the server?', 'Listeners keep their place, but anything running (a download, an audit) is stopped. The server is back in a few seconds.', 'Restart'))) break;
      try {
        await api('/api/admin/v2/system/restart', {});
        toast('Restarting…');
        const t0 = Date.now();
        await new Promise(r => setTimeout(r, 2500));
        while (Date.now() - t0 < 60000) {
          try { const h = await fetch('/api/health', { cache: 'no-store' }); if (h.ok) break; } catch (e) { /* still restarting */ }
          await new Promise(r => setTimeout(r, 1000));
        }
        location.reload();
      } catch (e) { fail(e); }
      break;
    case 'tfa-on':
      api('/api/admin/v2/2fa', { action: 'start' }).then(drawTfa, fail);
      break;
    case 'tfa-cancel': drawTfa(); break;
    case 'tfa-off': {
      const v = await dialog({ title: 'Turn off two-factor sign-in?', text: 'Enter a current code from your authenticator app.', ok: 'Turn off', danger: true, fields: [{ name: 'code', label: 'Code', autocomplete: 'one-time-code' }] });
      if (v) api('/api/admin/v2/2fa', { action: 'disable', code: v.code }).then(() => { toast('Two-factor sign-in is off'); drawTfa(); }, fail);
      break;
    }
    case 'backup-now':
      b.disabled = true;
      api('/api/admin/v2/backups', {}).then(() => { toast('Backup saved'); loadBackups(); }, fail).finally(() => { b.disabled = false; });
      break;
    case 'backup-delete':
      if (await confirmDlg('Delete this backup?', b.dataset.name, 'Delete', true))
        api('/api/admin/v2/backups/' + encodeURIComponent(b.dataset.name), undefined, 'DELETE').then(loadBackups, fail);
      break;
    case 'backup-restore': {
      const v = await dialog({ title: 'Restore this backup?', text: 'The parts you pick replace what is on the server now.', ok: 'Restore', danger: true, fields: [
        { name: 'settings', label: 'Settings', type: 'check', value: true }, { name: 'users', label: 'Accounts', type: 'check', value: true }, { name: 'invites', label: 'Invites', type: 'check', value: true },
      ], validate: x => !(x.settings || x.users || x.invites) ? 'Pick at least one part.' : '' });
      if (!v) break;
      try { const r = await api(`/api/admin/v2/backups/${encodeURIComponent(b.dataset.name)}/restore?parts=${Object.keys(v).filter(k => v[k]).join(',')}`, {}); toast('Restored ' + r.restored.join(', ')); await loadConfig(); render(); }
      catch (e) { fail(e); }
      break;
    }
    case 'lib-scan':
      b.disabled = true;
      api('/api/admin/v2/library/scan', {}).then(() => {
        toast('Scanning the music folder');
        const poll = setInterval(async () => {
          const ov = await api('/api/admin/v2/overview').catch(() => null);
          const line = $('#scan-line');
          if (!ov || !line) { clearInterval(poll); return; }
          line.textContent = scanLine(ov.scan);
          if (!ov.scan.running) { clearInterval(poll); b.disabled = false; }
        }, 2000);
      }, e => { b.disabled = false; fail(e); });
      break;
    case 'clean-temp':
      if (await confirmDlg('Remove temp files?', 'Only leftovers from interrupted downloads are deleted. Stop any running download first.', 'Clean up'))
        api('/api/admin/clean_temp', {}).then(r => toast(`Removed ${plural(r.removed_files || 0, 'file')}`), fail);
      break;
  }
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty()) { e.preventDefault(); saveDraft(); }
});
window.addEventListener('scroll', () => $('#top').classList.toggle('stuck', scrollY > 4), { passive: true });

/* ---------- Boot ---------- */
async function loadConfig() {
  const c = await api('/api/admin/v2/config');
  ST.schema = c.schema; ST.values = c.values;
  ST.fields = Object.fromEntries(c.schema.flatMap(s => s.fields.map(f => [f.key, f])));
}
/* ---------- Pages from plugins ----------
   A plugin's script (served from /admin/plugins/<id>/) calls AxdioAdmin.page(id, render) to draw its page,
   using the same helpers as the pages here. */
window.AxdioAdmin = { api, $, $$, esc, ic, nf, ago, toast, fail, every, confirmDlg, settingsCard, termLine, fillTerm, ST,
  page(id, draw) { const p = pageById(id); if (!p) return; p.render = draw; if (ST.page === id) render(); } };
const pluginScripts = new Set();
async function loadPluginPages() {
  let d; try { d = await api('/api/admin/v2/plugins/ui'); } catch (e) { return; }
  const want = new Set((d.pages || []).map(pg => pg.id));
  for (let i = PAGES.length - 1; i >= 0; i--) if (PAGES[i].plugin && !want.has(PAGES[i].id)) PAGES.splice(i, 1);
  for (const pg of d.pages || []) {
    if (pageById(pg.id)) continue;
    const g = PAGES.findIndex(p => p.group === pg.group);
    PAGES.splice(g < 0 ? PAGES.length : g + 1, 0, { id: pg.id, title: pg.title, icon: pg.icon, plugin: pg.plugin,
      render: el => { el.innerHTML = '<div class="card"><div class="empty">Loading…</div></div>'; } });
    if (!pluginScripts.has(pg.script)) {
      pluginScripts.add(pg.script);
      document.head.appendChild(Object.assign(document.createElement('script'), { src: pg.script, async: true }));
    }
  }
}

async function loadNavMark() {
  const b = await api('/api/admin/v2/branding').catch(() => ({}));
  $('#nav-mark').innerHTML = b.logo ? `<img src="${esc(b.logo)}" alt="">` : ic('note');
}
(async () => {
  try {
    const [me] = await Promise.all([api('/api/admin/v2/me'), loadConfig(), loadPluginPages()]);
    ST.me = me;
    $('#nav-user').textContent = me.admin_user || '';
    if (me.credit) { const c = $('#credit'); c.href = me.credit.url; c.textContent = me.credit.text; }
    applyBrand(); loadNavMark();
    ST.page = pageById(location.hash.slice(2)) ? location.hash.slice(2) : 'overview';
    history.replaceState(null, '', '#/' + ST.page);
    renderNav(); render();
    api('/api/admin/v2/updates').then(u => { ST.update = u.available ? u.latest : null; renderNav(); }).catch(() => {});
  } catch (e) {
    $('#page').innerHTML = `<div class="card"><div class="empty">Couldn't reach the server: ${esc(e.message)}</div></div>`;
  }
})();
})();
