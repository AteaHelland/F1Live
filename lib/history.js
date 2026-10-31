// Per-session history the live feed doesn't keep for us: each driver's gap to the leader
// at the end of every lap (race trace), weather samples, track-status changes, pit stops
// and each driver's best speed at every speed trap.
// Only the current session is kept; it starts over when a new session begins.
import { sessionKey } from '../public/merge.js';

const MAX_ENTRIES = 6000;

// "+1.234" → 1.234; leader → 0; lapped ("1L") or unknown → null.
export function parseGap(line) {
  if (!line) return null;
  if (String(line.Position) === '1') return 0;
  const m = /^\+?(\d+(?:\.\d+)?)$/.exec(String(line.GapToLeader ?? '').trim());
  return m ? Number(m[1]) : null;
}

export class History {
  constructor(saved) {
    this.key = saved?.key || null;
    this.entries = Array.isArray(saved?.entries) ? saved.entries : [];
    this.laps = {};
    this.pits = {};
    this.speeds = {};
    for (const e of this.entries) this.track(e);
  }

  // Keep the lookup tables in step with the entries.
  track(e) {
    if (e.k === 'lap') this.laps[e.n] = Math.max(this.laps[e.n] || 0, e.lap);
    else if (e.k === 'pit') this.pits[`${e.n}|${e.lap}`] = true;
    else if (e.k === 'spd') {
      const b = (this.speeds[e.n] ||= {});
      b[e.trap] = Math.max(b[e.trap] || 0, e.v);
    }
  }

  toJSON() { return { key: this.key, entries: this.entries }; }

  reset(key) {
    this.key = key;
    this.entries = [];
    this.laps = {};
    this.pits = {};
    this.speeds = {};
  }

  add(entry, out) {
    this.entries.push(entry);
    this.track(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    out.push(entry);
  }

  leaderLap(state) {
    let lap = 0;
    for (const l of Object.values(state.TimingData?.Lines || {})) lap = Math.max(lap, Number(l?.NumberOfLaps) || 0);
    return lap;
  }

  weather(t, state, out) {
    const w = state.WeatherData;
    if (!w) return;
    const last = [...this.entries].reverse().find((e) => e.k === 'wx');
    const e = {
      t, s: this.key, k: 'wx',
      air: Number(w.AirTemp), track: Number(w.TrackTemp), hum: Number(w.Humidity),
      wind: Number(w.WindSpeed), dir: Number(w.WindDirection), rain: w.Rainfall === '1' || w.Rainfall === 1,
    };
    if (last && last.air === e.air && last.track === e.track && last.wind === e.wind && last.rain === e.rain && t - last.t < 50000) return;
    this.add(e, out);
  }

  // Call after `item` has been applied to `state`. Returns the entries it added.
  observe(item, state) {
    const out = [];
    const key = sessionKey(state);
    if (item.kind === 'snap') {
      if (key !== this.key) this.reset(key);
      // Baseline the lap counts so a reconnect mid-session doesn't log stale laps.
      for (const [num, l] of Object.entries(state.TimingData?.Lines || {})) {
        const n = Number(l?.NumberOfLaps) || 0;
        if (n > (this.laps[num] || 0)) this.laps[num] = n;
      }
      for (const [num, l] of Object.entries(state.TimingData?.Lines || {})) {
        for (const [trap, sp] of Object.entries(l?.Speeds || {})) {
          const v = Number(sp?.Value);
          if (v > 0 && v > (this.speeds[num]?.[trap] || 0)) this.add({ t: item.t, s: this.key, k: 'spd', n: num, trap, v }, out);
        }
      }
      this.weather(item.t, state, out);
      return out;
    }
    if (item.topic === 'SessionInfo' && key !== this.key) this.reset(key);
    if (!this.key) return out;

    if (item.topic === 'TimingData') {
      for (const [num, upd] of Object.entries(item.data?.Lines || {})) {
        for (const [trap, sp] of Object.entries(upd?.Speeds || {})) {
          const v = Number(sp?.Value);
          if (v > 0 && v > (this.speeds[num]?.[trap] || 0)) this.add({ t: item.t, s: this.key, k: 'spd', n: num, trap, v }, out);
        }
        if (upd?.NumberOfLaps == null) continue;
        const n = Number(upd.NumberOfLaps);
        if (!(n > (this.laps[num] || 0))) continue;
        this.laps[num] = n;
        const line = state.TimingData?.Lines?.[num];
        this.add({
          t: item.t, s: this.key, k: 'lap', n: num, lap: n,
          gap: parseGap(line), pos: Number(line?.Position) || null,
          time: line?.LastLapTime?.Value || null,
        }, out);
      }
    } else if (item.topic === 'PitLaneTimeCollection') {
      // { PitTimes: { "44": { RacingNumber, Duration: "22.6", Lap: "21" } } }: time in the pit lane.
      for (const [num, p] of Object.entries(item.data?.PitTimes || {})) {
        if (num === '_deleted' || !p?.Duration || !p?.Lap) continue;
        if (this.pits[`${num}|${Number(p.Lap)}`]) continue;
        this.add({ t: item.t, s: this.key, k: 'pit', n: num, lap: Number(p.Lap), dur: Number(p.Duration) }, out);
      }
    } else if (item.topic === 'WeatherData') {
      this.weather(item.t, state, out);
    } else if (item.topic === 'TrackStatus' && item.data?.Status) {
      this.add({ t: item.t, s: this.key, k: 'ts', status: String(item.data.Status), lap: this.leaderLap(state) }, out);
    }
    return out;
  }
}
