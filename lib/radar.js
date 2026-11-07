// Rain radar around the circuit, for the weather map.
//
// While a session is on, the server asks RainViewer's free API every few minutes which radar
// frames exist (one every 10 minutes, covering the last two hours) and saves the images around
// the circuit to disk. Each saved frame is announced in the live feed as a "Radar" update, so it
// reaches the page like any other data, is recorded with the session, and shows up at the
// right moment in a replay. The base map (OpenStreetMap data in CARTO's dark style) and
// RainViewer's coverage mask are saved once per circuit.
//
//   data/radar/frames/<unix time>/7-<x>-<y>.png   radar images, one folder per frame
//   data/radar/coverage/7-<x>-<y>.png             where radar exists (clear) and doesn't (black)
//   data/basemap/8-<x>-<y>.png                    base map
//
// State in the feed: Radar = { Loc: { Lat, Lon, Name }, Frames: { "<unix time>": 1, … } }.
import fs from 'node:fs/promises';
import path from 'node:path';
import { radarTiles, baseTiles, RADAR_SIZE } from '../public/radar-geo.js';

const UA = 'f1-home-dashboard/1.0';
const LIST_EVERY = 3 * 60000;   // a new frame appears every 10 minutes
const GAP_MS = 700;             // between radar downloads: RainViewer allows 100 requests a minute
const MAX_AGE = 2.5 * 3600000;  // frames older than this when first seen aren't fetched
const COLOR = 2;                // Universal Blue, the only colour scheme left on the free API
const OPTIONS = '1_0';          // smoothed, no separate snow colours
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const FRAME_RE = /^\d{9,11}$/;
export const TILE_RE = /^(\d{1,2})-(\d{1,4})-(\d{1,4})\.png$/;

async function exists(f) { try { await fs.access(f); return true; } catch { return false; } }

async function writeAtomic(file, buf) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);
}

export class Radar {
  // emit(key, data) pushes a Radar update for session `key`; it returns false when the live
  // feed has moved on to another session. getState() returns the current live state.
  constructor({ dataDir, api, basemap, log = () => {}, emit, getState }) {
    this.root = path.join(dataDir, 'radar');
    this.baseDir = path.join(dataDir, 'basemap');
    this.api = String(api).replace(/\/$/, '');
    this.basemap = basemap;
    this.log = log;
    this.emit = emit;
    this.getState = getState;
    this.list = null;
    this.listAt = 0;
    this.failed = new Map(); // file → failed attempts (gives up after 3)
    this.busy = false;
    this.error = null;
    this.lastFrame = null;
  }

  frameFile(time, t) { return path.join(this.root, 'frames', String(time), `${t.z}-${t.x}-${t.y}.png`); }
  coverageFile(t) { return path.join(this.root, 'coverage', `${t.z}-${t.x}-${t.y}.png`); }
  baseFile(t) { return path.join(this.baseDir, `${t.z}-${t.x}-${t.y}.png`); }

  info() { return { lastFrame: this.lastFrame, error: this.error }; }

  // Download one image unless it's there already. Returns true when the file exists.
  async fetchTo(file, url, { maxAge } = {}) {
    try {
      const st = await fs.stat(file);
      if (!maxAge || Date.now() - st.mtimeMs < maxAge) return true;
    } catch {}
    if ((this.failed.get(file) || 0) >= 3) return false;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 4).toString('hex') !== '89504e47') throw new Error('not a PNG');
      await writeAtomic(file, buf);
      this.failed.delete(file);
      return true;
    } catch (e) {
      this.failed.set(file, (this.failed.get(file) || 0) + 1);
      this.error = `${new URL(url).host}: ${e.message}`;
      return false;
    }
  }

  async fetchList() {
    const res = await fetch(`${this.api}/public/weather-maps.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`radar list HTTP ${res.status}`);
    const j = await res.json();
    if (!/^https?:\/\//.test(j?.host || '')) throw new Error('radar list without an image host');
    this.list = j;
    this.listAt = Date.now();
  }

  // Bring the radar for `target` ({ key, lat, lon, name }) up to date. Safe to call often.
  async tick(target) {
    if (!target || this.busy) return;
    this.busy = true;
    try {
      const have = () => this.getState()?.Radar || {};
      const loc = have().Loc;
      if (!loc || loc.Lat !== target.lat || loc.Lon !== target.lon) {
        if (!this.emit(target.key, { Loc: { Lat: target.lat, Lon: target.lon, Name: target.name || '' } })) return;
      }
      for (const t of baseTiles(target.lat, target.lon)) {
        if (!(await exists(this.baseFile(t)))) {
          await this.fetchTo(this.baseFile(t), this.basemap.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y));
          await sleep(150);
        }
      }
      if (!this.list || Date.now() - this.listAt > LIST_EVERY) await this.fetchList();
      const host = this.list.host.replace(/\/$/, '');
      const tiles = radarTiles(target.lat, target.lon);
      for (const t of tiles) {
        await this.fetchTo(this.coverageFile(t), `${host}/v2/coverage/0/${RADAR_SIZE}/${t.z}/${t.x}/${t.y}/0/0_0.png`, { maxAge: 30 * 86400000 });
      }
      const frames = (this.list.radar?.past || [])
        .filter((f) => FRAME_RE.test(String(f.time)) && typeof f.path === 'string' && Date.now() - f.time * 1000 < MAX_AGE)
        .sort((a, b) => b.time - a.time); // newest first, so the map is current right away
      for (const f of frames) {
        if (have().Frames?.[f.time]) continue;
        let got = 0, lost = 0;
        for (const t of tiles) {
          const file = this.frameFile(f.time, t);
          const already = await exists(file);
          if (await this.fetchTo(file, `${host}${f.path}/${RADAR_SIZE}/${t.z}/${t.x}/${t.y}/${COLOR}/${OPTIONS}.png`)) got++;
          else if ((this.failed.get(file) || 0) >= 3) lost++;
          if (!already) await sleep(GAP_MS);
        }
        // Announce a frame once it's complete, or as complete as it will get.
        if (got && got + lost === tiles.length) {
          if (!this.emit(target.key, { Frames: { [f.time]: 1 } })) return;
          this.lastFrame = f.time;
          this.error = null;
        }
      }
    } catch (e) {
      this.error = e.message;
      this.log('radar:', e.message);
    } finally {
      this.busy = false;
    }
  }

  // Remove radar frames from before `cutoff` (ms).
  async prune(cutoff) {
    const dir = path.join(this.root, 'frames');
    let n = 0;
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (FRAME_RE.test(name) && Number(name) * 1000 < cutoff) {
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
        n++;
      }
    }
    if (n) this.log(`removed ${n} old radar frames`);
  }

  // Path of a stored image for the HTTP server, or null. kind: frame | coverage | base.
  fileFor(kind, frame, name) {
    const m = TILE_RE.exec(String(name || ''));
    if (!m) return null;
    const t = { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
    if (kind === 'base') return this.baseFile(t);
    if (kind === 'coverage') return this.coverageFile(t);
    if (kind === 'frame' && FRAME_RE.test(String(frame || ''))) return this.frameFile(frame, t);
    return null;
  }
}
