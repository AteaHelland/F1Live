// Season calendar from the Jolpica (Ergast-compatible) API, cached in memory and on disk.
import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.jolpi.ca/ergast/f1';
const TTL = 6 * 3600 * 1000;

// Rough session lengths (minutes), used to tell when a session is on.
const SESSION_DEFS = [
  ['FirstPractice', 'Practice 1', 60],
  ['SecondPractice', 'Practice 2', 60],
  ['ThirdPractice', 'Practice 3', 60],
  ['SprintQualifying', 'Sprint Qualifying', 45],
  ['SprintShootout', 'Sprint Qualifying', 45],
  ['Sprint', 'Sprint', 60],
  ['Qualifying', 'Qualifying', 60],
];

function iso(date, time) {
  if (!date) return null;
  return new Date(`${date}T${time || '12:00:00Z'}`).toISOString();
}

export function normalizeRaces(races) {
  return races.map((r) => {
    const sessions = [];
    for (const [key, name, mins] of SESSION_DEFS) {
      if (r[key]) sessions.push({ key, name, start: iso(r[key].date, r[key].time), minutes: mins });
    }
    sessions.push({ key: 'Race', name: 'Race', start: iso(r.date, r.time), minutes: 120 });
    sessions.sort((a, b) => a.start.localeCompare(b.start));
    return {
      season: Number(r.season),
      round: Number(r.round),
      name: r.raceName,
      circuit: r.Circuit?.circuitName,
      locality: r.Circuit?.Location?.locality,
      country: r.Circuit?.Location?.country,
      sessions,
    };
  });
}

export function sessionEnd(s) {
  return new Date(s.start).getTime() + s.minutes * 60000;
}

// The weekend that is on now or comes next.
export function nextWeekend(races, now = Date.now()) {
  return races.find((r) => sessionEnd(r.sessions[r.sessions.length - 1]) + 3600000 > now) || null;
}

// True from `before` minutes before any session until `after` minutes after its scheduled end.
export function inLiveWindow(races, now = Date.now(), before = 45, after = 90) {
  for (const r of races) {
    for (const s of r.sessions) {
      const start = new Date(s.start).getTime();
      if (now >= start - before * 60000 && now <= sessionEnd(s) + after * 60000) return true;
    }
  }
  return false;
}

export class Schedule {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'schedule.json');
    this.races = [];
    this.fetchedAt = 0;
    this.error = null;
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.races = saved.races || [];
      this.fetchedAt = saved.fetchedAt || 0;
    } catch {}
    await this.refresh();
  }

  async fetchSeason(year) {
    const res = await fetch(`${API}/${year}/races/?format=json&limit=100`, {
      headers: { 'User-Agent': 'f1-home-dashboard/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
    const j = await res.json();
    return normalizeRaces(j.MRData?.RaceTable?.Races || []);
  }

  async refresh(force = false) {
    if (!force && this.races.length && Date.now() - this.fetchedAt < TTL) return;
    try {
      const year = new Date().getUTCFullYear();
      let races = await this.fetchSeason(year);
      if (!nextWeekend(races)) {
        // Season is over: also pull next year's calendar (may be empty until published).
        try { races = races.concat(await this.fetchSeason(year + 1)); } catch {}
      }
      this.races = races;
      this.fetchedAt = Date.now();
      this.error = null;
      await fs.writeFile(this.file, JSON.stringify({ fetchedAt: this.fetchedAt, races }));
    } catch (e) {
      this.error = e.message;
    }
  }

  view(now = Date.now()) {
    return {
      fetchedAt: this.fetchedAt,
      error: this.error,
      next: nextWeekend(this.races, now),
    };
  }
}
