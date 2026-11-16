// Probe: what does F1's live timing actually offer?
//
// Connects to the live hub next to the dashboard (its own connection, nothing is changed),
// asks for every topic it knows of one by one, listens for a few minutes, and also reads F1's
// archive index for the session, which lists every feed F1 published. Writes a report plus a
// sample of each topic to data/probe/<time>/.
//
//   sudo docker compose exec f1live node tools/probe.js            # 2 minutes of listening
//   sudo docker compose exec f1live node tools/probe.js --minutes 10
//   ... --path "2026/2026-11-08_São_Paulo_Grand_Prix/2026-11-08_Race/"   # archive of that session
//   ... --topics Foo,Bar      extra topic names to try      --no-live / --no-archive
//
// Best run during a session: between sessions the hub has little or nothing to say. The archive
// part works at any time. The F1 TV token is used if one is saved; it is never written out.
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeZ, BASE_TOPICS, AUTH_TOPICS } from '../lib/livetiming.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HUB = (process.env.LIVETIMING_URL || 'https://livetiming.formula1.com/signalrcore').replace(/\/$/, '');
const STATIC = (process.env.LIVETIMING_STATIC_URL || 'https://livetiming.formula1.com/static').replace(/\/$/, '');
const MINUTES = Math.max(0, Number(opt('minutes', 2)) || 0);
const UA = 'f1-home-dashboard/1.0';
const RS = '\x1e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every topic name seen in F1's feed or in other projects. Unknown ones cost nothing to ask for.
const CANDIDATES = [...new Set([
  ...BASE_TOPICS, ...AUTH_TOPICS,
  'SessionData', 'TopThree', 'RcmSeries', 'TlaRcm', 'WeatherDataSeries', 'AudioStreams', 'ContentStreams',
  'ArchiveStatus', 'LapSeries', 'DriverRaceInfo', 'ChampionshipPrediction', 'PitStopSeries', 'PitStop',
  'TyreStintSeries', 'CurrentTyres', 'OvertakeSeries', 'DriverTracker', 'DriverScore', 'TimingDataF1',
  'SPFeed', 'StintSeries', 'Position', 'CarData',
  ...String(opt('topics', '')).split(',').map((s) => s.trim()).filter(Boolean),
])];
const USED = new Set([...BASE_TOPICS, ...AUTH_TOPICS]);

// ---------- describing data without dumping it ----------
const kb = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const size = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v) ?? '');
const plain = (topic, data) => (topic.endsWith('.z') && typeof data === 'string' ? decodeZ(data) : data);
function shape(v, depth = 0, max = 4) {
  const pad = '  '.repeat(depth);
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length} × ${shape(v[0], depth, max)}]` : '[]';
  if (typeof v !== 'object') {
    const s = JSON.stringify(v);
    return `${typeof v} ${s.length > 48 ? `${s.slice(0, 45)}…"` : s}`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  if (depth >= max) return `{ ${keys.length} keys }`;
  // A map keyed by car numbers or indexes: describe one entry.
  if (keys.length > 3 && keys.every((k) => /^\d+$/.test(k))) {
    return `{ ${keys.length} numbered entries ("${keys[0]}", "${keys[1]}", …) each: ${shape(v[keys[0]], depth, max)} }`;
  }
  const lines = keys.slice(0, 40).map((k) => `${pad}  ${k}: ${shape(v[k], depth + 1, max)}`);
  if (keys.length > 40) lines.push(`${pad}  … ${keys.length - 40} more keys`);
  return `{\n${lines.join('\n')}\n${pad}}`;
}

// ---------- one hub connection ----------
async function connect(token) {
  const headers = { 'User-Agent': UA };
  if (token) headers.Authorization = `Bearer ${token}`;
  const neg = await fetch(`${HUB}/negotiate?negotiateVersion=1`, { method: 'POST', headers, signal: AbortSignal.timeout(20000) });
  if (!neg.ok) { const e = new Error(`negotiate: HTTP ${neg.status}`); e.status = neg.status; throw e; }
  const cookies = (neg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const info = await neg.json();
  const id = info.connectionToken || info.connectionId;
  if (!id) throw new Error('negotiate returned no connection id');
  const ws = new WebSocket(`${HUB.replace(/^http/, 'ws')}?id=${encodeURIComponent(id)}`, { headers: cookies ? { ...headers, Cookie: cookies } : headers });
  const c = { ws, open: true, waiting: new Map(), onFeed: null, inv: 0, closed: null };
  let buf = '', shaken = false, ready;
  const hello = new Promise((res, rej) => { ready = { res, rej }; });
  ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    c.open = false;
    c.closed = c.closed || `socket closed (${ev.code})`;
    ready.rej(new Error(c.closed));
    for (const w of c.waiting.values()) w({ closed: c.closed });
    c.waiting.clear();
  };
  ws.onmessage = (ev) => {
    buf += typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    let i;
    while ((i = buf.indexOf(RS)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!raw) continue;
      let m;
      try { m = JSON.parse(raw); } catch { continue; }
      if (!shaken) { shaken = true; if (m.error) ready.rej(new Error(`handshake: ${m.error}`)); else ready.res(); continue; }
      if (m.type === 1 && String(m.target).toLowerCase() === 'feed') c.onFeed?.(m.arguments?.[0], m.arguments?.[1]);
      else if (m.type === 3 && c.waiting.has(m.invocationId)) { c.waiting.get(m.invocationId)(m); c.waiting.delete(m.invocationId); }
      else if (m.type === 7) c.closed = `server closed the connection${m.error ? `: ${m.error}` : ''}`;
    }
  };
  await hello;
  c.ping = setInterval(() => { if (c.open) ws.send(JSON.stringify({ type: 6 }) + RS); }, 15000);
  c.subscribe = (topic) => new Promise((res) => {
    if (!c.open) return res({ closed: c.closed });
    const id2 = String(++c.inv);
    c.waiting.set(id2, res);
    ws.send(JSON.stringify({ type: 1, invocationId: id2, target: 'Subscribe', arguments: [[topic]] }) + RS);
    setTimeout(() => { if (c.waiting.delete(id2)) res({ timeout: true }); }, 8000);
  });
  c.close = () => { clearInterval(c.ping); ws.onclose = null; try { ws.close(); } catch {} c.open = false; };
  return c;
}

// Ask for each topic on its own, so one refusal can't hide the others. If the hub drops the
// connection on a topic, note it, reconnect and carry on with the next.
async function askAll(token, topics, onFeed) {
  const out = {};
  let c = await connect(token);
  c.onFeed = onFeed;
  let drops = 0;
  for (const t of topics) {
    if (!c.open) {
      if (++drops > 6) { out[t] = { answer: 'skipped (too many dropped connections)' }; continue; }
      await sleep(1500);
      c = await connect(token);
      c.onFeed = onFeed;
    }
    const m = await c.subscribe(t);
    if (m.closed) out[t] = { answer: `dropped the connection (${m.closed})` };
    else if (m.timeout) out[t] = { answer: 'no answer' };
    else if (m.error) out[t] = { answer: `refused: ${String(m.error).slice(0, 160)}` };
    else {
      const keys = Object.keys(m.result || {});
      // The hub answers with whatever it has for the topic (sometimes under a slightly different name).
      if (!keys.length) out[t] = { answer: 'accepted, nothing to send yet' };
      else out[t] = { answer: 'data', as: keys.join(', '), snapshot: keys.length === 1 ? plain(keys[0], m.result[keys[0]]) : m.result, bytes: size(m.result) };
    }
    await sleep(150);
  }
  return { out, conn: c };
}

// ---------- F1's archive of the session ----------
async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).replace(/^﻿/, '');
}
async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { bytes: Number(res.headers.get('content-length')) || null };
  } catch (e) { return { error: e.message }; }
}
async function probeArchive(sessionPath, dir) {
  const a = { path: sessionPath, feeds: {}, error: null, year: null };
  const base = `${STATIC}/${encodeURI(sessionPath)}`;
  try {
    const index = JSON.parse(await getText(`${base}Index.json`));
    for (const [name, f] of Object.entries(index.Feeds || {})) {
      const feed = { keyFrame: f.KeyFramePath, stream: f.StreamPath };
      if (f.KeyFramePath) {
        try {
          const text = await getText(`${base}${f.KeyFramePath}`);
          feed.keyBytes = Buffer.byteLength(text);
          let data = JSON.parse(text);
          data = plain(name, data);
          feed.shape = shape(data);
          await fs.writeFile(path.join(dir, 'archive', `${name}.json`), JSON.stringify(data, null, 1).slice(0, 300000));
        } catch (e) { feed.keyError = e.message; }
      }
      if (f.StreamPath) Object.assign(feed, { streamInfo: await headSize(`${base}${f.StreamPath}`) });
      a.feeds[name] = feed;
      await sleep(120);
    }
  } catch (e) { a.error = e.message; }
  // The season index: can other sessions be found and fetched the same way?
  const year = /^(\d{4})\//.exec(sessionPath)?.[1];
  if (year) {
    try {
      const y = JSON.parse(await getText(`${STATIC}/${year}/Index.json`));
      const meetings = y.Meetings || [];
      const sessions = meetings.flatMap((m) => (m.Sessions || []).map((s) => ({ meeting: m.Name, name: s.Name, path: s.Path, start: s.StartDate })));
      a.year = { year, meetings: meetings.length, sessions: sessions.length, withPath: sessions.filter((s) => s.path).length, sample: sessions.slice(-6) };
      await fs.writeFile(path.join(dir, 'archive', `season-${year}.json`), JSON.stringify(y, null, 1).slice(0, 600000));
    } catch (e) { a.year = { year, error: e.message }; }
  }
  return a;
}

// ---------- run ----------
const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
const dir = path.join(DATA, 'probe', stamp);
await fs.mkdir(path.join(dir, 'topics'), { recursive: true });
await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
let token = null;
try { token = (await fs.readFile(path.join(DATA, 'f1tv-token.txt'), 'utf8')).trim() || null; } catch {}

const R = { at: new Date().toISOString(), minutes: MINUTES, token: token ? 'used' : 'none saved', live: null, liveError: null, noToken: null, archive: null, session: null };
const stats = {}; // topic → { n, bytes, first, samples }
let topics = [...CANDIDATES];
let sessionPath = opt('path', null);
let lastState = null;
try { const j = JSON.parse(await fs.readFile(path.join(DATA, 'last-session.json'), 'utf8')); lastState = j.state || j; } catch {}

const onFeed = (topic, data) => {
  const s = (stats[topic] ||= { n: 0, bytes: 0, samples: [] });
  s.n++;
  s.bytes += size(data);
  if (s.samples.length < 25) { try { s.samples.push(plain(topic, data)); } catch { s.samples.push('(could not decode)'); } }
};
if (!flag('no-live')) {
  console.log(`Asking the live hub for ${topics.length} topics${token ? ' (with the F1 TV token)' : ' (no token saved)'}…`);
  try {
    let r;
    try { r = await askAll(token, topics, onFeed); }
    catch (e) {
      if (token && (e.status === 401 || e.status === 403)) { R.token = 'rejected by F1 (expired?)'; token = null; r = await askAll(null, topics, onFeed); }
      else throw e;
    }
    R.live = r.out;
    const si = r.out.SessionInfo?.snapshot;
    if (si?.Name) R.session = { meeting: si.Meeting?.Name, name: si.Name, path: si.Path, status: r.out.SessionStatus?.snapshot?.Status };
    if (!sessionPath && si?.Path) sessionPath = si.Path;
    if (MINUTES) {
      console.log(`Listening for ${MINUTES} minute${MINUTES === 1 ? '' : 's'}…`);
      const end = Date.now() + MINUTES * 60000;
      while (Date.now() < end && r.conn.open) await sleep(1000);
      if (!r.conn.open) R.liveError = `connection ended while listening: ${r.conn.closed}`;
    }
    r.conn.close();
    if (token) {
      console.log('Asking again without the token, to see what needs a subscription…');
      const n = await askAll(null, topics, null);
      n.conn.close();
      R.noToken = Object.fromEntries(Object.entries(n.out).map(([k, v]) => [k, v.answer]));
    }
  } catch (e) { R.liveError = e.message; }
}
if (!sessionPath) sessionPath = lastState?.SessionInfo?.Path || null;
if (!flag('no-archive')) {
  if (sessionPath) { console.log(`Reading F1's archive for ${sessionPath}…`); R.archive = await probeArchive(sessionPath, dir); }
  else R.archive = { error: 'no session known: pass --path "<SessionInfo.Path>"', feeds: {} };
}
// Feeds the archive lists that weren't on the list: ask the live hub for those too.
const extra = Object.keys(R.archive?.feeds || {}).filter((n) => !topics.includes(n));
if (R.live && extra.length) {
  console.log(`The archive lists ${extra.length} more feed${extra.length === 1 ? '' : 's'} (${extra.join(', ')}): asking the live hub for ${extra.length === 1 ? 'it' : 'them'}…`);
  try {
    const r = await askAll(token, extra, onFeed);
    await sleep(Math.min(20000, MINUTES * 60000));
    r.conn.close();
    Object.assign(R.live, r.out);
    topics = [...topics, ...extra];
  } catch (e) { R.liveError = R.liveError || `follow-up: ${e.message}`; }
}

// ---------- write it up ----------
for (const [t, v] of Object.entries(R.live || {})) {
  if (v.snapshot !== undefined) await fs.writeFile(path.join(dir, 'topics', `${t}.snapshot.json`), JSON.stringify(v.snapshot, null, 1).slice(0, 300000));
}
for (const [t, s] of Object.entries(stats)) {
  await fs.writeFile(path.join(dir, 'topics', `${t}.updates.jsonl`), s.samples.map((x) => JSON.stringify(x).slice(0, 20000)).join('\n') + '\n');
}
const L = [];
L.push(`# F1 live timing probe, ${R.at.slice(0, 16).replace('T', ' ')} UTC`, '');
L.push(`- F1 TV token: ${R.token}`);
L.push(`- Session on the hub: ${R.session ? `${R.session.meeting} · ${R.session.name} (status ${R.session.status || 'unknown'}), path \`${R.session.path}\`` : 'none reported'}`);
L.push(`- Listened for: ${MINUTES} min`);
if (R.liveError) L.push(`- Live hub problem: ${R.liveError}`);
L.push('');
if (R.live) {
  const names = [...new Set([...Object.keys(R.live), ...Object.keys(stats)])];
  const row = (t) => {
    const v = R.live[t] || { answer: '(not asked for; arrived anyway)' };
    const s = stats[t];
    const rate = s && MINUTES ? `${s.n} (${kb(s.bytes)})` : s ? String(s.n) : '0';
    return `| ${t} | ${USED.has(t) ? 'yes' : '**no**'} | ${v.answer}${v.as && v.as !== t ? ` (as ${v.as})` : ''} | ${R.noToken ? R.noToken[t] || '' : 'n/a'} | ${kb(v.bytes)} | ${rate} |`;
  };
  const got = names.filter((t) => R.live[t]?.answer === 'data' || stats[t]?.n);
  const fresh = got.filter((t) => !USED.has(t));
  L.push('## New to the dashboard', '', fresh.length ? fresh.map((t) => `- **${t}**`).join('\n') : 'Nothing new answered.', '');
  L.push('## Live hub, topic by topic', '', '| Topic | Dashboard uses it | Answer | Without token | Snapshot | Updates while listening |', '|---|---|---|---|---|---|');
  L.push(...names.sort((a, b) => (got.includes(b) - got.includes(a)) || a.localeCompare(b)).map(row), '');
  L.push('## What each answering topic looks like', '');
  for (const t of got.sort()) {
    L.push(`### ${t}${USED.has(t) ? '' : ' (new)'}`, '');
    if (R.live[t]?.snapshot !== undefined) L.push('Snapshot:', '```', shape(R.live[t].snapshot), '```');
    if (stats[t]?.samples.length) L.push('An update:', '```', shape(stats[t].samples[stats[t].samples.length - 1]), '```');
    L.push('');
  }
}
if (R.archive) {
  const a = R.archive;
  L.push('## F1\'s archive of the session', '', `Path: \`${a.path || 'none'}\``, '');
  if (a.error) L.push(`Could not read the index: ${a.error}`, '');
  const feeds = Object.entries(a.feeds || {});
  if (feeds.length) {
    L.push('| Feed | Dashboard uses it | Answered on the live hub | Key frame | Full stream |', '|---|---|---|---|---|');
    for (const [name, f] of feeds.sort()) {
      const base = name.replace(/\.z$/, '');
      const used = USED.has(name) || USED.has(`${base}.z`) || USED.has(base);
      const live = R.live ? `${R.live[name]?.answer || R.live[base]?.answer || 'not asked'}${stats[name]?.n ? `, ${stats[name].n} updates` : ''}` : 'n/a';
      L.push(`| ${name} | ${used ? 'yes' : '**no**'} | ${live} | ${f.keyError ? `error: ${f.keyError}` : kb(f.keyBytes)} | ${f.streamInfo?.error ? `error: ${f.streamInfo.error}` : kb(f.streamInfo?.bytes) || 'size unknown'} |`);
    }
    L.push('');
    const unknown = feeds.map(([n]) => n).filter((n) => !CANDIDATES.includes(n));
    if (unknown.length) L.push(`Feeds the archive lists that weren't on this probe's list (asked for afterwards): ${unknown.join(', ')}.`, '');
    for (const [name, f] of feeds.sort()) {
      if (f.shape && !USED.has(name)) L.push(`### Archive: ${name}`, '', '```', f.shape, '```', '');
    }
  }
  if (a.year) {
    L.push('### Season index', '', a.year.error ? `Could not read it: ${a.year.error}`
      : `${a.year.meetings} meetings, ${a.year.sessions} sessions, ${a.year.withPath} with an archive path (these could be imported for replay). Latest: ${a.year.sample.map((s) => `${s.meeting} ${s.name}`).join('; ')}.`, '');
  }
}
await fs.writeFile(path.join(dir, 'report.md'), L.join('\n') + '\n');
console.log(`\nDone. Report: ${path.join(dir, 'report.md')}\nSamples of every topic are next to it in topics/ and archive/.`);
process.exit(0);
