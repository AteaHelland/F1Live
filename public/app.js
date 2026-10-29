import { applyItem, clone, list } from './merge.js';

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
    status = d.status;
    drain();
    dirty = true;
  });
  es.onmessage = (e) => queue.push(JSON.parse(e.data));
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
    state = applyItem(state, queue.shift());
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
  const rem = live ? clockRemaining() : null;
  $('clockInfo').innerHTML = rem ? `<b>${rem}</b> left` : '';

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

  const rows = Object.entries(lines)
    .filter(([num, l]) => l && (drivers[num] || l.Position))
    .sort(([, a], [, b]) => (Number(a.Position) || a.Line || 99) - (Number(b.Position) || b.Line || 99));
  $('towerEmpty').hidden = rows.length > 0;

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
    return `<tr class="${out ? 'out' : ''}${l.InPit ? ' inpit' : ''}">
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

  const w = state.WeatherData;
  $('weather').textContent = w && hasSession()
    ? `Air ${Math.round(w.AirTemp)}° · Track ${Math.round(w.TrackTemp)}°${w.Rainfall === '1' ? ' · Rain' : ''}` : '';

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
  }
}

// ---------- race control ----------
function renderRC() {
  const msgs = list(state.RaceControlMessages?.Messages).slice(-10).reverse();
  $('rc').innerHTML = msgs.length
    ? msgs.map((m) => {
      const flag = m.Category === 'SafetyCar' ? 'SC' : (m.Flag || '').replace(/\s+/g, '-');
      const t = m.Utc ? fmtTimeSec.format(parseUtc(m.Utc)) : '';
      return `<li><span class="when">${t}</span><span class="msg">${flag ? `<span class="flag ${esc(flag)}"></span>` : ''}${esc(m.Message)}</span></li>`;
    }).join('')
    : '<li class="muted"><span></span><span>No messages yet.</span></li>';
}

// ---------- settings ----------
function openSettings() {
  $('delay').value = delay;
  $('delayVal').textContent = `${delay} s`;
  renderSettings();
  $('settings').showModal();
}

function renderSettings() {
  const t = status?.token;
  const el = $('tokenState');
  if (status?.live?.tokenRejected) { el.textContent = 'Rejected — paste a fresh one'; el.className = 'bad'; }
  else if (!t?.present) { el.textContent = 'Not set'; el.className = 'warn'; }
  else if (t.expires && new Date(t.expires) < new Date()) { el.textContent = `Expired ${fmtDay.format(new Date(t.expires))}`; el.className = 'bad'; }
  else { el.textContent = t.expires ? `Saved · valid until ${fmtDay.format(new Date(t.expires))}` : 'Saved'; el.className = 'ok'; }
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
  renderWeekend();
  renderTower();
  renderMap();
  renderRC();
  if ($('settings').open) renderSettings();
}

setInterval(drain, 200);
setInterval(() => { dirty = true; }, 1000); // clocks and countdowns
setInterval(loadSchedule, 10 * 60000);
(function frame() {
  if (dirty) { dirty = false; render(); }
  requestAnimationFrame(frame);
})();

loadSchedule();
connect();
