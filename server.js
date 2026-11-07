// f1.home.arpa — next race weekend + live timing for the homelab.
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { LiveTimingClient } from './lib/livetiming.js';
import { Schedule, inLiveWindow, nextWeekend } from './lib/schedule.js';
import { DemoClient, demoCircuit, demoSchedule, demoStandings, demoRadioWav } from './lib/demo.js';
import { applyItem, clone, sessionKey } from './public/merge.js';
import { extractToken } from './lib/token.js';
import { History } from './lib/history.js';
import { Jolpica } from './lib/jolpica.js';
import { buildIcs } from './lib/ics.js';
import { Archive, raceFor } from './lib/archive.js';
import { Recorder, Player } from './lib/recorder.js';
import { Radar } from './lib/radar.js';
import { Forecast } from './lib/forecast.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// Version of the page files. Their URLs carry it (app.js?v=…), so a browser can't keep
// running an old copy after an update, and the page reloads itself when it changes.
const BUILD = (() => {
  const h = crypto.createHash('sha256');
  for (const f of fss.readdirSync(PUBLIC).sort()) if (/\.(html|js|css)$/.test(f)) h.update(fss.readFileSync(path.join(PUBLIC, f)));
  return h.digest('hex').slice(0, 10);
})();
const versioned = (text) => text
  .replace(/(src|href)="(app\.js|style\.css)"/g, `$1="$2?v=${BUILD}"`)
  .replace(/from '\.\/([\w-]+\.js)'/g, `from './$1?v=${BUILD}'`)
  .replaceAll('__F1LIVE_BUILD__', BUILD);
const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const DEMO = process.env.DEMO === '1';
const LIVE_ALWAYS = process.env.LIVE_ALWAYS === '1';
const BUFFER_MS = Number(process.env.BUFFER_SECONDS || 150) * 1000;
const LIVETIMING_URL = process.env.LIVETIMING_URL || 'https://livetiming.formula1.com/signalrcore';
const JOLPICA_URL = process.env.JOLPICA_URL || 'https://api.jolpi.ca/ergast/f1';
const RADAR_ON = process.env.RADAR !== '0';
const RAINVIEWER_URL = process.env.RAINVIEWER_URL || 'https://api.rainviewer.com';
const BASEMAP_URL = process.env.BASEMAP_URL || 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png';
const FORECAST_ON = process.env.FORECAST !== '0';
const MET_URL = process.env.MET_URL || 'https://api.met.no/weatherapi';
// MET Norway asks every app to say who it is; set your own contact here if you like.
const MET_USER_AGENT = process.env.MET_USER_AGENT || 'f1-home-dashboard/1.0 (+https://github.com/AteaHelland/F1Live)';

await fs.mkdir(path.join(DATA, 'circuits'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- F1 TV token ----------
const TOKEN_FILE = path.join(DATA, 'f1tv-token.txt');
// Optional shared secret: when set, changing or removing the token needs the X-F1Live-Secret header.
const SECRET = (process.env.F1LIVE_SECRET || '').trim();
function authorized(req) {
  if (!SECRET) return true;
  const given = String(req.headers['x-f1live-secret'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}
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

// A new session starts with a clean slate: the one before is saved to its own folder and
// nothing of it (drivers, laps, messages) carries over.
let restartedFor = null;
let listedKey = null;
// When timing or car data last arrived: the page shows its front page once a session has
// been quiet for a while.
const ACTIVITY_TOPICS = new Set(['TimingData', 'Position', 'CarData', 'TimingAppData', 'RaceControlMessages']);
let lastActivityAt = 0;
let radarKey = null;
const LOCAL_TOPICS = ['Radar', 'Forecast']; // added by this server, not by F1
function push(item) {
  const prevKey = sessionKey(latest);
  if (item.kind === 'u' && item.topic === 'SessionInfo' && prevKey) {
    const next = applyItem(clone(latest), item);
    const nextKey = sessionKey(next);
    if (nextKey && nextKey !== prevKey) {
      // F1 moved on to the next session over the same connection. Start from just the new
      // session's info, then reconnect to get a full snapshot of it.
      log(`new session: ${next.SessionInfo.Name}; previous one saved`);
      item = { t: item.t, kind: 'snap', data: { SessionInfo: next.SessionInfo } };
      if (restartedFor !== nextKey && !DEMO) { restartedFor = nextKey; setTimeout(() => live.restart(), 1000); }
    }
  }
  // A reconnect brings a fresh snapshot of F1's topics only: keep what the server added itself.
  if (item.kind === 'snap' && prevKey && sessionKey(item.data) === prevKey) {
    const keep = LOCAL_TOPICS.filter((k) => latest[k] && !item.data?.[k]);
    if (keep.length) item = { ...item, data: { ...item.data, ...Object.fromEntries(keep.map((k) => [k, latest[k]])) } };
  }
  if (item.kind === 'snap' && prevKey && sessionKey(item.data) !== prevKey) {
    archiveNow(JSON.stringify(latest), JSON.stringify(history));
    items = [];   // the delay buffer must not replay the old session on top of the new one
    base = {};
  }
  items.push(item);
  latest = applyItem(latest, item);
  if (recorder) recorder.record(item, latest);
  if (item.kind === 'u' && ACTIVITY_TOPICS.has(item.topic)) lastActivityAt = item.t;
  // A new session shows up in the picker within seconds, not at the next minute's save.
  const key = sessionKey(latest);
  if (key && key !== radarKey) { radarKey = key; setTimeout(radarTick, 3000); } // radar and forecast for the new session
  if (key && key !== listedKey && !DEMO) {
    listedKey = key;
    setTimeout(() => { if (sessionKey(latest) === key) archiveNow(JSON.stringify(latest), JSON.stringify(history)); }, 5000);
  }
  dirty = true;
  broadcast(null, item);
  for (const e of history.observe(item, latest)) broadcast('hist', e);
}

// ---------- session folders (data/sessions/<year>/R<round> - <circuit>/<session>) ----------
const archive = new Archive({ dataDir: DATA, getRaces: () => schedule.races });
// Recording for replay: RECORD=0 turns it off; RECORD_WEEKENDS is how many weekends keep their
// recordings (0 = all). Older sessions keep their folder, just without the recording.
const recorder = DEMO || process.env.RECORD === '0' ? null : new Recorder({
  archive, getRaces: () => schedule.races, log,
  keepWeekends: Math.max(0, Number(process.env.RECORD_WEEKENDS ?? 3) || 0),
});
const player = new Player({ archive });

// ---------- rain radar for the weather map (RADAR=0 turns it off) ----------
const radar = RADAR_ON ? new Radar({
  dataDir: DATA, api: RAINVIEWER_URL, basemap: BASEMAP_URL, log, getState: () => latest,
  emit: (key, data) => {
    if (sessionKey(latest) !== key) return false;
    push({ t: Date.now(), kind: 'u', topic: 'Radar', data });
    return true;
  },
}) : null;
// Where the session is: the calendar race it belongs to (in demo mode, the next weekend's circuit).
function radarTarget() {
  const key = sessionKey(latest);
  if (!key) return null;
  const race = DEMO ? nextWeekend(schedule.races) : raceFor(latest, schedule.races);
  if (race?.lat == null) return null;
  return { key, lat: race.lat, lon: race.lon, name: race.circuit || race.locality || '' };
}
// Hourly forecast for the circuit from MET Norway (yr.no); FORECAST=0 turns it off.
const forecast = FORECAST_ON ? new Forecast({
  api: MET_URL, userAgent: MET_USER_AGENT, log, getState: () => latest,
  emit: (key, data) => {
    if (sessionKey(latest) !== key) return false;
    push({ t: Date.now(), kind: 'u', topic: 'Forecast', data });
    return true;
  },
}) : null;
function radarTick() {
  if (!(DEMO || inLiveWindow(schedule.races))) return;
  const target = radarTarget();
  if (radar) radar.tick(target);
  if (forecast) forecast.tick(target);
}
// Radar frames are kept as long as the recordings that show them, and at least a day.
async function radarPrune() {
  if (!radar) return;
  try {
    let oldest = Infinity;
    for (const s of await archive.list()) if (s.recorded && s.start) oldest = Math.min(oldest, Date.parse(s.start));
    await radar.prune(Math.min(oldest - 3 * 3600000, Date.now() - 86400000));
  } catch (e) { log('radar prune failed', e.message); }
}
function archiveNow(stateJson, historyJson) {
  return archive.save(stateJson, historyJson)
    .then((dir) => { if (dir) broadcast('sessions', { saved: dir.split(path.sep).join('/') }); return dir; })
    .catch((e) => { log('session save failed', e.message); });
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
    const st = JSON.stringify(latest), hi = JSON.stringify(history);
    await fs.writeFile(LAST_FILE, st);
    await fs.writeFile(HISTORY_FILE, hi);
    if (!DEMO) await archiveNow(st, hi);
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
  return { build: BUILD, lastActivityAt, demo: DEMO, radar: radar ? radar.info() : null, forecast: forecast ? forecast.info() : null, liveWindow: windowOpen, live: live.info(), token: tokenInfo(), secretConfigured: Boolean(SECRET), bufferSeconds: BUFFER_MS / 1000 };
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
// The session kept from before this start (or before this version) gets its folder too.
if (!DEMO && sessionKey(latest)) {
  const dir = await archiveNow(JSON.stringify(latest), JSON.stringify(history));
  if (dir) log(`last session kept in sessions/${dir.split(path.sep).join('/')}`);
}
const jolpica = new Jolpica({ dataDir: DATA, base: JOLPICA_URL });
await tick();
setInterval(tick, 60000);
setInterval(radarTick, 60000);
setTimeout(radarTick, 5000);
setInterval(radarPrune, 3600000);
setTimeout(radarPrune, 120000);

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
    if (url.pathname === '/api/sessions') return json(res, 200, await archive.list());
    if (url.pathname === '/api/replay') {
      const t = Number(url.searchParams.get('t')) || 0;
      const span = Math.min(600000, Math.max(10000, Number(url.searchParams.get('span')) || 120000));
      let body;
      try { body = await player.window(url.searchParams.get('id'), t, span, url.searchParams.get('itemsOnly') === '1'); }
      catch (e) { return json(res, 404, { error: e.code === 'ENOENT' ? 'no recording for this session' : e.message }); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (url.pathname === '/api/session') {
      try { return json(res, 200, await archive.load(url.searchParams.get('id'))); }
      catch (e) { return json(res, 404, { error: e.code === 'ENOENT' ? 'session not found' : e.message }); }
    }
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
    // Weather map images: /api/radar/frame/<unix time>/7-x-y.png, /api/radar/coverage/7-x-y.png,
    // /api/basemap/8-x-y.png. Only what the server saved is served.
    const img = /^\/api\/(?:radar\/(frame)\/(\d+)|radar\/(coverage)|(basemap))\/([^/]+)$/.exec(url.pathname);
    if (img) {
      const kind = img[1] || img[3] || 'base';
      const file = radar?.fileFor(kind, img[2], img[5]);
      let buf = null;
      if (file) try { buf = await fs.readFile(file); } catch {}
      if (!buf) return json(res, 404, { error: 'image not kept' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': kind === 'coverage' ? 'private, max-age=86400' : 'private, max-age=604800, immutable' });
      return res.end(buf);
    }
    if (url.pathname === '/api/circuit') {
      try { return json(res, 200, await circuit(url.searchParams.get('key') || '', url.searchParams.get('year') || '')); }
      catch (e) { return json(res, 404, { error: e.message }); }
    }
    if (url.pathname === '/api/token' && (req.method === 'POST' || req.method === 'DELETE') && !authorized(req)) {
      return json(res, 401, { error: 'Wrong or missing secret.', needSecret: true });
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
    if (/\.(html|js|css)$/.test(file)) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-cache' });
      return res.end(versioned(await fs.readFile(file, 'utf8')));
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fss.createReadStream(file).pipe(res);
  } catch (e) {
    log('request error', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => log(`f1 dashboard on :${PORT}${DEMO ? ' (demo mode)' : ''}; token ${token ? 'present' : 'not set'}; token changes ${SECRET ? 'need the secret' : 'are open (F1LIVE_SECRET not set)'}`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      const st = JSON.stringify(latest), hi = JSON.stringify(history);
      await fs.writeFile(LAST_FILE, st);
      await fs.writeFile(HISTORY_FILE, hi);
      if (!DEMO) await archiveNow(st, hi);
      if (recorder) await recorder.close();
    } catch {}
    process.exit(0);
  });
}
