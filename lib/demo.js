// Demo mode: a fake race that emits data in the same shape as F1's live-timing feed,
// so the page can be tried out (and tested) when no session is running.
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { deepMerge, clone } from '../public/merge.js';
import { normalize } from './livetiming.js';

const TEAMS = [
  ['Aurora Racing', 'E8002D'], ['Fjord GP', '00A3E0'], ['Polar Motorsport', 'FF8000'],
  ['Viking Speed', '27F4D2'], ['Nordlys F1', '229971'], ['Midnight Sun', 'FFD700'],
  ['Glacier Works', '6692FF'], ['Troll Racing', 'B6BABD'], ['Saga Engineering', '52E252'],
  ['Kraken Team', 'C92D4B'],
];
const NAMES = [
  'Max Arendt', 'Lars Okafor', 'Ines Varga', 'Theo Lindqvist', 'Sami Haddad',
  'Jonas Brekke', 'Mia Castell', 'Ola Nakamura', 'Ruben Duarte', 'Kai Strand',
  'Erik Moreau', 'Nils Petrov', 'Leo Fontaine', 'Ida Sørlie', 'Aron Vidal',
  'Hugo Lambert', 'Emil Grieg', 'Tomas Riva', 'Oskar Beck', 'Felix Ndiaye',
];
const NUMBERS = [3, 7, 9, 11, 14, 16, 19, 21, 23, 27, 31, 33, 41, 44, 51, 55, 63, 72, 81, 88];
const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD'];

const LAP = 62; // seconds per lap (a bit quicker than real so stints change in a demo)
const TOTAL_LAPS = 40;

export function demoTrackPoint(f) {
  const a = 2 * Math.PI * f;
  return {
    x: Math.round(5200 * Math.cos(a) + 1400 * Math.cos(3 * a) - 600 * Math.sin(2 * a)),
    y: Math.round(3000 * Math.sin(a) + 900 * Math.sin(2 * a)),
  };
}

export function demoCircuit() {
  const x = [], y = [];
  for (let i = 0; i <= 400; i++) {
    const p = demoTrackPoint(i / 400);
    x.push(p.x); y.push(p.y);
  }
  const corners = [0.08, 0.2, 0.33, 0.45, 0.6, 0.72, 0.86].map((f, i) => ({
    number: i + 1, trackPosition: demoTrackPoint(f),
  }));
  const marshalSectors = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, trackPosition: demoTrackPoint(i / 20) }));
  return { x, y, rotation: 0, corners, marshalSectors, circuitName: 'Demo Ring' };
}

// Championship standings for the made-up demo grid, so live points projections can be tried.
export function demoStandings() {
  const drivers = NUMBERS.map((num, i) => ({
    code: NAMES[i].split(' ')[1].slice(0, 3).toUpperCase(), number: String(num), name: NAMES[i],
    team: TEAMS[Math.floor(i / 2)][0], wins: Math.max(0, 6 - i), points: Math.max(0, 352 - i * 19 - ((i * 37) % 13)),
  })).sort((a, b) => b.points - a.points).map((d, i) => ({ ...d, pos: i + 1 }));
  const teams = {};
  for (const d of drivers) {
    const t = (teams[d.team] ||= { name: d.team, points: 0, wins: 0 });
    t.points += d.points; t.wins += d.wins;
  }
  return {
    season: new Date().getUTCFullYear(), round: 19, demo: true, drivers,
    teams: Object.values(teams).sort((a, b) => b.points - a.points).map((t, i) => ({ ...t, pos: i + 1 })),
  };
}

// A short crackly "radio" clip (WAV) to stand in for team radio in demo mode.
let radioWav = null;
export function demoRadioWav() {
  if (radioWav) return radioWav;
  const rate = 8000, secs = 2.2, n = Math.floor(rate * secs);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 20, (secs - t) * 20);
    const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.5 * t); // speech-like rhythm
    const voice = Math.sin(2 * Math.PI * (180 + 60 * Math.sin(2 * Math.PI * 1.3 * t)) * t) * syll;
    const v = env * (0.45 * voice + 0.12 * rnd() + (t < 0.08 || t > secs - 0.08 ? 0.5 * rnd() : 0));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 20000), 44 + i * 2);
  }
  radioWav = buf;
  return buf;
}

// Rough speed (km/h) at a point on the demo track: fast straights, slow corners.
const CORNERS = [0.08, 0.2, 0.33, 0.45, 0.6, 0.72, 0.86];
const CORNER_SPEED = [95, 160, 120, 210, 85, 140, 180];
function demoSpeed(f) {
  let v = 322;
  CORNERS.forEach((c, i) => {
    let d = f - c;
    d -= Math.round(d);
    const k = d < 0 ? 0.035 : 0.05; // brake late and short, accelerate out over a longer stretch
    v = Math.min(v, CORNER_SPEED[i] + (322 - CORNER_SPEED[i]) * (1 - Math.exp(-((d / k) ** 2))));
  });
  return v;
}

export function demoSchedule(now = Date.now()) {
  const h = 3600000;
  const at = (offsetH) => new Date(now + offsetH * h).toISOString();
  return {
    fetchedAt: now,
    error: null,
    next: {
      season: new Date(now).getUTCFullYear(), round: 99, name: 'Demo Grand Prix',
      circuit: 'Demo Ring', locality: 'Nowhere', country: 'Demo',
      sessions: [
        { key: 'FirstPractice', name: 'Practice 1', start: at(-49), minutes: 60 },
        { key: 'SprintQualifying', name: 'Sprint Qualifying', start: at(-45), minutes: 45 },
        { key: 'Sprint', name: 'Sprint', start: at(-26), minutes: 60 },
        { key: 'Qualifying', name: 'Qualifying', start: at(-22), minutes: 60 },
        { key: 'Race', name: 'Race', start: at(-0.3), minutes: 120 },
      ],
    },
  };
}

const jitter = (s) => s + (Math.random() - 0.5) * 0.45;
const fmtLap = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const fmtSec = (s) => s.toFixed(3);

export class RaceSimulator extends EventEmitter {
  constructor() {
    super();
    this.state = {};
    this.t = 0;
    this.drivers = NUMBERS.map((num, i) => ({
      num: String(num),
      tla: NAMES[i].split(' ')[1].slice(0, 3).toUpperCase(),
      name: NAMES[i],
      team: TEAMS[Math.floor(i / 2)],
      pace: 1 + i * 0.0025 + Math.random() * 0.004,
      progress: -i * 0.012,
      lapStart: 0, secStart: 0, sector: 0,
      best: Infinity, bestSec: [Infinity, Infinity, Infinity],
      stintLapsAtStart: 0, tyreLife: 14 + Math.floor(Math.random() * 8),
      compound: COMPOUNDS[i % 2], pitUntil: 0, stops: 0, laps: 0,
    }));
    this.overallSec = [Infinity, Infinity, Infinity];
    this.overallBest = Infinity;
    this.trackStatus = '1';
    this.rcCount = 0;
    this.init();
    for (let i = 0, n = Number(process.env.DEMO_FFWD || 1400); i < n; i++) this.tick(0.5, true); // fast-forward a few laps
  }

  emitRaw(topic, data, silent) {
    const n = normalize(topic, data);
    if (n) this.state[n[0]] = n[0] === 'Position' || n[0] === 'CarData' ? n[1] : deepMerge(this.state[n[0]], n[1]);
    if (!silent) this.emit('raw', topic, data);
  }

  init() {
    const dl = {};
    this.drivers.forEach((d, i) => {
      dl[d.num] = {
        RacingNumber: d.num, Tla: d.tla, FullName: d.name, BroadcastName: d.name.toUpperCase(),
        TeamName: d.team[0], TeamColour: d.team[1], Line: i + 1,
      };
    });
    const now = new Date().toISOString();
    this.emitRaw('SessionInfo', {
      Meeting: { Name: 'Demo Grand Prix', Location: 'Nowhere', Country: { Name: 'Demo' },
        Circuit: { Key: 0, ShortName: 'Demo Ring' } },
      Name: 'Race', Type: 'Race', StartDate: now, GmtOffset: '00:00:00', Path: 'demo/',
    }, true);
    this.emitRaw('SessionStatus', { Status: 'Started' }, true);
    this.emitRaw('DriverList', dl, true);
    this.emitRaw('TrackStatus', { Status: '1', Message: 'AllClear' }, true);
    this.emitRaw('LapCount', { CurrentLap: 1, TotalLaps: TOTAL_LAPS }, true);
    this.emitRaw('WeatherData', this.weatherNow(), true);
    this.emitRaw('RaceControlMessages', { Messages: [{ Utc: now, Category: 'Flag', Flag: 'GREEN', Message: 'GREEN LIGHT - PIT EXIT OPEN' }] }, true);
    const lines = {}, app = {};
    this.drivers.forEach((d, i) => {
      lines[d.num] = {
        Position: String(i + 1), Line: i + 1, NumberOfLaps: 0, NumberOfPitStops: 0,
        GapToLeader: '', IntervalToPositionAhead: { Value: '' }, InPit: false, PitOut: false,
        Retired: false, Stopped: false, LastLapTime: { Value: '' }, BestLapTime: { Value: '' },
        Sectors: [{ Value: '' }, { Value: '' }, { Value: '' }],
      };
      app[d.num] = { RacingNumber: d.num, Line: i + 1, Stints: [{ Compound: d.compound, New: 'true', TotalLaps: 0, StartLaps: 0 }] };
    });
    this.emitRaw('TimingData', { Lines: lines }, true);
    this.emitRaw('TimingAppData', { Lines: app }, true);
  }

  weatherNow() {
    const t = this.t;
    const r = (x) => x.toFixed(1);
    return {
      AirTemp: r(21.4 + 0.6 * Math.sin(t / 900)), TrackTemp: r(34.8 + 2.4 * Math.sin(t / 600) - t / 2000),
      Humidity: r(48 + 4 * Math.sin(t / 700)), Pressure: '1012.4', Rainfall: '0',
      WindSpeed: r(1.9 + 1.2 * Math.abs(Math.sin(t / 300))), WindDirection: String(Math.round((210 + 40 * Math.sin(t / 500) + 360) % 360)),
    };
  }

  statusAt(t) {
    const c = t % 420;
    if (c >= 70 && c < 85) return ['2', 'Yellow'];
    if (c >= 160 && c < 215) return ['4', 'SCDeployed'];
    if (c >= 280 && c < 300) return ['6', 'VSCDeployed'];
    if (c >= 300 && c < 306) return ['7', 'VSCEnding'];
    return ['1', 'AllClear'];
  }

  rc(message, extra = {}, silent) {
    const i = String(++this.rcCount);
    this.emitRaw('RaceControlMessages', { Messages: { [i]: { Utc: new Date().toISOString(), Category: 'Other', Message: message, ...extra } } }, silent);
  }

  tick(dt = 0.5, silent = false) {
    this.t += dt;
    const [code, msg] = this.statusAt(this.t);
    if (code !== this.trackStatus) {
      this.trackStatus = code;
      const wasYellow = this.trackStatus === '2';
      this.trackStatus = code;
      this.emitRaw('TrackStatus', { Status: code, Message: msg }, silent);
      if (wasYellow) {
        this.rc(`CLEAR IN TRACK SECTOR ${this.yellowSector}`, { Category: 'Flag', Flag: 'CLEAR', Scope: 'Sector', Sector: this.yellowSector }, silent);
      }
      if (code === '2') {
        this.yellowSector = 2 + Math.floor(Math.random() * 17);
        const dbl = Math.random() < 0.35;
        const flag = dbl ? 'DOUBLE YELLOW' : 'YELLOW';
        this.rc(`${flag} IN TRACK SECTOR ${this.yellowSector}`, { Category: 'Flag', Flag: flag, Scope: 'Sector', Sector: this.yellowSector }, silent);
      } else {
        const texts = { '1': ['TRACK CLEAR', 'GREEN'], '4': ['SAFETY CAR DEPLOYED', null],
          '6': ['VIRTUAL SAFETY CAR DEPLOYED', null], '7': ['VIRTUAL SAFETY CAR ENDING', null] };
        const [m, flag] = texts[code];
        this.rc(m, flag ? { Category: 'Flag', Flag: flag, Scope: 'Track' } : { Category: 'SafetyCar' }, silent);
      }
    }
    const slow = { '4': 0.55, '6': 0.65, '7': 0.65, '2': 0.95 }[code] || 1;
    const lines = {}, app = {};
    const leaderLap = Math.max(...this.drivers.map((d) => Math.floor(d.progress)));

    for (const d of this.drivers) {
      const wear = 1 + (d.laps - d.stintLapsAtStart) * 0.0015 + (d.compound === 'HARD' ? 0.004 : d.compound === 'MEDIUM' ? 0.002 : 0);
      const lapTime = LAP * d.pace * wear * (0.995 + Math.random() * 0.01);
      if (this.t < d.pitUntil) continue; // stationary in the pit box
      if (d.inPit) {
        d.inPit = false;
        lines[d.num] = { InPit: false, PitOut: true };
      }
      const before = d.progress;
      d.progress += (dt / lapTime) * slow;
      if (before < 0) continue;
      const secBefore = Math.floor((before % 1) * 3);
      const secAfter = Math.floor((d.progress % 1) * 3);
      const lapDone = Math.floor(d.progress) > Math.floor(before);
      if (secAfter !== secBefore || lapDone) {
        const s = secBefore;
        const time = jitter(this.t - d.secStart);
        d.secStart = this.t;
        const pb = time < d.bestSec[s];
        const ob = time < this.overallSec[s];
        if (pb) d.bestSec[s] = time;
        if (ob) this.overallSec[s] = time;
        const L = (lines[d.num] ||= {});
        L.Sectors = { ...(L.Sectors || {}), [s]: { Value: fmtSec(time), PersonalFastest: pb, OverallFastest: ob } };
        if (s === 0) { L.Sectors[1] = { Value: '' }; L.Sectors[2] = { Value: '' }; }
        if (s === 0 && L.PitOut === undefined) L.PitOut = false;
      }
      if (lapDone) {
        const time = jitter(this.t - d.lapStart);
        d.lapStart = this.t;
        d.laps++;
        const pb = time < d.best;
        const ob = time < this.overallBest;
        if (pb) d.best = time;
        if (ob) this.overallBest = time;
        const L = (lines[d.num] ||= {});
        L.NumberOfLaps = d.laps;
        L.LastLapTime = { Value: fmtLap(time), PersonalFastest: pb, OverallFastest: ob };
        if (pb) L.BestLapTime = { Value: fmtLap(time) };
        const stints = this.state.TimingAppData.Lines[d.num].Stints;
        const idx = (Array.isArray(stints) ? stints.length : Object.keys(stints).length) - 1;
        app[d.num] = { Stints: { [idx]: { TotalLaps: d.laps - d.stintLapsAtStart } } };
        // Pit when the tyres are done.
        if (d.laps - d.stintLapsAtStart >= d.tyreLife && d.laps < TOTAL_LAPS - 3) {
          d.inPit = true;
          d.pitUntil = this.t + 3;
          d.progress -= 18 / lapTime;
          d.stops++;
          d.stintLapsAtStart = d.laps;
          d.compound = COMPOUNDS[(COMPOUNDS.indexOf(d.compound) + 1 + Math.floor(Math.random() * 2)) % 3];
          d.tyreLife = d.compound === 'SOFT' ? 10 : d.compound === 'MEDIUM' ? 15 : 22;
          Object.assign(L, { InPit: true, NumberOfPitStops: d.stops });
          app[d.num].Stints[idx + 1] = { Compound: d.compound, New: 'true', TotalLaps: 0, StartLaps: 0 };
        }
      }
    }

    // Order, gaps and intervals.
    const order = [...this.drivers].sort((a, b) => b.progress - a.progress);
    const leader = order[0];
    order.forEach((d, i) => {
      const L = (lines[d.num] ||= {});
      L.Position = String(i + 1);
      L.Line = i + 1;
      const lapTime = LAP * d.pace;
      if (i === 0) {
        L.GapToLeader = `LAP ${Math.max(1, Math.floor(leader.progress) + 1)}`;
        L.IntervalToPositionAhead = { Value: L.GapToLeader };
      } else {
        const gapLaps = leader.progress - d.progress;
        L.GapToLeader = gapLaps >= 1 ? `${Math.floor(gapLaps)}L` : `+${fmtSec(gapLaps * lapTime)}`;
        const ahead = order[i - 1].progress - d.progress;
        L.IntervalToPositionAhead = { Value: ahead >= 1 ? `${Math.floor(ahead)}L` : `+${fmtSec(ahead * lapTime)}` };
      }
    });
    this.emitRaw('TimingData', { Lines: lines }, silent);
    if (Object.keys(app).length) this.emitRaw('TimingAppData', { Lines: app }, silent);

    const lap = Math.min(TOTAL_LAPS, Math.max(1, leaderLap + 1));
    if (this.state.LapCount?.CurrentLap !== lap) this.emitRaw('LapCount', { CurrentLap: lap }, silent);

    if (Math.floor(this.t / 30) !== Math.floor((this.t - dt) / 30)) this.emitRaw('WeatherData', this.weatherNow(), silent);
    if (Math.floor(this.t / 23) !== Math.floor((this.t - dt) / 23)) {
      const d = order[Math.floor(Math.random() * Math.min(12, order.length))];
      const tr = this.state.TeamRadio?.Captures;
      const idx = tr ? (Array.isArray(tr) ? tr.length : Object.keys(tr).length) : 0;
      const cap = { Utc: new Date().toISOString(), RacingNumber: d.num, Path: `TeamRadio/${d.tla}_${idx + 1}.mp3` };
      this.emitRaw('TeamRadio', idx ? { Captures: { [idx]: cap } } : { Captures: [cap] }, silent);
    }

    // Car telemetry, compressed like the real CarData.z stream.
    {
      const Cars = {};
      for (const d of this.drivers) {
        const f = ((d.progress % 1) + 1) % 1;
        const inPit = this.t < d.pitUntil;
        const v = inPit ? 0 : demoSpeed(f) * (slow < 1 ? 0.6 + 0.4 * slow : 1) * (0.985 + Math.random() * 0.03);
        const ahead = demoSpeed((f + 0.004) % 1);
        const braking = !inPit && ahead < demoSpeed(f) - 6;
        const gear = v < 5 ? 0 : Math.min(8, 1 + Math.floor(v / 42));
        const rpm = v < 5 ? 4200 : Math.round(9800 + ((v % 42) / 42) * 2400);
        const thr = inPit ? 0 : braking ? 0 : ahead > demoSpeed(f) + 2 ? 100 : Math.round(55 + Math.random() * 45);
        Cars[d.num] = { Channels: { 0: rpm, 2: Math.round(v), 3: gear, 4: thr, 5: braking ? 100 : 0, 45: 0 } };
      }
      const payload = { Entries: [{ Utc: new Date().toISOString(), Cars }] };
      this.emitRaw('CarData.z', zlib.deflateRawSync(JSON.stringify(payload)).toString('base64'), silent);
    }

    // Car positions once a second, compressed like the real Position.z stream.
    if (Math.round(this.t * 2) % 2 === 0) {
      const Entries = {};
      for (const d of this.drivers) {
        const p = demoTrackPoint(((d.progress % 1) + 1) % 1);
        Entries[d.num] = { Status: 'OnTrack', X: p.x, Y: p.y, Z: 0 };
      }
      const payload = { Position: [{ Timestamp: new Date().toISOString(), Entries }] };
      this.emitRaw('Position.z', zlib.deflateRawSync(JSON.stringify(payload)).toString('base64'), silent);
      const remaining = Math.max(0, 7200 - this.t);
      const hh = String(Math.floor(remaining / 3600)).padStart(2, '0');
      const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
      const ss = String(Math.floor(remaining % 60)).padStart(2, '0');
      this.emitRaw('ExtrapolatedClock', { Utc: new Date().toISOString(), Remaining: `${hh}:${mm}:${ss}`, Extrapolating: true }, silent);
    }
  }

  // Full state as the hub's Subscribe result would return it (Position compressed).
  rawSnapshot() {
    const s = clone(this.state);
    const pos = s.Position;
    delete s.Position;
    if (pos) s['Position.z'] = zlib.deflateRawSync(JSON.stringify({ Position: [pos] })).toString('base64');
    delete s.CarData; // the real hub doesn't include car data in the snapshot either
    return s;
  }
}

// Drop-in replacement for LiveTimingClient that plays the simulator.
export class DemoClient extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.positionEnabled = true;
  }
  info() {
    return { status: this.status, lastError: null, lastMessageAt: Date.now(), positionEnabled: true, tokenRejected: false, demo: true };
  }
  start() {
    if (this.timer) return;
    this.sim = new RaceSimulator();
    this.sim.on('raw', (topic, data) => {
      const n = normalize(topic, data);
      if (n) this.emit('update', n[0], n[1]);
    });
    const snap = {};
    for (const [topic, data] of Object.entries(this.sim.rawSnapshot())) {
      const n = normalize(topic, data);
      if (n) snap[n[0]] = n[1];
    }
    this.status = 'connected';
    this.emit('snapshot', snap);
    this.emit('status', this.info());
    const speed = Math.max(1, Number(process.env.DEMO_SPEED) || 1); // >1 runs the fake race faster
    this.timer = setInterval(() => this.sim.tick(0.5 * speed), 500);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.status = 'idle';
  }
  restart() {}
}
