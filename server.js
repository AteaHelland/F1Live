// f1.home.arpa — next race weekend + live timing for the homelab.
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveTimingClient } from './lib/livetiming.js';
import { Schedule, inLiveWindow } from './lib/schedule.js';
import { DemoClient, demoCircuit, demoSchedule, demoStandings, demoRadioWav } from './lib/demo.js';
import { applyItem, clone } from './public/merge.js';
import { extractToken } from './lib/token.js';
import { History } from './lib/history.js';
import { Jolpica } from './lib/jolpica.js';
import { buildIcs } from './lib/ics.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const DEMO = process.env.DEMO === '1';
const LIVE_ALWAYS = process.env.LIVE_ALWAYS === '1';
const BUFFER_MS = Number(process.env.BUFFER_SECONDS || 150) * 1000;
const LIVETIMING_URL = process.env.LIVETIMING_URL || 'https://livetiming.formula1.com/signalrcore';
const JOLPICA_URL = process.env.JOLPICA_URL || 'https://api.jolpi.ca/ergast/f1';

await fs.mkdir(path.join(DATA, 'circuits'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- F1 TV token ----------
const TOKEN_FILE = path.join(DATA, 'f1tv-token.txt');
let token = (process.env.F1TV_TOKEN || '').trim() || null;
try { token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim() || token; } catch {}
const META_FILE = path.join(DATA, 'f1tv-token-meta.json');
let tokenMeta = {};
try { tokenMeta = JSON.parse(await fs.readFile(META_FILE, 'utf8')); } catch {}

function tokenInfo() {
  const i = tokenInfoRaw();
  return i.present ? { ...i, source: tokenMeta.source || null, savedAt: tokenMeta.savedAt || null } : i;
}

function tokenInfoRaw() {
  if (!token) return { present: false };
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return { present: true, expires: p.exp ? new Date(p.exp * 1000).toISOString() : null };
  } catch {
    return { present: true, expires: null };
  }
}

// ---------- state + replay buffer ----------
// `base` is the state at the start of the buffer; `items` are every change since.
// Browsers rebuild state from these, so they can show the data with a broadcast delay.
const LAST_FILE = path.join(DATA, 'last-session.json');
let base = {};
let latest = {};
let items = [];
let dirty = false;
try {
  base = JSON.parse(await fs.readFile(LAST_FILE, 'utf8'));
  latest = clone(base);
} catch {}

// Lap-by-lap gaps, weather and track status for the current session (race trace etc.).
const HISTORY_FILE = path.join(DATA, 'last-history.json');
let saved = null;
try { saved = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8')); } catch {}
const history = new History(saved);

const clients = new Set();
function broadcast(event, data) {
  const msg = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function push(item) {
  items.push(item);
  latest = applyItem(latest, item);
  dirty = true;
  broadcast(null, item);
  for (const e of history.observe(item, latest)) broadcast('hist', e);
}

function prune() {
  const cutoff = Date.now() - BUFFER_MS;
  while (items.length && items[0].t < cutoff) base = applyItem(base, items.shift());
}
setInterval(prune, 5000);
setInterval(async () => {
  if (!dirty) return;
  dirty = false;
  try {
    await fs.writeFile(LAST_FILE, JSON.stringify(latest));
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history));
  } catch (e) { log('save failed', e.message); }
}, 60000);

// ---------- live timing connection ----------
const live = DEMO ? new DemoClient() : new LiveTimingClient({ baseUrl: LIVETIMING_URL, getToken: () => token });
live.on('snapshot', (snap) => { push({ t: Date.now(), kind: 'snap', data: snap }); log('subscribed; topics:', Object.keys(snap).join(', ')); });
live.on('update', (topic, data) => push({ t: Date.now(), kind: 'u', topic, data }));
live.on('status', (s) => { broadcast('status', statusView()); if (s.lastError) log('live timing:', s.status, s.lastError); });

const schedule = new Schedule({ dataDir: DATA });
let windowOpen = false;

function statusView() {
  return { demo: DEMO, liveWindow: windowOpen, live: live.info(), token: tokenInfo(), bufferSeconds: BUFFER_MS / 1000 };
}

async function tick() {
  if (!DEMO) await schedule.refresh();
  const open = DEMO || LIVE_ALWAYS || inLiveWindow(schedule.races);
  if (open !== windowOpen) {
    windowOpen = open;
    log(open ? 'session window open — connecting to live timing' : 'session window closed — disconnecting');
    if (open) live.start(); else live.stop();
    broadcast('status', statusView());
  }
}
await schedule.load(); // demo mode still uses the real calendar for the .ics feed
const jolpica = new Jolpica({ dataDir: DATA, base: JOLPICA_URL });
await tick();
setInterval(tick, 60000);

// ---------- circuit outline (MultiViewer API, cached on disk) ----------
async function circuit(key, year) {
  if (DEMO || key === '0') return demoCircuit();
  if (!/^\d+$/.test(key) || !/^\d{4}$/.test(year)) throw new Error('bad circuit key/year');
  const file = path.join(DATA, 'circuits', `${key}-${year}-v2.json`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  for (const y of [Number(year), Number(year) - 1, Number(year) - 2]) {
    const res = await fetch(`https://api.multiviewer.app/api/v1/circuits/${key}/${y}`, {
      headers: { 'User-Agent': 'f1-home-dashboard/1.0' }, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) continue;
    const j = await res.json();
    const slim = { x: j.x, y: j.y, rotation: j.rotation || 0, circuitName: j.circuitName,
      corners: (j.corners || []).map((c) => ({ number: c.number, letter: c.letter, angle: c.angle, trackPosition: c.trackPosition })),
      marshalSectors: (j.marshalSectors || []).map((m) => ({ number: m.number, trackPosition: m.trackPosition })) };
    await fs.writeFile(file, JSON.stringify(slim));
    return slim;
  }
  throw new Error('circuit not found');
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, live: live.info().status });
    if (url.pathname === '/api/status') return json(res, 200, statusView());
    if (url.pathname === '/api/schedule') return json(res, 200, DEMO ? demoSchedule() : schedule.view());
    if (url.pathname === '/api/state') return json(res, 200, latest);
    if (url.pathname === '/api/standings') {
      if (DEMO) return json(res, 200, demoStandings());
      try { return json(res, 200, await jolpica.standings()); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/api/season') {
      const year = url.searchParams.get('year') || String(new Date().getUTCFullYear());
      if (!/^\d{4}$/.test(year)) return json(res, 400, { error: 'bad year' });
      try { return json(res, 200, await jolpica.season(year)); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/api/results') {
      const year = url.searchParams.get('year') || '', round = url.searchParams.get('round') || '';
      if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(round)) return json(res, 400, { error: 'bad year/round' });
      try { return json(res, 200, await jolpica.results(year, round, url.searchParams.get('kind') || 'race')); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/calendar.ics') {
      await schedule.refresh();
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || (host && !/:\d+$/.test(host) ? 'https' : 'http');
      const body = buildIcs(schedule.races, {
        main: url.searchParams.get('main') === '1',
        alarm: Math.min(240, Math.max(0, Number(url.searchParams.get('alarm')) || 0)),
        url: host ? `${proto}://${host}/` : '',
      });
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline; filename="f1.ics"' });
      return res.end(body);
    }
    if (url.pathname === '/api/demo-radio.wav') {
      const wav = demoRadioWav();
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'max-age=3600' });
      return res.end(wav);
    }
    if (url.pathname === '/api/circuit') {
      try { return json(res, 200, await circuit(url.searchParams.get('key') || '', url.searchParams.get('year') || '')); }
      catch (e) { return json(res, 404, { error: e.message }); }
    }
    if (url.pathname === '/api/token' && req.method === 'POST') {
      const body = await readBody(req);
      let input = body, source = 'manual';
      try { const j = JSON.parse(body); input = j.token ?? body; if (j.source === 'auto') source = 'auto'; } catch {}
      const t = extractToken(input);
      if (!t) return json(res, 400, { error: "Couldn't find a token in that. Paste the login-session cookie value or the subscriptionToken." });
      token = t;
      await fs.writeFile(TOKEN_FILE, t, { mode: 0o600 });
      tokenMeta = { source, savedAt: new Date().toISOString() };
      await fs.writeFile(META_FILE, JSON.stringify(tokenMeta));
      live.restart();
      log(`F1 TV token updated (${source === 'auto' ? 'automatic sign-in' : 'pasted'})`);
      return json(res, 200, statusView());
    }
    if (url.pathname === '/api/token' && req.method === 'DELETE') {
      token = null;
      await fs.rm(TOKEN_FILE, { force: true });
      tokenMeta = {};
      await fs.rm(META_FILE, { force: true });
      live.restart();
      return json(res, 200, statusView());
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: init\ndata: ${JSON.stringify({ serverNow: Date.now(), base, items, history: history.entries, status: statusView() })}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(`: ka ${Date.now()}\n\n`), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    // static files
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
    if (!fss.existsSync(file) || fss.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fss.createReadStream(file).pipe(res);
  } catch (e) {
    log('request error', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => log(`f1 dashboard on :${PORT}${DEMO ? ' (demo mode)' : ''}; token ${token ? 'present' : 'not set'}`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await fs.writeFile(LAST_FILE, JSON.stringify(latest));
      await fs.writeFile(HISTORY_FILE, JSON.stringify(history));
    } catch {}
    process.exit(0);
  });
}
