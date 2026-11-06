// Records everything the live feed sends, so a session can be rewatched later.
//
// Each session's folder gets a feed.jsonl.gz: one line per item, exactly as the server
// handles them ({ t, kind: 'snap' | 'u', topic, data }). The first line is a full snapshot,
// so a file can be played on its own. Every start appends a new gzip member, which gunzip
// reads back as one stream.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { applyItem, clone, sessionKey } from '../public/merge.js';
import { describe } from './archive.js';

export const FEED_FILE = 'feed.jsonl.gz';
const KEYFRAME_MS = 60000;

export class Recorder {
  constructor({ archive, getRaces, keepWeekends = 3, log = () => {} }) {
    this.archive = archive;
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
      const file = path.join(abs, FEED_FILE);
      const gz = zlib.createGzip({ level: 6 });
      gz.pipe(fs.createWriteStream(file, { flags: 'a' }));
      gz.on('error', (e) => this.log('recording error', e.message));
      this.out = { gz, file, dir };
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
    return new Promise((resolve) => {
      out.gz.end(() => resolve());
      setTimeout(resolve, 3000);
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
        await fsp.rm(path.join(abs, ses, FEED_FILE), { force: true });
      }
      this.log(`removed recordings of ${w} (keeping the last ${this.keepWeekends} weekends)`);
    }
  }
}

// ---------- playback ----------
// A recording is read once into memory: the raw lines, their times, and a full state every
// minute, so any moment can be rebuilt quickly.
async function index(file) {
  const lines = [], times = [], keyframes = [];
  let state = {}, lastKey = -Infinity;
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  input.on('error', () => {}); // a file still being written ends mid-member
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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
    }
  } catch {}
  return { lines, times: Float64Array.from(times), keyframes };
}

function firstAfter(times, t) { // index of the first line with time > t
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

export class Player {
  constructor({ archive }) {
    this.archive = archive;
    this.cache = new Map(); // id → { size, at, idx }
  }

  async get(id) {
    const { abs } = this.archive.resolve(id);
    const file = path.join(abs, FEED_FILE);
    const st = await fsp.stat(file);
    const hit = this.cache.get(id);
    // A recording still growing is re-read at most every 20 seconds.
    if (hit && (hit.size === st.size || Date.now() - hit.at < 20000)) return hit.idx;
    const idx = await index(file);
    this.cache.delete(id);
    this.cache.set(id, { size: st.size, at: Date.now(), idx });
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    return idx;
  }

  // The state at `t` (unless itemsOnly) plus the items after it, up to t + span.
  // Returned as a JSON string built from the raw lines.
  async window(id, t, span, itemsOnly) {
    const { lines, times, keyframes } = await this.get(id);
    if (!lines.length) throw new Error('empty recording');
    const start = times[0], end = times[times.length - 1];
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
    return `{"start":${start},"end":${end},"t":${t},"until":${Math.min(t + span, end)},"state":${state},"items":[${lines.slice(from, to).join(',')}]}`;
  }
}
