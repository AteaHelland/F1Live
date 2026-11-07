// Hourly forecast for the circuit from MET Norway's Locationforecast, the data behind yr.no.
//
// While a session is on, the server fetches it no more often than MET allows (its Expires
// header, usually about half an hour) and announces it in the live feed as a "Forecast" update,
// so it is recorded with the session and a replay shows the forecast as it stood then.
//
// State in the feed: Forecast = { Updated, Hours: [{ t, mm, min, max, p, thunder, sym, temp }] }
// with t in unix seconds (start of the hour) and rain in millimetres for that hour.
const HOURS = 12;

function hoursOf(json) {
  const out = [];
  for (const s of json?.properties?.timeseries || []) {
    const n1 = s?.data?.next_1_hours;
    if (!n1) continue;
    const d = n1.details || {};
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : undefined);
    out.push({
      t: Math.round(Date.parse(s.time) / 1000),
      mm: num(d.precipitation_amount) ?? 0,
      min: num(d.precipitation_amount_min),
      max: num(d.precipitation_amount_max),
      p: num(d.probability_of_precipitation),
      thunder: num(d.probability_of_thunder),
      sym: n1.summary?.symbol_code || '',
      temp: num(s.data?.instant?.details?.air_temperature),
    });
    if (out.length >= HOURS + 6) break; // a few spare hours for a replay further on
  }
  return out;
}

export class Forecast {
  // emit(key, data) pushes a Forecast update for session `key`; false when the feed moved on.
  constructor({ api, userAgent, log = () => {}, emit, getState }) {
    this.api = String(api).replace(/\/$/, '');
    this.userAgent = userAgent;
    this.log = log;
    this.emit = emit;
    this.getState = getState;
    this.loc = null;      // "lat,lon" of the last fetch
    this.last = null;     // last forecast, as put in the feed
    this.lastModified = null;
    this.nextAt = 0;
    this.busy = false;
    this.error = null;
  }

  info() { return { updated: this.last?.Updated || null, error: this.error }; }

  async tick(target) {
    if (!target || this.busy) return;
    // MET asks for at most 4 decimals, so cached answers can be shared.
    const lat = Number(target.lat).toFixed(4), lon = Number(target.lon).toFixed(4);
    const loc = `${lat},${lon}`;
    const have = this.getState()?.Forecast;
    if (loc !== this.loc) { this.loc = loc; this.last = null; this.lastModified = null; this.nextAt = 0; }
    // A new session starts without it: hand over what we have straight away.
    if (this.last && have?.Updated !== this.last.Updated && Date.now() < this.nextAt) {
      this.emit(target.key, this.last);
      return;
    }
    if (Date.now() < this.nextAt) return;
    this.busy = true;
    try {
      const headers = { 'User-Agent': this.userAgent, Accept: 'application/json' };
      if (this.last && this.lastModified) headers['If-Modified-Since'] = this.lastModified;
      const res = await fetch(`${this.api}/locationforecast/2.0/complete?lat=${lat}&lon=${lon}`, { headers, signal: AbortSignal.timeout(20000) });
      const expires = Date.parse(res.headers.get('expires') || '');
      // Within MET's rules: not before Expires, but at least every hour.
      this.nextAt = Math.min(Date.now() + 3600000, Math.max(Date.now() + 5 * 60000, Number.isFinite(expires) ? expires : Date.now() + 30 * 60000));
      if (res.status === 304) {
        if (this.last && have?.Updated !== this.last.Updated) this.emit(target.key, this.last);
        this.error = null;
        return;
      }
      if (res.status === 203) this.log('forecast: MET says this API version is deprecated');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const hours = hoursOf(json);
      if (!hours.length) throw new Error('no hourly forecast in the answer');
      this.lastModified = res.headers.get('last-modified');
      this.last = { Updated: json.properties?.meta?.updated_at || new Date().toISOString(), Hours: hours };
      this.error = null;
      if (have?.Updated !== this.last.Updated || JSON.stringify(have?.Hours) !== JSON.stringify(hours)) this.emit(target.key, this.last);
    } catch (e) {
      this.error = e.message;
      this.nextAt = Date.now() + 10 * 60000;
      this.log('forecast:', e.message);
    } finally {
      this.busy = false;
    }
  }
}
