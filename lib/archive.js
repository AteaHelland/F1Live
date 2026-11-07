// Every session is kept in its own folder, so earlier sessions can be opened again and one
// session's drivers never mix with the next:
//
//   data/sessions/2026/R20 - Interlagos/P1/
//     info.json     what the session is (shown in the session picker)
//     state.json    the live-timing state as it ended
//     history.json  lap gaps, sectors, pit stops, weather, track status, speed traps
import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionKey } from '../public/merge.js';

// Short folder names for each kind of session.
const CODES = {
  'Practice 1': 'P1', 'Practice 2': 'P2', 'Practice 3': 'P3',
  'Sprint Qualifying': 'SQ', 'Sprint Shootout': 'SQ', Sprint: 'S',
  Qualifying: 'Q', Race: 'R',
};
const ORDER = ['P1', 'P2', 'P3', 'SQ', 'S', 'Q', 'R'];

const clean = (s) => String(s ?? '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();

// "2026-11-06T11:30:00" + "-03:00:00" → the session start in UTC (ms).
export function startUtc(si) {
  if (!si?.StartDate) return null;
  const local = Date.parse(`${String(si.StartDate).replace(/Z$|[+-]\d\d:?\d\d$/, '')}Z`);
  if (Number.isNaN(local)) return null;
  const m = /^(-)?(\d+):(\d+)/.exec(String(si.GmtOffset || '0:0'));
  const off = m ? (Number(m[2]) * 60 + Number(m[3])) * 60000 * (m[1] ? -1 : 1) : 0;
  return local - off;
}

// The calendar race and session this feed session belongs to.
function match(races, start) {
  if (start == null) return {};
  let best = null;
  for (const r of races || []) {
    for (const s of r.sessions || []) {
      const d = Math.abs(new Date(s.start).getTime() - start);
      if (d < 3 * 3600000 && (!best || d < best.d)) best = { d, race: r, session: s };
    }
  }
  if (best) return best;
  // Session moved or the calendar is off: settle for the race weekend it falls in.
  for (const r of races || []) {
    const times = (r.sessions || []).map((s) => new Date(s.start).getTime());
    if (times.length && start > Math.min(...times) - 2 * 86400000 && start < Math.max(...times) + 86400000) return { race: r };
  }
  return {};
}

// Describe a session: { year, round, circuit, code, name, meeting, start, dir }.
export function describe(state, races) {
  const si = state?.SessionInfo;
  if (!si?.Name) return null;
  const start = startUtc(si);
  const { race, session } = match(races, start);
  const year = race?.season || Number(String(si.StartDate || si.Path || '').slice(0, 4)) || new Date().getUTCFullYear();
  const round = race?.round || Number(si.Meeting?.Number) || null;
  const circuit = clean(si.Meeting?.Circuit?.ShortName || race?.locality || si.Meeting?.Location || si.Meeting?.Name) || 'Unknown';
  // The calendar's name wins: the feed has labelled practice as the race before.
  const name = session?.name || si.Name;
  const code = CODES[name] || CODES[si.Name] || clean(name);
  const weekend = round ? `R${String(round).padStart(2, '0')} - ${circuit}` : circuit;
  return {
    key: sessionKey(state), year, round, circuit, code, name,
    meeting: si.Meeting?.Name || race?.name || '', start: start ? new Date(start).toISOString() : null,
    dir: path.join(String(year), weekend, code),
  };
}

export class Archive {
  constructor({ dataDir, getRaces }) {
    this.root = path.join(dataDir, 'sessions');
    this.getRaces = getRaces;
    this.dirs = new Map(); // session key → folder, once chosen
    this.sizes = new Map(); // folder → history entries last written there
  }

  // Where a session goes. If that folder already holds a different session (the same
  // session restarted under a new key, say), the new one gets "P1 (2)" and so on.
  async folderFor(info) {
    if (this.dirs.has(info.key)) return this.dirs.get(info.key);
    for (let i = 1; i < 10; i++) {
      const dir = i === 1 ? info.dir : `${info.dir} (${i})`;
      let other = null;
      try { other = JSON.parse(await fs.readFile(path.join(this.root, dir, 'info.json'), 'utf8')); } catch {}
      if (!other || other.key === info.key) {
        this.dirs.set(info.key, dir);
        return dir;
      }
    }
    throw new Error(`no free folder for ${info.dir}`);
  }

  // Write a session's state and history to its folder. Pass strings (already serialised) when
  // the caller is about to change the objects.
  async save(state, history) {
    const st = typeof state === 'string' ? JSON.parse(state) : state;
    const info = describe(st, this.getRaces());
    if (!info || String(st.SessionInfo?.Path || '').startsWith('demo')) return null;
    const dir = await this.folderFor(info);
    const abs = path.join(this.root, dir);
    // Never replace a session's data with less of it (a reconnect that only got part of it).
    const hi = typeof history === 'string' ? JSON.parse(history) : history;
    const n = hi?.entries?.length || 0;
    if (!this.sizes.has(dir)) {
      try { this.sizes.set(dir, JSON.parse(await fs.readFile(path.join(abs, 'history.json'), 'utf8')).entries?.length || 0); }
      catch { this.sizes.set(dir, 0); }
    }
    if (n < this.sizes.get(dir)) return dir;
    this.sizes.set(dir, n);
    await fs.mkdir(abs, { recursive: true });
    const write = async (name, body) => {
      const tmp = path.join(abs, `.${name}.tmp`);
      await fs.writeFile(tmp, typeof body === 'string' ? body : JSON.stringify(body));
      await fs.rename(tmp, path.join(abs, name));
    };
    await write('state.json', state);
    await write('history.json', history);
    const { dir: _, ...rest } = info;
    await write('info.json', { ...rest, savedAt: new Date().toISOString() });
    return dir;
  }

  // Every saved session, newest first.
  async list() {
    const out = [];
    const walk = async (rel, depth) => {
      let ents = [];
      try { ents = await fs.readdir(path.join(this.root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const r = path.join(rel, e.name);
        if (depth < 2) { await walk(r, depth + 1); continue; }
        try {
          const info = JSON.parse(await fs.readFile(path.join(this.root, r, 'info.json'), 'utf8'));
          let bytes = 0;
          for (const f of await fs.readdir(path.join(this.root, r)).catch(() => [])) {
            if (/^feed(-\d+)?\.jsonl\.gz$/.test(f)) bytes += (await fs.stat(path.join(this.root, r, f)).catch(() => ({ size: 0 }))).size;
          }
          out.push({ id: r.split(path.sep).join('/'), ...info, recorded: bytes > 0, recordingBytes: bytes });
        } catch {}
      }
    };
    await walk('', 0);
    const rank = (s) => ORDER.indexOf(s.code) === -1 ? 9 : ORDER.indexOf(s.code);
    return out.sort((a, b) => (b.start || '').localeCompare(a.start || '') || rank(b) - rank(a));
  }

  // A session id ("2026/R20 - Interlagos/P1") to its folder, checked to stay inside sessions/.
  resolve(id) {
    const parts = String(id || '').split('/');
    if (parts.length !== 3 || parts.some((p) => !p || p === '.' || p === '..' || p !== clean(p))) throw new Error('bad session id');
    const abs = path.join(this.root, ...parts);
    if (!abs.startsWith(this.root + path.sep)) throw new Error('bad session id');
    return { id: parts.join('/'), abs };
  }

  async load(sid) {
    const { id, abs } = this.resolve(sid);
    const [info, state, history] = await Promise.all(['info.json', 'state.json', 'history.json']
      .map(async (f) => JSON.parse(await fs.readFile(path.join(abs, f), 'utf8'))));
    const rec = await fs.stat(path.join(abs, 'feed.jsonl.gz')).catch(() => null);
    return { id, info: { ...info, recorded: Boolean(rec?.size) }, state, history };
  }
}
