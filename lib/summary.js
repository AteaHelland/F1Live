// A short summary of a saved session for the front page: who was on top, the fastest lap, who
// gained most from the grid, and how often the race was neutralised.
const lapSecs = (v) => {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(v || '').trim());
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};
const lastValue = (arr) => {
  const a = Array.isArray(arr) ? arr : Object.values(arr || {});
  for (let i = a.length - 1; i >= 0; i--) if (a[i]?.Value) return a[i].Value;
  return '';
};

export function summarize(state, history) {
  const si = state?.SessionInfo;
  if (!si?.Name) return null;
  const drivers = state.DriverList || {};
  const app = state.TimingAppData?.Lines || {};
  const who = (n) => ({ tla: drivers[n]?.Tla || n, color: drivers[n]?.TeamColour || '' });
  const cars = Object.entries(state.TimingData?.Lines || {})
    .filter(([n, l]) => n !== '_deleted' && l && typeof l === 'object')
    .map(([n, l]) => ({ n, l, pos: Number(l.Position) || 99, best: l.BestLapTime?.Value || lastValue(l.BestLapTimes) }));
  if (!cars.length) return null;
  const kind = si.Type === 'Race' ? 'race' : si.Type === 'Qualifying' ? 'qualifying' : 'practice';
  const out = { kind, name: si.Name };

  // Practice is ordered by best lap; the feed's own order isn't reliable there.
  if (kind === 'practice') cars.sort((a, b) => (lapSecs(a.best) ?? 1e9) - (lapSecs(b.best) ?? 1e9));
  else cars.sort((a, b) => a.pos - b.pos);
  out.top = cars.slice(0, 3).map((c) => ({ ...who(c.n), time: kind === 'race' ? '' : c.best }));

  let fl = null;
  for (const c of cars) {
    const s = lapSecs(c.best);
    if (s != null && (!fl || s < fl.s)) fl = { s, n: c.n, time: c.best };
  }
  if (fl) out.fastest = { ...who(fl.n), time: fl.time };

  if (kind === 'race') {
    let best = null;
    for (const c of cars) {
      const grid = Number(app[c.n]?.GridPos);
      if (!(grid > 0) || c.pos === 99 || c.l.Retired || c.l.Stopped) continue;
      const d = grid - c.pos;
      if (d > 0 && (!best || d > best.d)) best = { n: c.n, d, grid, pos: c.pos };
    }
    if (best) out.gainer = { ...who(best.n), places: best.d, grid: best.grid, pos: best.pos };
    out.retired = cars.filter((c) => c.l.Retired || c.l.Stopped).length;
    out.laps = Number(state.LapCount?.CurrentLap) || null;
    // Neutralisations: each time the track status turns to safety car, VSC or red.
    const KIND = { 4: 'sc', 5: 'red', 6: 'vsc', 7: 'vsc' };
    const n = { sc: 0, vsc: 0, red: 0 };
    let prev = null;
    for (const e of history?.entries || []) {
      if (e.k !== 'ts') continue;
      const k = KIND[e.status] || null;
      if (k && k !== prev) n[k]++;
      prev = k;
    }
    Object.assign(out, n);
  }
  return out;
}
