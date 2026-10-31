import { applyItem, clone, list, sessionKey, stintRanges } from './merge.js';
import { strategyChart, raceTrace, sparkline, teleTrace, COMPOUND_LETTER } from './charts.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseUtc = (s) => new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtTimeSec = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

let state = {};
let queue = [];
let offset = 0; // server clock minus browser clock
let delay = store.get('delay', 0);
let gapMode = store.get('gapMode', 'int');
let status = null;
let schedule = null;
let es = null;
let dirty = true;
let hist = [];               // per-session history from the server (laps, weather, track status)
const teleBuf = new Map();   // num -> [{ t, rpm, v, gear, thr, brk }] for the last ~40 s
let fav = store.get('fav', ''); // favourite driver's three-letter code
let teleTla = store.get('teleTla', '');
let insTab = store.get('insTab', '');
let radioMine = store.get('radioMine', false);
let traceFilter = store.get('traceFilter', 10);
let traceFocus = null;       // driver number highlighted from the legend
let standings = null, standingsErr = null, standingsAt = 0;
let standTab = store.get('standTab', 'drivers');
let season = null, seasonErr = null;
let resSel = store.get('resSel', null); // { year, round, kind }
const resCache = new Map();

// Server time minus the broadcast delay: the moment the page is "showing".
const shownNow = () => Date.now() + offset - delay * 1000;

// ---------- data stream ----------
function connect() {
  if (es) es.close();
  es = new EventSource('api/stream');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    offset = d.serverNow - Date.now();
    state = clone(d.base) || {};
    queue = d.items || [];
    hist = d.history || [];
    teleBuf.clear();
    status = d.status;
    drain();
    dirty = true;
  });
  es.onmessage = (e) => queue.push(JSON.parse(e.data));
  es.addEventListener('hist', (e) => { hist.push(JSON.parse(e.data)); if (hist.length > 8000) hist.splice(0, hist.length - 8000); });
  es.addEventListener('status', (e) => { status = JSON.parse(e.data); dirty = true; });
  es.onerror = () => {
    if (status) status = { ...status, live: { ...status.live, status: 'reconnecting' } };
    dirty = true;
  };
}

function drain() {
  const cutoff = shownNow();
  let n = 0;
  while (queue.length && queue[0].t <= cutoff) {
    const item = queue.shift();
    if (item.topic === 'CarData') addTelemetry(item.data);
    state = applyItem(state, item);
    n++;
  }
  if (n) dirty = true;
}

async function loadSchedule() {
  try {
    schedule = await (await fetch('api/schedule')).json();
    dirty = true;
  } catch {}
}

// ---------- helpers ----------
const TRACK = {
  '1': 'Track clear', '2': 'Yellow flag', '3': 'Flag', '4': 'Safety car',
  '5': 'Red flag', '6': 'Virtual safety car', '7': 'VSC ending',
};
const sessionStatus = () => state.SessionStatus?.Status || null;
const hasSession = () => Boolean(state.SessionInfo?.Name);
const isLive = () => hasSession() && ['Started', 'Aborted'].includes(sessionStatus()) &&
  status?.live?.status === 'connected';

// ---------- drivers, favourites, history ----------
const DL = () => state.DriverList || {};
const colorOf = (num) => `#${DL()[num]?.TeamColour || '666'}`;
const tlaOf = (num) => DL()[num]?.Tla || String(num);
const numOfTla = (tla) => Object.keys(DL()).find((n) => DL()[n]?.Tla === tla) || null;
const favNum = () => (fav ? numOfTla(fav) : null);

// The second driver of each team (by car number) gets dashed lines, so teammates differ by more than colour.
function dashedSet() {
  const byTeam = {};
  for (const [num, d] of Object.entries(DL())) (byTeam[d?.TeamName || num] ||= []).push(num);
  const out = new Set();
  for (const nums of Object.values(byTeam)) nums.sort((a, b) => Number(a) - Number(b)).slice(1).forEach((n) => out.add(n));
  return out;
}

// History entries for the session on screen, up to the moment being shown (broadcast delay).
function shownHist() {
  const key = sessionKey(state);
  if (!key) return [];
  const cut = shownNow();
  return hist.filter((e) => e.s === key && e.t <= cut);
}

// Drivers in running order.
function runningOrder() {
  const lines = state.TimingData?.Lines || {};
  return Object.entries(lines)
    .filter(([num, l]) => l && (DL()[num] || l.Position))
    .sort(([, a], [, b]) => (Number(a.Position) || a.Line || 99) - (Number(b.Position) || b.Line || 99));
}

function addTelemetry(data) {
  for (const e of list(data?.Entries)) {
    const t = e.Utc ? parseUtc(e.Utc).getTime() : Date.now();
    for (const [num, c] of Object.entries(e.Cars || {})) {
      let buf = teleBuf.get(num);
      if (!buf) teleBuf.set(num, (buf = []));
      if (buf.length && t <= buf[buf.length - 1].t) continue;
      buf.push({ t, rpm: c[0], v: c[1], gear: c[2], thr: c[3], brk: c[4] });
      while (buf.length && t - buf[0].t > 40000) buf.shift();
    }
  }
}

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

function clockRemaining() {
  const c = state.ExtrapolatedClock;
  if (!c?.Remaining) return null;
  const [h, m, s] = c.Remaining.split(':').map(Number);
  let secs = h * 3600 + m * 60 + s;
  if (c.Extrapolating && c.Utc) secs -= (shownNow() - parseUtc(c.Utc).getTime()) / 1000;
  secs = Math.max(0, Math.floor(secs));
  return `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

// ---------- header ----------
function renderHeader() {
  const si = state.SessionInfo;
  const live = isLive();
  document.body.classList.toggle('is-live', live);
  $('sessionTitle').textContent = si?.Name
    ? `${si.Meeting?.Name || ''} · ${si.Name}`
    : (schedule?.next?.name || 'Formula 1');

  const code = state.TrackStatus?.Status;
  const pill = $('trackPill');
  const finished = ['Finished', 'Finalised', 'Ends'].includes(sessionStatus());
  if (live && code) {
    pill.dataset.status = code;
    pill.textContent = TRACK[code] || state.TrackStatus.Message || 'Track';
  } else {
    pill.dataset.status = 'none';
    pill.textContent = !hasSession() ? 'No session' : finished ? 'Session finished' : 'Not running';
  }
  $('flagbar').dataset.status = live && code ? code : 'none';

  const lc = state.LapCount;
  $('lapInfo').innerHTML = hasSession() && lc?.CurrentLap
    ? `Lap <b>${lc.CurrentLap}</b>${lc.TotalLaps ? `/${lc.TotalLaps}` : ''}` : '';
  $('clockInfo').innerHTML = ''; // time left is shown in the centre of the header

  const chip = $('liveChip');
  const ls = status?.live?.status;
  chip.className = 'chip';
  if (live) {
    chip.classList.add('live');
    chip.textContent = status?.demo ? 'Demo' : delay ? `Live −${delay}s` : 'Live';
  } else if (ls === 'connected') chip.textContent = 'Connected';
  else if (ls === 'connecting' || ls === 'reconnecting' || ls === 'disconnected') chip.textContent = 'Connecting';
  else chip.textContent = 'Standby';
}

// ---------- header: live now / next session ----------
const shortGp = (n) => String(n || '').replace(/ Grand Prix$/, ' GP');
function renderNext() {
  const el = $('nextInfo');
  const wk = schedule?.next;
  const now = Date.now();
  const sessions = (wk?.sessions || []).map((s) => {
    const start = new Date(s.start).getTime();
    return { ...s, startMs: start, endMs: start + s.minutes * 60000 };
  });
  const onNow = sessions.find((s) => now >= s.startMs && now < s.endMs);
  const next = sessions.find((s) => s.startMs > now);
  let html = '';
  if (isLive() || onNow) {
    // Prefer what the feed says is running (sessions can overrun their slot).
    const si = state.SessionInfo;
    const name = isLive() && si?.Name ? si.Name : onNow?.name;
    const gp = isLive() && si?.Meeting?.Name ? si.Meeting.Name : wk?.name;
    const rem = isLive() ? clockRemaining() : null;
    const count = rem ? `${rem} left` : onNow ? `until ${fmtTime.format(new Date(onNow.endMs))}` : '';
    html = `<span class="nx-label live">Live now</span>
      <span class="nx-main"><b>${esc(name || 'Session')}</b><span class="nx-gp"> · ${esc(shortGp(gp))}</span></span>
      ${count ? `<span class="nx-count">${esc(count)}</span>` : ''}`;
  } else if (next) {
    const soon = next.startMs - now < 3600000;
    html = `<span class="nx-label">Next · ${esc(fmtDay.format(new Date(next.startMs)))} ${esc(fmtTime.format(new Date(next.startMs)))}</span>
      <span class="nx-main"><b>${esc(next.name)}</b><span class="nx-gp"> · ${esc(shortGp(wk.name))}</span></span>
      <span class="nx-count${soon ? ' soon' : ''}">in ${esc(dur(next.startMs - now))}</span>`;
  }
  el.innerHTML = html;
  el.hidden = !html;
}

// ---------- next weekend ----------
function renderWeekend() {
  $('tzLabel').textContent = `Times in ${tz.replace(/_/g, ' ')}`;
  const el = $('weekend');
  const wk = schedule?.next;
  if (!wk) {
    el.innerHTML = `<div class="empty">${schedule?.error ? `Couldn't load the calendar (${esc(schedule.error)}).` : 'No upcoming race weekend found yet.'}</div>`;
    return;
  }
  const now = Date.now();
  const rows = wk.sessions.map((s) => {
    const start = new Date(s.start).getTime();
    const end = start + s.minutes * 60000;
    return { ...s, startMs: start, state: now > end ? 'done' : now >= start ? 'now' : 'todo' };
  });
  const nowS = rows.find((r) => r.state === 'now');
  const nextS = rows.find((r) => r.state === 'todo');
  if (nextS && !nowS) nextS.state = 'next';
  const first = new Date(rows[0].startMs), last = new Date(rows[rows.length - 1].startMs);
  const range = `${fmtDay.format(first)} – ${fmtDay.format(last)}`;
  const countdown = nowS
    ? `<b>${esc(nowS.name)}</b> is on now`
    : nextS ? `<b>${esc(nextS.name)}</b> in <b>${dur(nextS.startMs - now)}</b>` : 'Weekend finished';
  el.innerHTML = `
    <div class="wk-name">${esc(wk.name)}</div>
    <div class="wk-place">${esc(wk.circuit || '')}${wk.locality ? ` · ${esc(wk.locality)}, ${esc(wk.country)}` : ''}</div>
    <div class="wk-place">Round ${wk.round} · ${range}</div>
    <div class="wk-countdown">${countdown}</div>
    <ul class="wk-sessions">${rows.map((r) => `
      <li class="${r.state}${r.key === 'Race' ? ' race' : ''}">
        <span class="wk-day">${fmtDay.format(new Date(r.startMs))}</span>
        <span class="wk-sname">${esc(r.name)}</span>
        <span class="wk-time">${fmtTime.format(new Date(r.startMs))}</span>
      </li>`).join('')}
    </ul>`;
}

// ---------- timing tower ----------
const LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

function lastWith(arr, key) {
  const l = list(arr);
  for (let i = l.length - 1; i >= 0; i--) if (l[i]?.[key]) return l[i][key];
  return '';
}

function secCell(s) {
  if (!s) return '<span class="sec"></span>';
  if (!s.Value) {
    return s.PreviousValue ? `<span class="sec old">${esc(s.PreviousValue)}</span>` : '<span class="sec">&nbsp;</span>';
  }
  const cls = s.OverallFastest ? 'p' : s.PersonalFastest ? 'g' : 'y';
  return `<span class="sec ${cls}">${esc(s.Value)}</span>`;
}

function renderTower() {
  const lines = state.TimingData?.Lines || {};
  const drivers = state.DriverList || {};
  const app = state.TimingAppData?.Lines || {};
  const kind = state.SessionInfo?.Type === 'Race' ? 'race' : 'other';
  const table = $('tower');
  table.dataset.kind = kind;
  table.dataset.gapmode = gapMode;
  $('gapToggle').textContent = gapMode === 'int' ? 'Interval' : 'Gap';
  $('gapToggle').style.visibility = kind === 'race' ? 'visible' : 'hidden';
  $('towerTitle').textContent = state.SessionInfo?.Name
    ? `${state.SessionInfo.Name}${isLive() ? '' : ' · last data'}` : 'Timing';

  const rows = runningOrder();
  $('towerEmpty').hidden = rows.length > 0;
  const fnum = favNum();
  const tnum = teleNum();

  table.tBodies[0].innerHTML = rows.map(([num, l]) => {
    const d = drivers[num] || {};
    const out = l.Retired || l.Stopped || l.KnockedOut;
    let gap, int;
    if (kind === 'race') {
      gap = l.GapToLeader ?? '';
      int = l.IntervalToPositionAhead?.Value ?? '';
    } else {
      gap = lastWith(l.Stats, 'TimeDiffToFastest') || l.TimeDiffToFastest || '';
      int = lastWith(l.Stats, 'TimeDiffToPositionAhead') || l.TimeDiffToPositionAhead || '';
    }
    const leadCls = (v) => (/^LAP/i.test(v) ? ' lead' : '');
    const last = l.LastLapTime || {};
    const lastCls = last.OverallFastest ? 't-ob' : last.PersonalFastest ? 't-pb' : '';
    const best = l.BestLapTime?.Value || lastWith(l.BestLapTimes, 'Value');
    const secs = list(l.Sectors);
    const stints = list(app[num]?.Stints);
    const st = stints[stints.length - 1];
    const comp = (st?.Compound || '').toUpperCase();
    const tyre = st
      ? `<span class="tyre"><span class="t ${esc(comp)}"><span>${LETTER[comp] || '?'}</span></span><span class="age">${st.TotalLaps ?? ''}</span>${st.New === 'false' ? '<span class="used" title="Used set">u</span>' : ''}</span>`
      : '';
    return `<tr data-num="${esc(num)}" class="${out ? 'out' : ''}${l.InPit ? ' inpit' : ''}${num === fnum ? ' fav' : ''}${num === tnum && isLive() ? ' sel' : ''}">
      <td class="c-pos">${esc(l.Position || '')}</td>
      <td class="c-drv"><span class="drv"><span class="bar" style="background:#${esc(d.TeamColour || '666')}"></span><span class="num">${esc(num)}</span><span class="tla">${esc(d.Tla || num)}</span><span class="team">${esc(d.TeamName || '')}</span></span></td>
      <td class="c-gap${leadCls(gap)}">${out ? '<span class="badge out">OUT</span>' : esc(gap)}</td>
      <td class="c-int${leadCls(int)}">${out ? '' : esc(int)}</td>
      <td class="c-last ${lastCls}">${esc(last.Value || '')}</td>
      <td class="c-best">${esc(best || '')}</td>
      <td class="c-sec">${secCell(secs[0])}</td>
      <td class="c-sec">${secCell(secs[1])}</td>
      <td class="c-sec">${secCell(secs[2])}</td>
      <td class="c-tyre">${l.InPit ? '<span class="badge">PIT</span>' : tyre}</td>
      <td class="c-pit">${l.NumberOfPitStops || ''}</td>
    </tr>`;
  }).join('');
  renderFavBar(rows, kind);
}

// "Your driver": position plus the gaps to the cars ahead and behind.
function renderFavBar(rows, kind) {
  const bar = $('favBar');
  const fnum = favNum();
  const i = rows.findIndex(([num]) => num === fnum);
  if (!fnum || i < 0 || !hasSession()) { bar.hidden = true; return; }
  const [, l] = rows[i];
  const gapOf = (line) => (kind === 'race'
    ? line?.IntervalToPositionAhead?.Value
    : lastWith(line?.Stats, 'TimeDiffToPositionAhead') || line?.TimeDiffToPositionAhead) || '';
  const ahead = rows[i - 1], behind = rows[i + 1];
  const st = list(state.TimingAppData?.Lines?.[fnum]?.Stints).pop();
  const comp = (st?.Compound || '').toUpperCase();
  const parts = [
    `<span class="fb-me"><span class="bar" style="background:${colorOf(fnum)}"></span><b>${esc(tlaOf(fnum))}</b> <span class="fb-pos">P${esc(l.Position || '–')}</span></span>`,
  ];
  if (l.Retired || l.Stopped) parts.push('<span class="muted">Out</span>');
  else {
    if (ahead) parts.push(`<span class="fb-gap"><span class="muted">Ahead</span> <b>${esc(tlaOf(ahead[0]))}</b> ${esc(gapOf(l) || '–')}</span>`);
    if (behind && !(behind[1].Retired || behind[1].Stopped)) parts.push(`<span class="fb-gap"><span class="muted">Behind</span> <b>${esc(tlaOf(behind[0]))}</b> ${esc(gapOf(behind[1]) || '–')}</span>`);
    if (st) parts.push(`<span class="fb-gap"><span class="muted">Tyre</span> <b>${LETTER[comp] || '?'}</b> ${esc(st.TotalLaps ?? '')} laps</span>`);
    if (l.LastLapTime?.Value) parts.push(`<span class="fb-gap"><span class="muted">Last</span> ${esc(l.LastLapTime.Value)}</span>`);
  }
  bar.innerHTML = parts.join('');
  bar.hidden = false;
}

// ---------- track map ----------
const SVGNS = 'http://www.w3.org/2000/svg';
let circuitKey = null;
let circuit = null;
let geom = null; // { rot, viewBox, scale }
const carEls = new Map();
let trackLayer, flagLayer, carLayer;
let flagKey = '';

function project(x, y) {
  const a = (geom.rot * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), -(x * Math.sin(a) + y * Math.cos(a))];
}

async function loadCircuit(key, year) {
  circuitKey = key;
  circuit = null;
  geom = null;
  try {
    const res = await fetch(`api/circuit?key=${encodeURIComponent(key)}&year=${encodeURIComponent(year)}`);
    if (res.ok) circuit = await res.json();
  } catch {}
  buildTrack();
  dirty = true;
}

function buildTrack() {
  const svg = $('map');
  svg.innerHTML = '';
  carEls.clear();
  trackLayer = document.createElementNS(SVGNS, 'g');
  flagLayer = document.createElementNS(SVGNS, 'g');
  carLayer = document.createElementNS(SVGNS, 'g');
  svg.append(trackLayer, flagLayer, carLayer);
  flagKey = '';
  if (!circuit?.x?.length) { geom = null; return; }
  geom = { rot: circuit.rotation || 0 };
  const pts = circuit.x.map((x, i) => project(x, circuit.y[i]));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const pad = Math.max(w, h) * 0.07;
  geom.scale = Math.max(w, h);
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`);
  svg.style.aspectRatio = String(Math.min(2.2, Math.max(1.05, (w + 2 * pad) / (h + 2 * pad))));
  const d = `M${pts.map((p) => `${p[0].toFixed(0)},${p[1].toFixed(0)}`).join('L')}`;
  const sw = geom.scale * 0.022;
  geom.pts = pts;
  geom.sw = sw;
  trackLayer.innerHTML = `
    <path class="track-bg" d="${d}" stroke-width="${sw * 2.2}"/>
    <path class="track" d="${d}" stroke-width="${sw * 0.55}"/>
    <circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="${sw * 0.7}" fill="#fff"/>
    ${(circuit.corners || []).map((c) => {
      const tp = c.trackPosition || {};
      const a = ((c.angle || 0) * Math.PI) / 180;
      const off = geom.scale * 0.045;
      const [x, y] = project(tp.x + off * Math.cos(a), tp.y + off * Math.sin(a));
      return `<text class="corner" x="${x}" y="${y}" font-size="${geom.scale * 0.024}">${esc(c.number)}${esc(c.letter || '')}</text>`;
    }).join('')}`;
}

// Sectors currently under a yellow, from race control: { sectorNumber: 'YELLOW' | 'DOUBLE YELLOW' }.
function activeYellows() {
  const code = state.TrackStatus?.Status;
  if (!isLive() || code === '1' || code === '5') return {}; // all clear or red flag
  const out = {};
  for (const m of list(state.RaceControlMessages?.Messages)) {
    if (m.Category !== 'Flag') continue;
    const flag = String(m.Flag || '').toUpperCase();
    if (m.Scope === 'Sector' && m.Sector != null) {
      if (flag === 'YELLOW' || flag === 'DOUBLE YELLOW') out[m.Sector] = flag;
      else if (flag === 'CLEAR' || flag === 'GREEN') delete out[m.Sector];
    } else if (m.Scope === 'Track' && (flag === 'GREEN' || flag === 'CLEAR')) {
      for (const k of Object.keys(out)) delete out[k];
    } else if (flag === 'CHEQUERED' || flag === 'RED') {
      for (const k of Object.keys(out)) delete out[k];
    }
  }
  return out;
}

// Index of the outline point closest to a position in raw track coordinates.
function nearestIndex(tp) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < circuit.x.length; i++) {
    const d = (circuit.x[i] - tp.x) ** 2 + (circuit.y[i] - tp.y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function renderFlags() {
  const ms = circuit?.marshalSectors || [];
  const ys = geom && ms.length ? activeYellows() : {};
  const key = JSON.stringify(ys);
  if (key === flagKey) return;
  flagKey = key;
  if (!flagLayer) return;
  const n = geom?.pts?.length || 0;
  flagLayer.innerHTML = Object.entries(ys).map(([num, flag]) => {
    const i = ms.findIndex((m) => String(m.number) === String(num));
    if (i < 0 || !ms[i].trackPosition) return '';
    const next = ms[(i + 1) % ms.length];
    const a = nearestIndex(ms[i].trackPosition);
    const b = next?.trackPosition ? nearestIndex(next.trackPosition) : (a + 8) % n;
    const idx = [];
    for (let k = a; k !== b && idx.length < n; k = (k + 1) % n) idx.push(k);
    idx.push(b);
    const d = `M${idx.map((k) => `${geom.pts[k][0].toFixed(0)},${geom.pts[k][1].toFixed(0)}`).join('L')}`;
    const dbl = flag === 'DOUBLE YELLOW';
    return `<path class="yellow-glow" d="${d}" stroke-width="${geom.sw * (dbl ? 3.6 : 3.0)}"/>
      <path class="yellow${dbl ? ' dbl' : ''}" d="${d}" stroke-width="${geom.sw * (dbl ? 1.3 : 1.0)}"/>`;
  }).join('');
}

function renderMap() {
  const si = state.SessionInfo;
  const key = si?.Meeting?.Circuit?.Key;
  const year = (si?.StartDate || si?.Path || '').slice(0, 4) || new Date().getFullYear();
  $('mapTitle').textContent = si?.Meeting?.Circuit?.ShortName || 'Track';
  if (key != null && String(key) !== circuitKey) loadCircuit(String(key), year);

  renderWx();

  renderFlags();
  const note = $('mapNote');
  const entries = state.Position?.Entries;
  if (!geom) {
    note.innerHTML = key == null ? 'The track map appears when a session starts.' : 'Loading track…';
    return;
  }
  if (!entries) {
    note.innerHTML = status?.live?.positionEnabled || status?.demo
      ? 'Waiting for car positions…'
      : 'Car positions need your F1 TV sign-in · <button type="button" data-open-settings>Add it</button>';
  } else note.textContent = '';
  if (!entries) return;

  const drivers = state.DriverList || {};
  const r = geom.scale * 0.016;
  const fs = geom.scale * 0.024;
  for (const [num, e] of Object.entries(entries)) {
    let g = carEls.get(num);
    const d = drivers[num] || {};
    if (!g) {
      g = document.createElementNS(SVGNS, 'g');
      g.classList.add('car');
      g.innerHTML = `<circle r="${r}" stroke-width="${r * 0.3}"/><text x="${r * 1.4}" y="${r * 0.45}" font-size="${fs}" stroke-width="${fs * 0.18}"></text>`;
      carLayer.append(g);
      carEls.set(num, g);
    }
    g.querySelector('circle').setAttribute('fill', `#${d.TeamColour || '888'}`);
    g.querySelector('text').textContent = d.Tla || num;
    const [x, y] = project(e.X, e.Y);
    g.style.transform = `translate(${x}px, ${y}px)`;
    const line = state.TimingData?.Lines?.[num];
    g.classList.toggle('off', e.Status !== 'OnTrack' || Boolean(line?.Retired || line?.Stopped));
    const isFav = num === favNum();
    if (isFav !== g.classList.contains('fav')) {
      g.classList.toggle('fav', isFav);
      g.querySelector('circle').setAttribute('r', isFav ? r * 1.45 : r);
      if (isFav) carLayer.append(g); // draw on top
    }
  }
}

// ---------- weather ----------
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function renderWx() {
  const el = $('wx');
  const w = state.WeatherData;
  if (!w || !hasSession()) { el.hidden = true; return; }
  const wx = shownHist().filter((e) => e.k === 'wx');
  const track = wx.map((e) => e.track);
  // Trend over the last 20 minutes of samples.
  const cut = shownNow() - 20 * 60000;
  const old = wx.find((e) => e.t >= cut);
  const dT = old && wx.length > 1 ? Number(w.TrackTemp) - old.track : 0;
  const trend = Math.abs(dT) >= 0.5 ? `<span class="wx-trend">${dT > 0 ? '▲' : '▼'} ${Math.abs(dT).toFixed(1)}°</span>` : '';
  const dir = Number(w.WindDirection);
  const hasDir = Number.isFinite(dir) && w.WindDirection != null;
  const rain = w.Rainfall === '1' || w.Rainfall === 1;
  el.innerHTML = `
    <div class="wx-item"><span class="wx-k">Air</span><span class="wx-v">${Number(w.AirTemp).toFixed(1)}°</span></div>
    <div class="wx-item"><span class="wx-k">Track</span><span class="wx-v">${Number(w.TrackTemp).toFixed(1)}°${trend}</span>${sparkline(track)}</div>
    <div class="wx-item"><span class="wx-k">Humidity</span><span class="wx-v">${Math.round(w.Humidity)}<span class="wx-u">%</span></span></div>
    <div class="wx-item"><span class="wx-k">Wind</span><span class="wx-v">${hasDir ? `<span class="wx-arrow" style="transform:rotate(${dir + 180}deg)" title="From ${COMPASS[Math.round(dir / 45) % 8]}">↑</span>` : ''}${Number(w.WindSpeed).toFixed(1)}<span class="wx-u">m/s${hasDir ? ` ${COMPASS[Math.round(dir / 45) % 8]}` : ''}</span></span></div>
    <div class="wx-item"><span class="wx-k">Rain</span><span class="wx-v ${rain ? 'wx-rain' : ''}">${rain ? '🌧 Wet' : 'Dry'}</span></div>`;
  el.hidden = false;
}

// ---------- telemetry ----------
function teleNum() {
  const want = teleTla || fav;
  const n = want ? numOfTla(want) : null;
  if (n) return n;
  return runningOrder()[0]?.[0] || null;
}

let teleOptsKey = '';
function renderTele() {
  document.body.classList.toggle('has-tele', isLive());
  if (!isLive()) return;
  const sel = $('teleDriver');
  const order = runningOrder();
  const key = order.map(([n]) => n).join(',') + fav;
  const num = teleNum();
  if (key !== teleOptsKey) {
    teleOptsKey = key;
    sel.innerHTML = order.map(([n, l]) => `<option value="${esc(tlaOf(n))}">P${esc(l.Position || '')} ${esc(tlaOf(n))}${tlaOf(n) === fav ? ' ★' : ''}</option>`).join('');
  }
  if (num) sel.value = tlaOf(num);
  const el = $('tele');
  const buf = num ? teleBuf.get(num) : null;
  const s = buf?.[buf.length - 1];
  if (!s) {
    el.innerHTML = `<div class="empty small">${status?.live?.positionEnabled || status?.demo
      ? 'Waiting for car data…'
      : 'Telemetry needs your F1 TV sign-in · <button type="button" class="link" data-open-settings>Add it</button>'}</div>`;
    return;
  }
  const rpmPct = Math.max(0, Math.min(100, ((s.rpm - 4000) / 9000) * 100));
  el.innerHTML = `
    <div class="tele-top">
      <div class="tele-big"><span class="tele-speed">${s.v}</span><span class="tele-unit">km/h</span></div>
      <div class="tele-gear"><span class="tele-k">Gear</span><b>${s.gear || 'N'}</b></div>
      <div class="tele-bars">
        <div class="tb"><span class="tele-k">RPM</span><span class="tb-track"><span class="tb-fill rpm" style="width:${rpmPct}%"></span></span><span class="tb-v">${s.rpm.toLocaleString('en-GB')}</span></div>
        <div class="tb"><span class="tele-k">Throttle</span><span class="tb-track"><span class="tb-fill thr" style="width:${Math.min(100, s.thr)}%"></span></span><span class="tb-v">${s.thr}%</span></div>
        <div class="tb"><span class="tele-k">Brake</span><span class="tb-track"><span class="tb-fill brk" style="width:${s.brk > 0 ? 100 : 0}%"></span></span><span class="tb-v">${s.brk > 0 ? 'On' : 'Off'}</span></div>
      </div>
    </div>
    ${teleTrace(buf, { width: el.clientWidth - 24 })}`;
}

// ---------- race control, team radio ----------
function renderRC() {
  const msgs = list(state.RaceControlMessages?.Messages).slice(-30).reverse();
  const key = msgs.map((m) => `${m.Utc}${m.Message}`).join('|');
  if (key === rcKey) return;
  rcKey = key;
  $('rc').innerHTML = msgs.length
    ? msgs.map((m) => {
      const flag = m.Category === 'SafetyCar' ? 'SC' : (m.Flag || '').replace(/\s+/g, '-');
      const t = m.Utc ? fmtTimeSec.format(parseUtc(m.Utc)) : '';
      return `<li><span class="when">${t}</span><span class="msg">${flag ? `<span class="flag ${esc(flag)}"></span>` : ''}${esc(m.Message)}</span></li>`;
    }).join('')
    : '<li class="muted"><span></span><span>No messages yet.</span></li>';
}
let rcKey = null;

function renderRadio() {
  const caps = list(state.TeamRadio?.Captures);
  $('radioCount').textContent = caps.length ? String(caps.length) : '';
  const rf = $('radioFilter');
  rf.hidden = !favNum();
  rf.textContent = radioMine ? `★ ${fav} only` : 'All drivers';
  rf.className = radioMine ? 'seg-on on' : 'seg-on';
  const fnum = favNum();
  const shown = caps.map((c, i) => ({ ...c, i })).filter((c) => !radioMine || !fnum || c.RacingNumber === fnum).slice(-30).reverse();
  const key = shown.map((c) => c.i).join(',') + playing + radioMine;
  if (key === radioKey) return;
  radioKey = key;
  $('radio').innerHTML = shown.length
    ? shown.map((c) => {
      const url = radioUrl(c);
      const d = DL()[c.RacingNumber] || {};
      return `<li><span class="when">${c.Utc ? fmtTimeSec.format(parseUtc(c.Utc)) : ''}</span>
        <span class="msg radio-row"><button type="button" class="play${playing === url ? ' on' : ''}" data-radio="${esc(url)}" aria-label="${playing === url ? 'Stop' : 'Play'} radio from ${esc(d.Tla || c.RacingNumber)}">${playing === url ? '■' : '▶'}</button>
        <span class="bar" style="background:${colorOf(c.RacingNumber)}"></span><b>${esc(d.Tla || c.RacingNumber)}</b> <span class="muted">${esc(d.FullName || d.BroadcastName || '')}</span></span></li>`;
    }).join('')
    : `<li class="muted"><span></span><span>${caps.length ? 'No radio from your driver yet.' : 'No team radio yet.'}</span></li>`;
}
let radioKey = '';
let playing = null;

function radioUrl(c) {
  const p = state.SessionInfo?.Path || '';
  if (p.startsWith('demo')) return `api/demo-radio.wav?clip=${encodeURIComponent(c.Path)}`;
  return `https://livetiming.formula1.com/static/${p}${c.Path}`;
}

const audio = $('radioAudio');
audio.addEventListener('ended', () => { playing = null; radioKey = ''; dirty = true; });
audio.addEventListener('error', () => { playing = null; radioKey = ''; dirty = true; });

// ---------- insights: strategy, race trace, standings, results ----------
const isRaceSession = () => state.SessionInfo?.Type === 'Race';
let insKey = '';

function currentInsTab() {
  if (insTab) return insTab;
  return hasSession() && isLive() ? 'strategy' : 'standings';
}

function renderInsights() {
  const tab = currentInsTab();
  for (const b of document.querySelectorAll('#insTabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  if (tab === 'strategy') renderStrategy();
  else if (tab === 'trace') renderTrace();
  else if (tab === 'standings') renderStandings();
  else renderResults();
}

function setBody(key, tools, html) {
  if (key === insKey) return;
  insKey = key;
  $('insTools').innerHTML = tools;
  $('insTools').hidden = !tools;
  $('insBody').innerHTML = html;
}

function renderStrategy() {
  const order = runningOrder();
  const app = state.TimingAppData?.Lines || {};
  const fnum = favNum();
  const rows = order.map(([num, l]) => ({
    num, pos: l.Position, tla: tlaOf(num), color: colorOf(num), fav: num === fnum,
    out: Boolean(l.Retired || l.Stopped), ranges: stintRanges(app[num]?.Stints),
  })).filter((r) => r.ranges.length);
  const lc = state.LapCount || {};
  const key = `st|${JSON.stringify(rows)}|${lc.CurrentLap}|${lc.TotalLaps}`;
  if (!rows.length) return setBody(key, '', `<div class="empty">Tyre stints appear once a session is running.</div>`);
  setBody(key, '', strategyChart(rows, { totalLaps: Number(lc.TotalLaps) || 0, currentLap: Number(lc.CurrentLap) || 0 }));
}

function traceBands(h) {
  const bands = [];
  let open = null;
  const kindOf = (st) => ({ '4': ['sc', 'SC'], '5': ['red', 'RED'], '6': ['vsc', 'VSC'], '7': ['vsc', 'VSC'] }[st] || null);
  for (const e of h) {
    if (e.k !== 'ts') continue;
    const k = kindOf(e.status);
    const lap = Math.max(1, e.lap + 1);
    if (open && (!k || k[0] !== open.kind)) { open.to = lap; bands.push(open); open = null; }
    if (k && !open) open = { kind: k[0], label: k[1], from: lap, to: lap };
  }
  if (open) { open.to = Math.max(open.from, Number(state.LapCount?.CurrentLap) || open.from); bands.push(open); }
  return bands;
}

let traceScale = null;
let traceData = null;

function renderTrace() {
  const tools = `<div class="chips">${[[5, 'Top 5'], [10, 'Top 10'], [0, 'All']].map(([v, l]) =>
    `<button type="button" class="chip-btn${traceFilter === v ? ' on' : ''}" data-trace-filter="${v}">${l}</button>`).join('')}</div>`;
  if (!isRaceSession()) {
    return setBody('tr|none', '', `<div class="empty">The race trace is drawn during races and sprints.</div>`);
  }
  const h = shownHist();
  const laps = h.filter((e) => e.k === 'lap');
  const order = runningOrder();
  const fnum = favNum();
  const dashed = dashedSet();
  const pick = traceFilter ? order.slice(0, traceFilter) : order;
  const nums = new Set(pick.map(([n]) => n));
  if (fnum && order.some(([n]) => n === fnum)) nums.add(fnum);
  const width = $('insBody').clientWidth - 8;
  const height = width < 520 ? 230 : 300;
  const byNum = {};
  for (const e of laps) (byNum[e.n] ||= []).push([e.lap, e.gap]);
  const maxLap = Math.max(Number(state.LapCount?.TotalLaps) || 0, ...laps.map((e) => e.lap), 2);
  const series = order.filter(([n]) => nums.has(n)).map(([n]) => ({
    num: n, tla: tlaOf(n), color: colorOf(n), dashed: dashed.has(n),
    emphasis: traceFocus ? (n === traceFocus ? 1 : -1) : n === fnum ? 1 : 0,
    points: (byNum[n] || []).sort((a, b) => a[0] - b[0]),
  }));
  const key = `tr|${laps.length}|${traceFilter}|${traceFocus}|${fnum}|${width}|${h.length}`;
  if (key === insKey) return;
  if (!laps.length) {
    return setBody(key, tools, `<div class="empty">The race trace builds up lap by lap while the page is open on the server. It starts from the first completed lap it sees.</div>`);
  }
  const { svg, scale } = raceTrace(series, { width, height, maxLap, bands: traceBands(h), endLabels: series.length <= 12 });
  traceScale = scale;
  traceData = { series, maxLap };
  const legend = `<div class="legend">${series.map((s) => `<button type="button" class="lg lg-btn${traceFocus === s.num ? ' on' : ''}" data-trace-focus="${esc(s.num)}"><span class="lg-line${s.dashed ? ' dashed' : ''}" style="border-color:${esc(s.color)}"></span>${esc(s.tla)}</button>`).join('')}</div>`;
  setBody(key, tools, `${legend}<div class="trace-wrap">${svg}</div><p class="hint chart-note">Gap to the leader at the end of each lap. Lapped cars drop off the chart. Shaded: safety car, VSC or red flag.</p>`);
}

function traceHover(ev) {
  const svg = ev.target.closest('svg.trace');
  if (!svg || !traceScale || !traceData) return hideTip();
  const rect = svg.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * traceScale.W;
  const { padL, padR, W, lapMax } = traceScale;
  const lap = Math.round(1 + ((px - padL) / (W - padL - padR)) * (lapMax - 1));
  if (lap < 1 || lap > lapMax) return hideTip();
  const rows = traceData.series.map((s) => ({ s, g: s.points.find((p) => p[0] === lap)?.[1] })).filter((r) => r.g != null).sort((a, b) => a.g - b.g);
  const cross = svg.querySelector('#rtCross');
  const cx = traceScale.x(lap);
  cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
  if (!rows.length) return showTip(ev, `<b>Lap ${lap}</b><div class="muted">No data</div>`);
  showTip(ev, `<b>Lap ${lap}</b>${rows.slice(0, 12).map((r) => `<div class="tip-row"><span class="tip-sw${r.s.dashed ? ' dashed' : ''}" style="border-color:${esc(r.s.color)}"></span>${esc(r.s.tla)}<span>${r.g === 0 ? 'Leader' : `+${r.g.toFixed(1)}s`}</span></div>`).join('')}`);
}

// Points for the running order, if this session counts.
const RACE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];
function projection() {
  if (!standings || !isRaceSession()) return null;
  if (!['Started', 'Aborted', 'Finished', 'Finalised', 'Ends'].includes(sessionStatus())) return null;
  const sprint = /sprint/i.test(state.SessionInfo?.Name || '');
  const wk = schedule?.next;
  const round = wk?.round || 0;
  if (!isLive()) {
    // After the flag: only while that session on the calendar ended in the last few hours,
    // so stale data from an old weekend never shows up as points.
    const s = wk?.sessions?.find((x) => x.key === (sprint ? 'Sprint' : 'Race'));
    const end = s ? new Date(s.start).getTime() + s.minutes * 60000 : 0;
    if (standings.demo || !end || Date.now() < end - 3600000 || Date.now() > end + 6 * 3600000) return null;
  }
  if (!standings.demo) {
    if (!round || standings.round > round) return null;
    if (standings.round === round) {
      // Sprint weekends: the sprint may already be in the standings, the race not yet.
      const race = wk.sessions?.find((x) => x.key === 'Race');
      const hasSprint = wk.sessions?.some((x) => x.key === 'Sprint');
      const raceEnd = race ? new Date(race.start).getTime() + race.minutes * 60000 : 0;
      if (sprint || !hasSprint || (!isLive() && Date.now() > raceEnd + 3 * 3600000)) return null;
    }
  }
  const pts = sprint ? SPRINT_PTS : RACE_PTS;
  const byTla = {};
  runningOrder().forEach(([num, l]) => {
    const p = Number(l.Position);
    byTla[tlaOf(num)] = l.Retired || l.Stopped || !p ? 0 : pts[p - 1] || 0;
  });
  return { byTla, label: `${sprint ? 'Sprint' : 'Race'} ${isLive() ? 'as it runs' : '(provisional)'}` };
}

async function loadStandings(force) {
  if (!force && standings && Date.now() - standingsAt < 10 * 60000) return;
  standingsAt = Date.now();
  try {
    const res = await fetch('api/standings');
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    standings = j; standingsErr = null;
  } catch (e) { standingsErr = e.message; }
  insKey = '';
  dirty = true;
}

function renderStandings() {
  loadStandings();
  const tools = `<div class="chips">${[['drivers', 'Drivers'], ['teams', 'Teams']].map(([v, l]) =>
    `<button type="button" class="chip-btn${standTab === v ? ' on' : ''}" data-stand="${v}">${l}</button>`).join('')}</div>`;
  if (!standings) {
    return setBody(`sd|${standingsErr}`, tools, `<div class="empty">${standingsErr ? `Couldn't load the standings (${esc(standingsErr)}).` : 'Loading standings…'}</div>`);
  }
  const proj = projection();
  const teamColor = {};
  for (const d of Object.values(DL())) if (d?.TeamName) teamColor[d.TeamName] = `#${d.TeamColour}`;
  const colorFor = (code, team) => { const n = numOfTla(code); return n ? colorOf(n) : teamColor[team] || 'var(--line)'; };
  let rows;
  if (standTab === 'drivers') {
    rows = standings.drivers.map((d) => ({ ...d, add: proj ? proj.byTla[d.code] || 0 : 0, color: colorFor(d.code, d.team), label: d.code || d.name, sub: d.team }));
  } else {
    const add = {};
    if (proj) for (const d of standings.drivers) add[d.team] = (add[d.team] || 0) + (proj.byTla[d.code] || 0);
    const tc = {};
    for (const d of standings.drivers) tc[d.team] ||= colorFor(d.code, d.team);
    rows = standings.teams.map((t) => ({ ...t, add: add[t.name] || 0, color: tc[t.name] || teamColor[t.name] || 'var(--line)', label: t.name, sub: '' }));
  }
  if (proj) {
    rows = rows.map((r) => ({ ...r, total: r.points + r.add }))
      .sort((a, b) => b.total - a.total || a.pos - b.pos)
      .map((r, i) => ({ ...r, newPos: i + 1 }));
  }
  const key = `sd|${standTab}|${JSON.stringify(rows)}|${fav}|${proj?.label}`;
  const leader = rows[0] ? (proj ? rows[0].total : rows[0].points) : 0;
  const html = `<div class="table-wrap"><table class="tbl">
    <thead><tr><th class="num-c">P</th><th>${standTab === 'drivers' ? 'Driver' : 'Team'}</th>${proj ? `<th class="num-c" title="${esc(proj.label)}">Live</th>` : ''}<th class="num-c">Pts</th><th class="num-c hide-sm">Gap</th><th class="num-c hide-sm">Wins</th></tr></thead>
    <tbody>${rows.map((r) => {
      const pos = proj ? r.newPos : r.pos;
      const moved = proj ? r.pos - r.newPos : 0;
      const pts = proj ? r.total : r.points;
      const isFav = standTab === 'drivers' && fav && r.code === fav;
      return `<tr class="${isFav ? 'fav' : ''}">
        <td class="num-c b">${pos}${moved ? `<span class="mv ${moved > 0 ? 'up' : 'down'}">${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}</span>` : ''}</td>
        <td><span class="drv"><span class="bar" style="background:${esc(r.color)}"></span><span class="tla">${esc(r.label)}</span>${r.sub ? `<span class="team">${esc(r.sub)}</span>` : ''}</span></td>
        ${proj ? `<td class="num-c">${r.add ? `+${r.add}` : ''}</td>` : ''}
        <td class="num-c b">${+pts.toFixed(1)}</td>
        <td class="num-c hide-sm muted">${pts === leader ? '' : `−${+(leader - pts).toFixed(1)}`}</td>
        <td class="num-c hide-sm muted">${r.wins || ''}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="hint chart-note">${standings.demo ? 'Demo standings. ' : ''}After round ${standings.round} of ${standings.season}.${proj ? ` Live column: points for the current running order (${esc(proj.label)}); positions move to match.` : ''}</p>`;
  setBody(key, tools, html);
}

async function loadSeason(year) {
  try {
    const res = await fetch(`api/season?year=${year}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    return j;
  } catch (e) { seasonErr = e.message; return null; }
}

let seasonLoading = false;
async function ensureSeason() {
  if (season || seasonLoading) return;
  seasonLoading = true;
  const y = new Date().getFullYear();
  let s = await loadSeason(y);
  if (s && !s.races.some((r) => r.done)) s = (await loadSeason(y - 1)) || s;
  season = s;
  seasonLoading = false;
  if (season && (!resSel || !season.races.some((r) => r.round === resSel.round && season.season === resSel.year))) {
    const last = [...season.races].reverse().find((r) => r.done);
    if (last) resSel = { year: season.season, round: last.round, kind: resSel?.kind || 'race' };
  }
  insKey = '';
  dirty = true;
}

async function loadResults(sel) {
  const k = `${sel.year}/${sel.round}/${sel.kind}`;
  if (resCache.has(k)) return;
  resCache.set(k, { loading: true });
  try {
    const res = await fetch(`api/results?year=${sel.year}&round=${sel.round}&kind=${sel.kind}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    resCache.set(k, j);
  } catch (e) { resCache.set(k, { error: e.message }); }
  insKey = '';
  dirty = true;
}

function renderResults() {
  ensureSeason();
  if (!season) {
    return setBody(`rs|${seasonErr}|${seasonLoading}`, '', `<div class="empty">${seasonErr && !seasonLoading ? `Couldn't load results (${esc(seasonErr)}).` : 'Loading results…'}</div>`);
  }
  const done = season.races.filter((r) => r.done);
  if (!resSel || !done.length) return setBody('rs|none', '', '<div class="empty">No results yet this season.</div>');
  const race = season.races.find((r) => r.round === resSel.round) || done[done.length - 1];
  const kinds = [['race', 'Race'], ...(race.hasSprint ? [['sprint', 'Sprint']] : []), ['qualifying', 'Qualifying']];
  if (!kinds.some(([k]) => k === resSel.kind)) resSel.kind = 'race';
  loadResults(resSel);
  const data = resCache.get(`${resSel.year}/${resSel.round}/${resSel.kind}`);
  const tools = `<select id="resRound" class="sel" aria-label="Race">${done.slice().reverse().map((r) =>
    `<option value="${r.round}"${r.round === race.round ? ' selected' : ''}>R${r.round} · ${esc(r.name.replace(' Grand Prix', ' GP'))}</option>`).join('')}</select>
    <div class="chips">${kinds.map(([k, l]) => `<button type="button" class="chip-btn${resSel.kind === k ? ' on' : ''}" data-res-kind="${k}">${l}</button>`).join('')}</div>`;
  const key = `rs|${resSel.year}|${resSel.round}|${resSel.kind}|${data?.rows?.length}|${data?.error}|${fav}|${Object.keys(DL()).length}`;
  if (!data || data.loading) return setBody(key, tools, '<div class="empty">Loading…</div>');
  if (data.error) return setBody(key, tools, `<div class="empty">Couldn't load these results (${esc(data.error)}).</div>`);
  if (!data.rows.length) return setBody(key, tools, '<div class="empty">No results published for this yet.</div>');
  const teamColor = {};
  for (const d of Object.values(DL())) if (d?.TeamName) teamColor[d.TeamName] = `#${d.TeamColour}`;
  const colorFor = (r) => { const n = numOfTla(r.code); return n ? colorOf(n) : teamColor[r.team] || 'var(--line)'; };
  const q = resSel.kind === 'qualifying';
  const html = `<div class="table-wrap"><table class="tbl">
    <thead><tr><th class="num-c">P</th><th>Driver</th>${q
      ? '<th class="num-c">Q1</th><th class="num-c">Q2</th><th class="num-c">Q3</th>'
      : '<th class="num-c hide-sm">Grid</th><th class="num-c">Time / status</th><th class="num-c">Pts</th>'}</tr></thead>
    <tbody>${data.rows.map((r) => {
      const finished = /^\d+$/.test(r.posText);
      const timeCell = r.time || (/^\+\d+ Laps?$/i.test(r.status) || r.status === 'Lapped' ? r.status : r.status || '');
      return `<tr class="${fav && r.code === fav ? 'fav' : ''}${finished ? '' : ' out'}">
        <td class="num-c b">${esc(finished ? r.posText : r.posText === 'R' ? 'DNF' : r.posText === 'D' ? 'DSQ' : r.posText)}</td>
        <td><span class="drv"><span class="bar" style="background:${esc(colorFor(r))}"></span><span class="tla">${esc(r.code || r.name)}</span><span class="team">${esc(r.team)}</span>${r.fastest ? `<span class="fl" title="Fastest lap ${esc(r.fastestTime)}">FL</span>` : ''}</span></td>
        ${q
          ? `<td class="num-c">${esc(r.q1)}</td><td class="num-c">${esc(r.q2)}</td><td class="num-c b">${esc(r.q3)}</td>`
          : `<td class="num-c hide-sm muted">${r.grid === 0 ? 'PL' : esc(r.grid ?? '')}</td><td class="num-c">${esc(timeCell)}</td><td class="num-c b">${r.points ? +r.points : ''}</td>`}
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="hint chart-note">${esc(data.name || '')} ${data.date ? `· ${fmtDay.format(new Date(data.date))}` : ''}${q ? '' : ' · FL = fastest lap · PL = pit lane start'}</p>`;
  setBody(key, tools, html);
}

// ---------- tooltip ----------
const tip = $('tip');
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, ev.clientY - r.height - 14);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  tip.hidden = true;
  const cross = document.getElementById('rtCross');
  if (cross) cross.setAttribute('visibility', 'hidden');
}
$('insBody').addEventListener('pointermove', (ev) => {
  const st = ev.target.closest('[data-tip]');
  if (st) return showTip(ev, esc(st.dataset.tip));
  if (ev.target.closest('svg.trace')) return traceHover(ev);
  hideTip();
});
$('insBody').addEventListener('pointerleave', hideTip);
$('insBody').addEventListener('pointerdown', (ev) => { if (ev.pointerType !== 'mouse') ev.target.closest('svg.trace') ? traceHover(ev) : null; });

// ---------- settings ----------
function openSettings() {
  $('delay').value = delay;
  $('delayVal').textContent = `${delay} s`;
  // Favourite: drivers in the session, else the championship list.
  const opts = new Map();
  for (const d of Object.values(DL())) if (d?.Tla) opts.set(d.Tla, `${d.Tla} · ${d.FullName || d.BroadcastName || ''}`);
  for (const d of standings?.drivers || []) if (d.code && !opts.has(d.code)) opts.set(d.code, `${d.code} · ${d.name}`);
  if (fav && !opts.has(fav)) opts.set(fav, fav);
  $('favSelect').innerHTML = `<option value="">None</option>${[...opts].sort((a, b) => a[0].localeCompare(b[0])).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}`;
  $('favSelect').value = fav;
  const base = `${location.host}${location.pathname.replace(/[^/]*$/, '')}calendar.ics`;
  const links = [['All sessions', ''], ['Race, qualifying and sprint only', '?main=1'], ['All sessions, alert 15 min before', '?alarm=15']];
  $('calLinks').innerHTML = links.map(([l, q]) => `<div class="cal-row"><a href="webcal://${esc(base + q)}">${esc(l)}</a><button type="button" class="btn sm" data-copy="${esc(`${location.protocol}//${base}${q}`)}">Copy link</button></div>`).join('');
  renderSettings();
  $('settings').showModal();
}

function renderSettings() {
  const t = status?.token;
  const el = $('tokenState');
  if (status?.live?.tokenRejected) { el.textContent = 'Rejected — paste a fresh one'; el.className = 'bad'; }
  else if (!t?.present) { el.textContent = 'Not set'; el.className = 'warn'; }
  else if (t.expires && new Date(t.expires) < new Date()) { el.textContent = `Expired ${fmtDay.format(new Date(t.expires))}`; el.className = 'bad'; }
  else {
    const parts = [t.source === 'auto' ? 'Gathered automatically from formula1.com' : 'Pasted manually'];
    if (t.source === 'auto' && t.savedAt) parts.push(`renewed ${fmtDay.format(new Date(t.savedAt))}`);
    if (t.expires) parts.push(`valid until ${fmtDay.format(new Date(t.expires))}`);
    el.textContent = parts.join(' · ');
    el.className = 'ok';
  }
  const l = status?.live || {};
  const ago = l.lastMessageAt ? `${Math.round((Date.now() + offset - l.lastMessageAt) / 1000)}s ago` : 'never';
  $('connInfo').textContent = [
    status?.demo ? 'Demo mode' : status?.liveWindow ? 'Session window open' : 'Standby until 45 min before the next session',
    `F1 feed: ${l.status || '—'}`,
    `last data ${ago}`,
    `car positions ${l.positionEnabled ? 'on' : 'off'}`,
    l.lastError ? `note: ${l.lastError}` : '',
  ].filter(Boolean).join(' · ');
}

$('settingsBtn').addEventListener('click', openSettings);
$('favSelect').addEventListener('change', (e) => {
  fav = e.target.value;
  store.set('fav', fav);
  teleTla = '';
  store.set('teleTla', '');
  insKey = ''; radioKey = ''; teleOptsKey = '';
  dirty = true;
});
$('calLinks').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
  catch { prompt('Copy this link:', b.dataset.copy); }
});
// Tap a row in the timing tower to show that driver's telemetry.
$('tower').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-num]');
  if (!tr || !isLive()) return;
  teleTla = tlaOf(tr.dataset.num);
  store.set('teleTla', teleTla);
  dirty = true;
});
$('teleDriver').addEventListener('change', (e) => { teleTla = e.target.value; store.set('teleTla', teleTla); dirty = true; });
$('radioFilter').addEventListener('click', () => { radioMine = !radioMine; store.set('radioMine', radioMine); dirty = true; });
$('radio').addEventListener('click', (e) => {
  const b = e.target.closest('[data-radio]');
  if (!b) return;
  const url = b.dataset.radio;
  if (playing === url) { audio.pause(); playing = null; }
  else { audio.src = url; audio.play().catch(() => { playing = null; radioKey = ''; dirty = true; }); playing = url; }
  radioKey = '';
  dirty = true;
});
document.querySelectorAll('#insTabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
  insTab = b.dataset.tab; store.set('insTab', insTab); insKey = ''; hideTip(); dirty = true;
}));
$('insCard').addEventListener('click', (e) => {
  const t = e.target.closest('[data-trace-filter],[data-trace-focus],[data-stand],[data-res-kind]');
  if (!t) return;
  if (t.dataset.traceFilter != null) { traceFilter = Number(t.dataset.traceFilter); store.set('traceFilter', traceFilter); }
  if (t.dataset.traceFocus != null) traceFocus = traceFocus === t.dataset.traceFocus ? null : t.dataset.traceFocus;
  if (t.dataset.stand) { standTab = t.dataset.stand; store.set('standTab', standTab); }
  if (t.dataset.resKind) { resSel = { ...resSel, kind: t.dataset.resKind }; store.set('resSel', resSel); }
  insKey = '';
  dirty = true;
});
$('insCard').addEventListener('change', (e) => {
  if (e.target.id !== 'resRound') return;
  resSel = { ...resSel, round: Number(e.target.value) };
  store.set('resSel', resSel);
  insKey = '';
  dirty = true;
});
let lastW = window.innerWidth;
window.addEventListener('resize', () => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; insKey = ''; dirty = true; } });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-settings]')) openSettings();
});
$('delay').addEventListener('input', (e) => { $('delayVal').textContent = `${e.target.value} s`; });
$('delay').addEventListener('change', (e) => {
  delay = Number(e.target.value);
  store.set('delay', delay);
  connect(); // rebuild state from the server's buffer at the new delay
});
$('gapToggle').addEventListener('click', () => {
  gapMode = gapMode === 'int' ? 'gap' : 'int';
  store.set('gapMode', gapMode);
  dirty = true;
});
$('tokenSave').addEventListener('click', async () => {
  const msg = $('tokenMsg');
  msg.textContent = 'Saving…';
  try {
    const res = await fetch('api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: $('tokenInput').value }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    status = j;
    $('tokenInput').value = '';
    msg.textContent = 'Saved — reconnecting to the feed.';
    renderSettings();
  } catch (e) { msg.textContent = e.message; }
});
$('tokenClear').addEventListener('click', async () => {
  const res = await fetch('api/token', { method: 'DELETE' });
  status = await res.json();
  $('tokenMsg').textContent = 'Removed.';
  renderSettings();
});

// ---------- loop ----------
function render() {
  renderHeader();
  renderNext();
  renderWeekend();
  renderTower();
  renderMap();
  renderTele();
  renderRC();
  renderRadio();
  renderInsights();
  if ($('settings').open) renderSettings();
}

setInterval(drain, 200);
setInterval(() => { dirty = true; }, 1000); // clocks and countdowns
setInterval(loadSchedule, 10 * 60000);
setInterval(() => loadStandings(), 60000);
(function frame() {
  if (dirty) { dirty = false; render(); }
  requestAnimationFrame(frame);
})();

loadSchedule();
connect();
