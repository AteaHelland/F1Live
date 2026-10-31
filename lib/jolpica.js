// Championship standings and session results from the Jolpica API (Ergast-compatible),
// cached in memory and on disk so a slow or offline API doesn't break the page.
import fs from 'node:fs/promises';
import path from 'node:path';

const name = (d) => [d?.givenName, d?.familyName].filter(Boolean).join(' ');

export class Jolpica {
  constructor({ dataDir, base = 'https://api.jolpi.ca/ergast/f1' }) {
    this.dir = path.join(dataDir, 'jolpica');
    this.base = base.replace(/\/$/, '');
    this.mem = new Map();
  }

  // GET <base>/<p>?format=json with a time-to-live; serves stale data if the API fails.
  async get(p, ttlMs) {
    const file = path.join(this.dir, `${p.replace(/[^\w-]+/g, '_')}.json`);
    let hit = this.mem.get(p);
    if (!hit) {
      try { hit = JSON.parse(await fs.readFile(file, 'utf8')); this.mem.set(p, hit); } catch {}
    }
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    try {
      const res = await fetch(`${this.base}/${p}/?format=json&limit=100`, {
        headers: { 'User-Agent': 'f1-home-dashboard/1.0' }, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()).MRData;
      hit = { at: Date.now(), data };
      this.mem.set(p, hit);
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(hit));
      return data;
    } catch (e) {
      if (hit) return hit.data;
      throw new Error(`Jolpica: ${e.message}`);
    }
  }

  async standings() {
    const [d, c] = await Promise.all([
      this.get('current/driverstandings', 20 * 60000),
      this.get('current/constructorstandings', 20 * 60000),
    ]);
    const dl = d?.StandingsTable?.StandingsLists?.[0];
    const cl = c?.StandingsTable?.StandingsLists?.[0];
    return {
      season: Number(dl?.season || cl?.season) || null,
      round: Number(dl?.round || cl?.round) || 0,
      drivers: (dl?.DriverStandings || []).map((s) => ({
        pos: Number(s.position) || null, points: Number(s.points) || 0, wins: Number(s.wins) || 0,
        code: s.Driver?.code || '', number: s.Driver?.permanentNumber || '', name: name(s.Driver),
        team: s.Constructors?.[s.Constructors.length - 1]?.name || '',
      })),
      teams: (cl?.ConstructorStandings || []).map((s) => ({
        pos: Number(s.position) || null, points: Number(s.points) || 0, wins: Number(s.wins) || 0,
        name: s.Constructor?.name || '',
      })),
    };
  }

  async season(year) {
    const d = await this.get(`${year}/races`, 6 * 3600000);
    const now = Date.now();
    return {
      season: Number(year),
      races: (d?.RaceTable?.Races || []).map((r) => {
        const start = new Date(`${r.date}T${r.time || '12:00:00Z'}`).getTime();
        return {
          round: Number(r.round), name: r.raceName, date: r.date,
          hasSprint: Boolean(r.Sprint), done: start + 2 * 3600000 < now,
        };
      }),
    };
  }

  async results(year, round, kind) {
    const p = { race: 'results', sprint: 'sprint', qualifying: 'qualifying' }[kind];
    if (!p) throw new Error('bad kind');
    // Fresh results can still change (penalties), older ones are settled.
    const d = await this.get(`${year}/${round}/${p}`, 30 * 60000);
    const race = d?.RaceTable?.Races?.[0];
    if (!race) return { season: Number(year), round: Number(round), kind, rows: [] };
    const rows = (race.Results || race.SprintResults || race.QualifyingResults || []).map((r) => ({
      pos: r.position ? Number(r.position) : null, posText: r.positionText || r.position || '',
      code: r.Driver?.code || '', number: r.number || '', name: name(r.Driver),
      team: r.Constructor?.name || '', grid: r.grid != null ? Number(r.grid) : null,
      laps: r.laps != null ? Number(r.laps) : null, status: r.status || '',
      time: r.Time?.time || '', points: r.points != null ? Number(r.points) : null,
      fastest: r.FastestLap?.rank === '1', fastestTime: r.FastestLap?.Time?.time || '',
      q1: r.Q1 || '', q2: r.Q2 || '', q3: r.Q3 || '',
    }));
    return { season: Number(year), round: Number(round), kind, name: race.raceName, date: race.date, rows };
  }
}
