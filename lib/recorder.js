// Records everything the live feed sends, so a session can be rewatched later.
//
// Each session's folder gets a feed.jsonl.gz: one line per item, exactly as the server
// handles them ({ t, kind: 'snap' | 'u', topic, data }). The first line is a full snapshot,
// so a file can be played on its own. Each server start that records the same session again
// writes the next file (feed-2.jsonl.gz, feed-3…), so a file cut short by a hard stop can't
// spoil the ones after it; playback reads them in order and keeps whatever a cut file holds.
//
// Recording starts a few minutes (`leadMin`, default 3) before the session's scheduled start,
// not when the dashboard connects 45 minutes ahead, and a replay starts at that same point.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { applyItem, clone, sessionKey } from '../public/merge.js';
import { describe, startUtc } from './archive.js';

export const FEED_FILE = 'feed.jsonl.gz';
const FEED_RE = /^feed(?:-(\d+))?\.jsonl\.gz$/;

// The recording files of a session folder, in the order they were written.
export async function feedFiles(abs) {
  const names = (await fsp.readdir(abs).catch(() => [])).filter((n) => FEED_RE.test(n));
  return names.sort((a, b) => Number(FEED_RE.exec(a)[1] || 1) - Number(FEED_RE.exec(b)[1] || 1)).map((n) => path.join(abs, n));
}
const KEYFRAME_MS = 60000;
export const LEAD_MIN = 3;

export class Recorder {
  constructor({ archive, getRaces, keepWeekends = 3, leadMin = LEAD_MIN, log = () => {} }) {
    this.archive = archive;
    this.leadMs = leadMin * 60000;
    this.getRaces = getRaces;
    this.keepWeekends = keepWeekends; // 0 = keep every recording
    this.log = log;
    this.key = null;
    this.out = null;      // { gz, file, dir }
    this.pending = null;  // lines waiting while the folder is worked out
    this.flushTimer = setInterval(() => { try { this.out?.gz.flush(); } catch {} }, 5000);
    this.flushTimer.unref();
  }

  // Call after `item` has been applied to `state`.
  record(item, state) {
    const key = sessionKey(state);
    if (!key || String(state.SessionInfo?.Path || '').startsWith('demo')) { if (this.key) this.close(); return; }
    if (key !== this.key) {
      // Not yet: wait until a few minutes before the scheduled start.
      const start = startUtc(state.SessionInfo);
      if (start != null && item.t < start - this.leadMs) { if (this.key) this.close(); return; }
      this.close();
      this.key = key;
      // Start with the whole state (which already includes this item).
      this.pending = [JSON.stringify({ t: item.t, kind: 'snap', data: state })];
      this.open(key, clone(state));
      return;
    }
    this.write(JSON.stringify(item));
  }

  write(line) {
    if (this.pending) this.pending.push(line);
    else if (this.out) this.out.gz.write(line + '\n');
  }

  async open(key, state) {
    try {
      const info = describe(state, this.getRaces());
      if (!info) throw new Error('no session info');
      const dir = await this.archive.folderFor(info);
      if (this.key !== key) return; // the session moved on while we waited
      const abs = path.join(this.archive.root, dir);
      await fsp.mkdir(abs, { recursive: true });
      let file = path.join(abs, FEED_FILE);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(abs, `feed-${n}.jsonl.gz`);
      const gz = zlib.createGzip({ level: 6 });
      const ws = fs.createWriteStream(file, { flags: 'wx' });
      gz.pipe(ws);
      gz.on('error', (e) => this.log('recording error', e.message));
      ws.on('error', (e) => this.log('recording error', e.message));
      this.out = { gz, ws, file, dir };
      for (const l of this.pending) gz.write(l + '\n');
      this.pending = null;
      this.log(`recording ${dir.split(path.sep).join('/')}`);
    } catch (e) {
      this.log('recording not started:', e.message);
      this.pending = null;
    }
  }

  // Finish the current file; then drop recordings beyond the weekends we keep.
  close() {
    const out = this.out;
    this.key = null;
    this.out = null;
    this.pending = null;
    if (!out) return Promise.resolve();
    // Done only once the file itself is closed, not just the compressor.
    return new Promise((resolve) => {
      out.ws.once('close', resolve);
      out.gz.end();
      setTimeout(resolve, 5000);
    }).then(() => this.prune()).catch(() => {});
  }

  async prune() {
    if (!this.keepWeekends) return;
    const weekends = new Map(); // "year/weekend" → latest start
    for (const s of await this.archive.list()) {
      if (!s.recorded) continue;
      const w = s.id.split('/').slice(0, 2).join('/');
      if (!weekends.has(w) || (s.start || '') > weekends.get(w)) weekends.set(w, s.start || '');
    }
    const old = [...weekends].sort((a, b) => b[1].localeCompare(a[1])).slice(this.keepWeekends);
    for (const [w] of old) {
      const abs = path.join(this.archive.root, ...w.split('/'));
      for (const ses of await fsp.readdir(abs).catch(() => [])) {
        for (const f of await feedFiles(path.join(abs, ses))) await fsp.rm(f, { force: true });
      }
      this.log(`removed recordings of ${w} (keeping the last ${this.keepWeekends} weekends)`);
    }
  }
}

// ---------- playback ----------
// A recording is read once into memory: the raw lines, their times, and a full state every
// minute, so any moment can be rebuilt quickly.
// All lines of one file. Node's gzip writer starts every part ("member") with the same
// 10-byte header, so the file is split at those headers and each part is unpacked on its
// own: a part cut short or damaged (a hard stop before recordings got their own files)
// gives what it can, and the parts after it are still read.
const GZ_HEAD = Buffer.from('1f8b0800000000000003', 'hex');

function unpack(part) {
  return new Promise((resolve) => {
    const chunks = [];
    const gz = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    gz.on('data', (c) => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', () => resolve(Buffer.concat(chunks))); // keep what came out before the damage
    gz.end(part);
  });
}

async function readLines(file) {
  const buf = await fsp.readFile(file);
  const starts = [];
  for (let i = buf.indexOf(GZ_HEAD); i >= 0; i = buf.indexOf(GZ_HEAD, i + 1)) starts.push(i);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const text = (await unpack(buf.subarray(starts[k], starts[k + 1] ?? buf.length))).toString('utf8');
    const lines = text.split('\n');
    if (!text.endsWith('\n')) lines.pop(); // a line cut in half
    for (const l of lines) if (l) out.push(l);
  }
  return out;
}

// Moments worth jumping to in a replay: { t, k } with k = start (lights out, or green again
// after a stop), sc, vsc, red, flag (chequered) and, in races, pit (with the car number n).
const TRACK_MARK = { 4: 'sc', 5: 'red', 6: 'vsc' };

async function index(files) {
  const lines = [], times = [], keyframes = [], marks = [];
  let state = {}, lastKey = -Infinity;
  let sesStatus, trackStatus, started = false;
  const all = [];
  for (const f of files) all.push(...(await readLines(f)));
  {
    for (const line of all) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (!item || typeof item.t !== 'number') continue;
      if (item.t - lastKey >= KEYFRAME_MS || item.kind === 'snap') {
        // Keyframe holds the state just before this line.
        keyframes.push({ i: lines.length, t: item.t, state: JSON.stringify(state) });
        lastKey = item.t;
      }
      state = applyItem(state, item);
      lines.push(line);
      times.push(item.t);
      const ss = state.SessionStatus?.Status;
      if (ss !== sesStatus) {
        if (ss === 'Started') { marks.push({ t: item.t, k: 'start' }); started = true; }
        else if (ss === 'Finished' && sesStatus !== undefined) marks.push({ t: item.t, k: 'flag' });
        sesStatus = ss;
      }
      const ts = String(state.TrackStatus?.Status ?? '');
      if (ts !== trackStatus) {
        // VSC ending (7) belongs to the VSC before it; a safety car after a VSC is its own mark.
        if (TRACK_MARK[ts] && trackStatus !== undefined) marks.push({ t: item.t, k: TRACK_MARK[ts] });
        trackStatus = ts;
      }
      if (started && item.kind === 'u' && item.topic === 'TimingData' && state.SessionInfo?.Type === 'Race') {
        for (const [num, l] of Object.entries(item.data?.Lines || {})) {
          if (l?.InPit === true) marks.push({ t: item.t, k: 'pit', n: num });
        }
      }
    }
  }
  return { lines, times: Float64Array.from(times), keyframes, marks, sessionStart: startUtc(state.SessionInfo) };
}

function firstAfter(times, t) { // index of the first line with time > t
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

export class Player {
  constructor({ archive, leadMin = LEAD_MIN }) {
    this.archive = archive;
    this.leadMs = leadMin * 60000;
    this.cache = new Map(); // id → { size, at, idx }
  }

  async get(id) {
    const { abs } = this.archive.resolve(id);
    const files = await feedFiles(abs);
    if (!files.length) throw Object.assign(new Error('no recording'), { code: 'ENOENT' });
    let size = 0;
    for (const f of files) size += (await fsp.stat(f)).size;
    const hit = this.cache.get(id);
    // A recording still growing is re-read at most every 20 seconds.
    if (hit && (hit.size === size || Date.now() - hit.at < 20000)) return hit.idx;
    const idx = await index(files);
    this.cache.delete(id);
    this.cache.set(id, { size, at: Date.now(), idx });
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    return idx;
  }

  // The state at `t` (unless itemsOnly) plus the items after it, up to t + span.
  // Returned as a JSON string built from the raw lines.
  async window(id, t, span, itemsOnly, withMarks) {
    const { lines, times, keyframes, marks, sessionStart } = await this.get(id);
    if (!lines.length) throw new Error('empty recording');
    const end = times[times.length - 1];
    // Replays begin a few minutes before the scheduled start, also in recordings made before
    // recording waited for that (they begin when the dashboard connected, 45 minutes ahead).
    const from0 = sessionStart != null ? sessionStart - this.leadMs : -Infinity;
    const start = from0 > times[0] && from0 < end ? from0 : times[0];
    t = Math.min(Math.max(t, start), end);
    const from = firstAfter(times, t);
    let state = 'null';
    if (!itemsOnly) {
      let k = keyframes[0];
      for (const kf of keyframes) { if (kf.i <= from) k = kf; else break; }
      let s = JSON.parse(k.state);
      for (let i = k.i; i < from; i++) s = applyItem(s, JSON.parse(lines[i]));
      state = JSON.stringify(s);
    }
    const to = firstAfter(times, t + span);
    const m = withMarks ? `"marks":${JSON.stringify(marks.filter((x) => x.t >= start))},` : '';
    return `{"start":${start},"end":${end},"t":${t},"until":${Math.min(t + span, end)},${m}"state":${state},"items":[${lines.slice(from, to).join(',')}]}`;
  }
}
