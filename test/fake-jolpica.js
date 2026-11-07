// A stand-in for the Jolpica API with made-up data, for testing standings and results
// without internet access:  node test/fake-jolpica.js  then  JOLPICA_URL=http://localhost:3099 npm run demo
import http from 'node:http';
import { demoStandings } from '../lib/demo.js';

const PORT = Number(process.env.PORT || 3099);
const year = new Date().getUTCFullYear();
const st = demoStandings();
const drivers = st.drivers.map((d) => ({
  driverId: d.code.toLowerCase(), permanentNumber: d.number, code: d.code,
  givenName: d.name.split(' ')[0], familyName: d.name.split(' ').slice(1).join(' '),
}));
const ctor = (name) => ({ constructorId: name.toLowerCase().replace(/\W+/g, '_'), name });

const races = Array.from({ length: 22 }, (_, i) => {
  const date = new Date(Date.UTC(year, 2, 8 + i * 12)).toISOString().slice(0, 10);
  return {
    season: String(year), round: String(i + 1), raceName: `Test ${['Bahrain', 'Saudi', 'Australian', 'Japanese', 'Chinese', 'Miami', 'Monaco', 'Spanish', 'Canadian', 'Austrian', 'British', 'Belgian', 'Hungarian', 'Dutch', 'Italian', 'Madrid', 'Azerbaijan', 'Singapore', 'US', 'Mexico City', 'Brazilian', 'Abu Dhabi'][i]} Grand Prix`,
    date, time: '14:00:00Z', ...(i % 4 === 1 ? { Sprint: { date, time: '10:00:00Z' } } : {}),
  };
});

// FAKE_PRACTICE_NOW=1: the last race weekend is happening now, with Practice 1 running,
// to test how the page handles a feed that labels practice as the race.
if (process.env.FAKE_PRACTICE_NOW === '1') {
  const d = (ms) => new Date(Date.now() + ms);
  const fp = d(-10 * 60000);
  const race = d(2 * 86400000);
  const today = new Date().toISOString().slice(0, 10);
  const next = races.find((r) => r.date >= today) || races[races.length - 1];
  Object.assign(next, {
    date: race.toISOString().slice(0, 10), time: race.toISOString().slice(11, 19) + 'Z',
    FirstPractice: { date: fp.toISOString().slice(0, 10), time: fp.toISOString().slice(11, 19) + 'Z' },
  });
}

function shuffle(seed) {
  const a = st.drivers.map((_, i) => i);
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const lap = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

function results(round, kind) {
  const order = shuffle(round * 31 + (kind === 'sprint' ? 7 : kind === 'qualifying' ? 3 : 1));
  return order.map((di, pos) => {
    const d = st.drivers[di];
    const base = { number: d.number, position: String(pos + 1), positionText: String(pos + 1), Driver: drivers[di], Constructor: ctor(d.team) };
    if (kind === 'qualifying') {
      const q = 80000 + pos * 120;
      return { ...base, Q1: lap(q + 600), Q2: pos < 15 ? lap(q + 300) : '', Q3: pos < 10 ? lap(q) : '' };
    }
    const dnf = pos >= 18;
    return {
      ...base, positionText: dnf ? 'R' : String(pos + 1), grid: String(((pos * 7) % 20) + 1), laps: dnf ? '31' : pos > 15 ? '56' : '57',
      status: dnf ? 'Retired' : pos > 15 ? '+1 Lap' : 'Finished',
      points: String(kind === 'sprint' ? Math.max(0, 8 - pos) : PTS[pos] || 0),
      ...(pos === 0 ? { Time: { millis: '5520000', time: '1:32:00.123' } } : pos <= 15 && !dnf ? { Time: { time: `+${(pos * 3.217).toFixed(3)}` } } : {}),
      ...(pos === 3 ? { FastestLap: { rank: '1', lap: '44', Time: { time: '1:18.765' } } } : {}),
    };
  });
}

const wrap = (body) => ({ MRData: { xmlns: '', series: 'f1', limit: '100', offset: '0', ...body } });

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/ergast\/f1/, '').replace(/\/$/, '');
  let out = null;
  let m;
  if (p === '/current/driverstandings') {
    out = wrap({ StandingsTable: { season: String(year), StandingsLists: [{ season: String(year), round: '19', DriverStandings: st.drivers.map((d, i) => ({ position: String(d.pos), positionText: String(d.pos), points: String(d.points), wins: String(d.wins), Driver: drivers[i], Constructors: [ctor(d.team)] })) }] } });
  } else if (p === '/current/constructorstandings') {
    out = wrap({ StandingsTable: { season: String(year), StandingsLists: [{ season: String(year), round: '19', ConstructorStandings: st.teams.map((t) => ({ position: String(t.pos), positionText: String(t.pos), points: String(t.points), wins: String(t.wins), Constructor: ctor(t.name) })) }] } });
  } else if ((m = /^\/(\d{4})\/races$/.exec(p))) {
    out = wrap({ RaceTable: { season: m[1], Races: Number(m[1]) === year ? races : [] } });
  } else if ((m = /^\/(\d{4})\/(\d+)\/(results|sprint|qualifying)$/.exec(p))) {
    const race = races[Number(m[2]) - 1];
    const key = { results: 'Results', sprint: 'SprintResults', qualifying: 'QualifyingResults' }[m[3]];
    const kind = { results: 'race', sprint: 'sprint', qualifying: 'qualifying' }[m[3]];
    out = wrap({ RaceTable: { Races: race && (m[3] !== 'sprint' || race.Sprint) ? [{ ...race, [key]: results(Number(m[2]), kind) }] : [] } });
  }
  res.writeHead(out ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out || { error: 'not found' }));
}).listen(PORT, () => console.log(`fake Jolpica on :${PORT}`));
