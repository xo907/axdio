// Discord status, built in: Discord lets programs on this computer set the listener's status ("Listening to …")
// through the Discord app's local connection, a named pipe. The server says what to show (GET /api/presence, with
// the key this app keeps, as it does for the helper script people install elsewhere); this hands it to Discord, and
// clears it when nothing's playing. Nothing goes to Discord from anywhere else.
const net = require('net');

const PIPES = () => (process.env.AXDIO_DISCORD_PIPE ? [process.env.AXDIO_DISCORD_PIPE]
  : Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`));

// Discord's local connection: frames of an operation code and a length (both 32-bit, little-endian), then JSON.
class DiscordIPC {
  constructor() { this.sock = null; this.appId = null; this.buf = Buffer.alloc(0); this.waiters = []; }

  async connect(appId) {
    this.close();
    for (const path of PIPES()) {
      try {
        await this.open(path);
        this.send(0, { v: 1, client_id: String(appId) });
        const [op, data] = await this.recv(5000);
        if (op === 1 && data.evt === 'READY') { this.appId = String(appId); return true; }
      } catch (e) { /* not this one: try the next */ }
      this.close();
    }
    return false;
  }

  open(path) {
    return new Promise((resolve, reject) => {
      const s = net.connect(path);
      const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 3000);
      s.once('connect', () => {
        clearTimeout(t);
        this.sock = s;
        s.on('data', d => this.onData(d));
        s.on('close', () => this.onClose(s));
        s.on('error', () => {});
        resolve();
      });
      s.once('error', e => { clearTimeout(t); reject(e); });
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0), n = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + n) break;
      let data = {};
      try { data = JSON.parse(this.buf.subarray(8, 8 + n).toString('utf8') || '{}'); } catch (e) { /* not JSON */ }
      this.buf = this.buf.subarray(8 + n);
      if (op === 3) { this.send(4, data); continue; }      // ping: pong
      const w = this.waiters.shift();
      if (w) w([op, data]);
    }
  }

  onClose(s) {
    if (this.sock !== s) return;
    this.sock = null; this.appId = null; this.buf = Buffer.alloc(0);
    this.waiters.splice(0).forEach(w => w([2, {}]));
  }

  send(op, payload) {
    if (!this.sock) throw new Error('Discord isn\'t connected');
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(op, 0); head.writeUInt32LE(body.length, 4);
    this.sock.write(Buffer.concat([head, body]));
  }

  recv(ms) {
    return new Promise((resolve, reject) => {
      const done = r => { clearTimeout(t); resolve(r); };
      const t = setTimeout(() => { const i = this.waiters.indexOf(done); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('timeout')); }, ms);
      this.waiters.push(done);
    });
  }

  async setActivity(activity) {
    this.send(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, ...(activity ? { activity } : {}) }, nonce: `${Date.now()}-${Math.random()}` });
    const [op, data] = await this.recv(5000);
    if (op === 2) throw new Error('Discord closed the connection');
    if (data && data.evt === 'ERROR') throw new Error((data.data && data.data.message) || 'Discord said no');
    return data;
  }

  close() {
    if (this.sock) { try { this.sock.destroy(); } catch (e) { /* closed */ } }
    this.sock = null; this.appId = null; this.buf = Buffer.alloc(0);
  }
}

// Every few seconds: what to show (from the server), handed to Discord when it's open.
class Presence {
  constructor({ fetch, server, key, onRevoked, onChange }) {
    Object.assign(this, { fetch, server, key, onRevoked, onChange });
    this.ipc = new DiscordIPC();
    this.timer = null; this.running = false; this.last = ''; this.connected = null; this.showing = false;
  }

  start() { if (this.running) return; this.running = true; this.tick(); }

  async stop() {
    this.running = false;
    clearTimeout(this.timer); this.timer = null;
    if (this.ipc.sock) { try { await this.ipc.setActivity(null); } catch (e) { /* gone */ } }
    this.ipc.close();
    this.last = ''; this.showing = false; this.setConnected(null);
  }

  setConnected(v) { if (v !== this.connected) { this.connected = v; if (this.onChange) this.onChange(); } }

  async tick() {
    let wait = 5000;
    try {
      const r = await this.fetch(this.server + '/api/presence', { headers: { Authorization: 'Bearer ' + this.key, 'User-Agent': 'Axdio-Windows' }, signal: AbortSignal.timeout(10000) });
      if (r.status === 401) { this.running = false; await this.stop(); this.onRevoked(); return; }   // turned off elsewhere
      const d = await r.json();
      wait = Math.max(3, Math.min(60, +d.poll || 5)) * 1000;
      if (d.app_id && d.activity) {
        if (!this.ipc.sock || this.ipc.appId !== String(d.app_id)) this.setConnected(await this.ipc.connect(d.app_id));
        if (this.ipc.sock) {
          const k = JSON.stringify(d.activity);
          if (k !== this.last) { await this.ipc.setActivity(d.activity); this.last = k; this.showing = true; }
        } else wait = 15000;                                  // Discord isn't open: look again in a while
      } else if (this.showing && this.ipc.sock) {
        await this.ipc.setActivity(null); this.last = ''; this.showing = false;
      }
    } catch (e) {
      this.ipc.close(); this.last = ''; this.showing = false;
      wait = 15000;
    }
    if (this.running) this.timer = setTimeout(() => this.tick(), wait);
  }
}

module.exports = { DiscordIPC, Presence };
