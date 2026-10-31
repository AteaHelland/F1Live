import { applyItem, clone, list, sessionKey, stintRanges } from './merge.js';
import { strategyChart, raceTrace, sparkline, teleTrace, lapChart, COMPOUND_LETTER } from './charts.js';

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
let pitLossManual = store.get('pitLoss', 0); // 0 = automatic
let mapHidden = new Set(store.get('mapHidden', [])); // driver codes hidden on the track map
let showKO = store.get('showKO', false);
let wakeMode = store.get('wake', 'live'); // off | live | always // qualifying: show drivers knocked out in earlier parts
let units = { temp: 'C', speed: 'kmh', ...store.get('units', {}) };
let traceFilter = store.get('traceFilter', 10);
let traceFocus = null;       // driver number highlighted from the legend
let standings = null, standingsErr = null, standingsAt = 0;
let standTab = store.get('standTab', 'drivers');
let season = null, seasonErr = null;
let resSel = store.get('resSel', null); // { year, round, kind }
let h2h = store.get('h2h', { a: '', b: '' }); // driver codes
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
// Cars out on track: not in the pit lane, not knocked out, retired or stopped.
const carsOnTrack = () => Object.values(state.TimingData?.Lines || {})
  .filter((l) => l && l.InPit === false && !l.KnockedOut && !l.Retired && !l.Stopped).length;
// Qualifying after the clock has run out: the part isn't over until every car is back in the
// pit lane, because the laps started before the flag still count.
const qualiRunDown = () => sessionType() === 'Qualifying' && clockSecs() === 0 && carsOnTrack() > 0;
const isLive = () => hasSession() && status?.live?.status === 'connected' &&
  (['Started', 'Aborted'].includes(sessionStatus()) || qualiRunDown());

// ---------- what kind of session this is ----------
// F1's feed has been seen labelling a practice session as the race (with race-style laps and
// gaps). When the calendar says practice or qualifying is on, the calendar wins, so race-only
// features stay off. The calendar never overrides in the other direction.
const CAL_TYPE = {
  FirstPractice: 'Practice', SecondPractice: 'Practice', ThirdPractice: 'Practice',
  Qualifying: 'Qualifying', SprintQualifying: 'Qualifying', SprintShootout: 'Qualifying', Sprint: 'Race', Race: 'Race',
};
// The latest calendar session that has started (or is about to) and isn't long over.
function calendarSession(now = Date.now()) {
  if (status?.demo) return null;
  let found = null;
  for (const s of schedule?.next?.sessions || []) {
    const start = new Date(s.start).getTime();
    if (now >= start - 20 * 60000 && now <= start + s.minutes * 60000 + 90 * 60000) found = s;
  }
  return found;
}
function feedMislabelled() {
  const cal = calendarSession();
  return cal && state.SessionInfo?.Type === 'Race' && CAL_TYPE[cal.key] && CAL_TYPE[cal.key] !== 'Race' ? cal : null;
}
const sessionType = () => { const m = feedMislabelled(); return m ? CAL_TYPE[m.key] : state.SessionInfo?.Type; };
const sessionName = () => feedMislabelled()?.name || state.SessionInfo?.Name;

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

// Drivers in running order. In practice that's by best lap, worked out here so it's right
// even when the feed sends race-style positions.
const bestOf = (l) => parseLap(l?.BestLapTime?.Value || lastWith(l?.BestLapTimes, 'Value'));
const isPracticeView = () => sessionType() !== 'Race' && !qInfo();
function runningOrder() {
  const lines = state.TimingData?.Lines || {};
  const feedPos = (l) => Number(l.Position) || l.Line || 99;
  const rows = Object.entries(lines).filter(([num, l]) => l && (DL()[num] || l.Position));
  if (isPracticeView()) {
    return rows.sort(([, a], [, b]) => {
      const ba = bestOf(a), bb = bestOf(b);
      if (ba != null && bb != null) return ba - bb;
      if (ba != null) return -1;
      if (bb != null) return 1;
      return feedPos(a) - feedPos(b);
    });
  }
  return rows.sort(([, a], [, b]) => feedPos(a) - feedPos(b));
}

// The position to show: rank by best lap in practice, the feed's position otherwise.
function posOf(num) {
  const order = runningOrder();
  if (isPracticeView()) { const i = order.findIndex(([n]) => n === num); return i >= 0 ? i + 1 : ''; }
  return state.TimingData?.Lines?.[num]?.Position || '';
}

// Practice: position and gaps from best laps.
function practiceGaps(rows) {
  const out = {};
  let fastest = null, prev = null;
  rows.forEach(([num, l], i) => {
    const b = bestOf(l);
    if (b != null && fastest == null) fastest = b;
    out[num] = {
      pos: i + 1,
      gap: b != null && i > 0 ? `+${(b - fastest).toFixed(3)}` : '',
      int: b != null && prev != null && i > 0 ? `+${(b - prev).toFixed(3)}` : '',
    };
    if (b != null) prev = b;
  });
  return out;
}

function addTelemetry(data) {
  for (const e of list(data?.Entries)) {
    const t = e.Utc ? parseUtc(e.Utc).getTime() : Date.now();
    for (const [num, c] of Object.entries(e.Cars || {})) {
      let buf = teleBuf.get(num);
      if (!buf) teleBuf.set(num, (buf = []));
      if (buf.length && t <= buf[buf.length - 1].t) continue;
      // With the engine off (garage) the throttle and brake channels carry junk; zero them.
      const off = c[0] < 500 && c[1] < 1;
      buf.push({ t, rpm: c[0], v: c[1], gear: c[2], thr: off ? 0 : Math.min(100, c[3]), brk: off ? 0 : c[4], off });
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

function clockSecs() {
  const c = state.ExtrapolatedClock;
  if (!c?.Remaining) return null;
  const [h, m, s] = c.Remaining.split(':').map(Number);
  let secs = h * 3600 + m * 60 + s;
  if (c.Extrapolating && c.Utc) secs -= (shownNow() - parseUtc(c.Utc).getTime()) / 1000;
  return Math.max(0, Math.floor(secs));
}

function clockRemaining() {
  const secs = clockSecs();
  if (secs == null) return null;
  return `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

// ---------- header ----------
function renderHeader() {
  const si = state.SessionInfo;
  const live = isLive();
  document.body.classList.toggle('is-live', live);
  $('sessionTitle').textContent = si?.Name
    ? `${si.Meeting?.Name || ''} · ${sessionName()}`
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
  $('flagbar').dataset.status = live && qualiRunDown() ? 'chq' : live && code ? code : 'none';

  const lc = state.LapCount;
  $('lapInfo').innerHTML = hasSession() && lc?.CurrentLap && sessionType() === 'Race'
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
    const q = isLive() ? qInfo() : null;
    const name = isLive() && si?.Name ? `${sessionName()}${q ? ` · ${q.label}` : ''}` : onNow?.name;
    const gp = isLive() && si?.Meeting?.Name ? si.Meeting.Name : wk?.name;
    const rem = isLive() ? clockRemaining() : null;
    const n = carsOnTrack();
    const count = isLive() && qualiRunDown()
      ? `🏁 ${n} car${n === 1 ? '' : 's'} on track`
      : rem ? `${rem} left` : onNow ? `until ${fmtTime.format(new Date(onNow.endMs))}` : '';
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

// ---------- qualifying ----------
const isQuali = () => sessionType() === 'Qualifying';
const at = (arr, i) => (arr ? arr[i] ?? arr[String(i)] : undefined); // arrays become index-keyed objects after merges

// Which part is running and how many cars go through to the next one.
function qInfo() {
  if (!isQuali()) return null;
  const td = state.TimingData || {};
  const part = Number(td.SessionPart) || 0;
  if (!part) return null;
  const entries = list(td.NoEntries).map(Number);
  const prefix = /sprint/i.test(sessionName() || '') ? 'SQ' : 'Q';
  const advance = part < entries.length ? entries[part] : null;
  return { part, prefix, label: `${prefix}${part}`, advance, entries };
}
const partBest = (l, part) => at(l?.BestLapTimes, part - 1)?.Value || '';
const partStat = (l, part, key) => at(l?.Stats, part - 1)?.[key] || '';

// The part a knocked-out driver went out in, from where they finished.
function koPart(l, q) {
  const p = Number(l.Position);
  for (let i = 1; i < q.entries.length; i++) if (p > q.entries[i]) return `${q.prefix}${i}`;
  return 'OUT';
}

// Best time in this part of the last car that goes through.
function cutoff(rows, q) {
  if (!q?.advance) return null;
  const row = rows.find(([, l]) => Number(l.Position) === q.advance);
  const t = row ? partBest(row[1], q.part) : '';
  return t ? { time: t, secs: parseLap(t) } : null;
}

// ---------- pit window ----------
// Rough time lost to a green-flag pit stop, by circuit (adjustable in settings).
const PIT_LOSS = [
  ['sakhir', 23], ['bahrain', 23], ['jeddah', 20], ['melbourne', 19], ['albert park', 19], ['suzuka', 22],
  ['shanghai', 23], ['miami', 20], ['monte carlo', 20], ['monaco', 20], ['catalunya', 22], ['barcelona', 22],
  ['montreal', 19], ['spielberg', 20], ['silverstone', 21], ['spa', 21], ['hungaroring', 21], ['zandvoort', 20],
  ['monza', 24], ['madr', 22], ['baku', 21], ['singapore', 28], ['marina bay', 28], ['austin', 21],
  ['mexico', 22], ['interlagos', 21], ['sao paulo', 21], ['las vegas', 21], ['lusail', 25], ['yas', 22],
];
function pitLoss() {
  if (pitLossManual) return { secs: pitLossManual, source: 'set by you' };
  const n = String(state.SessionInfo?.Meeting?.Circuit?.ShortName || state.SessionInfo?.Meeting?.Location || '').toLowerCase();
  const hit = n && PIT_LOSS.find(([k]) => n.includes(k));
  return hit ? { secs: hit[1], source: 'typical for this circuit' } : { secs: 22, source: 'default' };
}

const gapSec = (l) => {
  if (String(l?.Position) === '1') return 0;
  const m = /^\+?(\d+(?:\.\d+)?)$/.exec(String(l?.GapToLeader ?? '').trim());
  return m ? Number(m[1]) : null;
};
function parseLap(v) {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(v || '').trim());
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
}

// Where each driver would rejoin if they pitted now: their gap to the leader plus the pit loss
// (less under a safety car or VSC), placed among the cars on the lead lap.
function pitWindow() {
  if (!isRaceSession() || !hasSession()) return null;
  const cars = runningOrder().map(([n, l]) => ({ n, l, g: gapSec(l) }))
    .filter((c) => c.g != null && !c.l.Retired && !c.l.Stopped)
    .sort((a, b) => a.g - b.g);
  if (cars.length < 2) return null;
  const code = state.TrackStatus?.Status;
  const factor = code === '4' ? 0.55 : code === '6' || code === '7' ? 0.65 : 1;
  const base = pitLoss();
  const loss = base.secs * factor;
  const map = {};
  for (const c of cars) {
    if (c.l.InPit) continue;
    const G = c.g + loss;
    const others = cars.filter((o) => o.n !== c.n);
    const before = others.filter((o) => o.g <= G);
    const ahead = before[before.length - 1];
    const behind = others.find((o) => o.g > G);
    map[c.n] = { pos: before.length + 1, G, ahead: ahead && { n: ahead.n, d: G - ahead.g }, behind: behind && { n: behind.n, d: behind.g - G } };
  }
  return { map, loss, factor, ...base };
}
const pitText = (w) => `Pit now → P${w.pos}${w.ahead ? `, ${w.ahead.d.toFixed(1)}s behind ${tlaOf(w.ahead.n)}` : ''}${w.behind ? `, ${w.behind.d.toFixed(1)}s ahead of ${tlaOf(w.behind.n)}` : ''}`;

const EYE_ON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.3 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

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
  const kind = sessionType() === 'Race' ? 'race' : 'other';
  const table = $('tower');
  table.dataset.kind = kind;
  table.dataset.gapmode = gapMode;
  $('gapToggle').textContent = gapMode === 'int' ? 'Interval' : 'Gap';
  $('gapToggle').style.visibility = kind === 'race' ? 'visible' : 'hidden';
  const q = qInfo();
  const rows = runningOrder();
  const cut = cutoff(rows, q);
  $('towerTitle').textContent = state.SessionInfo?.Name
    ? `${sessionName()}${q ? ` · ${q.label}` : ''}${isLive() ? '' : ' · last data'}` : 'Timing';
  const qbar = $('qBar');
  if (q && hasSession()) {
    qbar.innerHTML = `<span class="q-part">${esc(q.label)}</span>${q.advance
      ? `<span>Top <b>${q.advance}</b> go through to ${esc(q.prefix)}${q.part + 1}</span><span class="q-cut">Cut-off ${cut ? `<b>${esc(cut.time)}</b> (P${q.advance})` : '<b>–</b>'}</span>`
      : '<span>Final part: fight for pole</span>'}${qualiRunDown() ? `<span class="q-chq">🏁 Chequered flag · ${carsOnTrack()} still on a lap</span>` : ''}`;
    qbar.hidden = false;
  } else qbar.hidden = true;

  $('towerEmpty').hidden = rows.length > 0;
  const fnum = favNum();
  const tnum = teleNum();
  const pw = kind === 'race' ? pitWindow() : null;
  const pg = kind !== 'race' && !q ? practiceGaps(rows) : null;
  $('ghostHead').title = pw ? `Where each driver would rejoin if they pitted now (pit loss ${pw.loss.toFixed(1)} s, ${pw.source}${pw.factor < 1 ? ', reduced under safety car' : ''})` : '';

  // Qualifying: drivers knocked out in earlier parts fold into one line at the bottom.
  const ko = q && q.part > 1 ? rows.filter(([, l]) => l.KnockedOut) : [];
  const shownRows = ko.length && !showKO ? rows.filter(([, l]) => !l.KnockedOut) : rows;
  const koByPart = {};
  for (const [num, l] of ko) (koByPart[koPart(l, q)] ||= []).push(tlaOf(num));
  const koLine = ko.length
    ? `<tr class="ko-row"><td colspan="13"><button type="button" class="ko-btn" data-ko>${Object.entries(koByPart).sort().map(([part, tlas]) => `<span><b>Out in ${esc(part)}:</b> ${tlas.map(esc).join(', ')}</span>`).join('')}<span class="ko-act">${showKO ? 'Hide ▴' : 'Show ▾'}</span></button></td></tr>`
    : '';
  table.tBodies[0].innerHTML = shownRows.map(([num, l]) => {
    const d = drivers[num] || {};
    const out = l.Retired || l.Stopped || l.KnockedOut;
    let gap, int;
    if (kind === 'race') {
      gap = l.GapToLeader ?? '';
      int = l.IntervalToPositionAhead?.Value ?? '';
    } else if (q) {
      gap = partStat(l, q.part, 'TimeDiffToFastest');
      int = partStat(l, q.part, 'TimeDiffToPositionAhead');
    } else {
      gap = pg[num].gap;
      int = pg[num].int;
    }
    const leadCls = (v) => (/^LAP/i.test(v) ? ' lead' : '');
    const last = l.LastLapTime || {};
    const lastCls = last.OverallFastest ? 't-ob' : last.PersonalFastest ? 't-pb' : '';
    const best = q
      ? (l.KnockedOut ? lastWith(l.BestLapTimes, 'Value') : partBest(l, q.part))
      : l.BestLapTime?.Value || lastWith(l.BestLapTimes, 'Value');
    const pos = Number(l.Position);
    const dz = q?.advance && !l.KnockedOut && pos > q.advance;
    const cutRow = q?.advance && pos === q.advance;
    const w = pw?.map[num];
    const secs = list(l.Sectors);
    const stints = list(app[num]?.Stints);
    const st = stints[stints.length - 1];
    const comp = (st?.Compound || '').toUpperCase();
    const tyre = st
      ? `<span class="tyre"><span class="t ${esc(comp)}"><span>${LETTER[comp] || '?'}</span></span><span class="age">${st.TotalLaps ?? ''}</span>${st.New === 'false' ? '<span class="used" title="Used set">u</span>' : ''}</span>`
      : '';
    return `<tr data-num="${esc(num)}" class="${out ? 'out' : ''}${l.InPit ? ' inpit' : ''}${num === fnum ? ' fav' : ''}${num === tnum && isLive() ? ' sel' : ''}${dz ? ' dz' : ''}${cutRow ? ' cut' : ''}">
      <td class="c-vis"><button type="button" class="vis${mapHidden.has(d.Tla || num) ? ' off' : ''}" data-vis="${esc(d.Tla || num)}" aria-pressed="${!mapHidden.has(d.Tla || num)}" aria-label="${mapHidden.has(d.Tla || num) ? 'Show' : 'Hide'} ${esc(d.Tla || num)} on the map">${mapHidden.has(d.Tla || num) ? EYE_OFF : EYE_ON}</button></td>
      <td class="c-pos">${esc(pg ? pg[num].pos : l.Position || '')}</td>
      <td class="c-drv"><span class="drv"><span class="bar" style="background:#${esc(d.TeamColour || '666')}"></span><span class="num">${esc(num)}</span><span class="tla">${esc(d.Tla || num)}</span><span class="team">${esc(d.TeamName || '')}</span></span></td>
      <td class="c-gap${leadCls(gap)}">${out ? `<span class="badge out">${l.KnockedOut && q ? esc(koPart(l, q)) : 'OUT'}</span>` : esc(gap)}</td>
      <td class="c-int${leadCls(int)}">${out ? '' : esc(int)}</td>
      <td class="c-last ${lastCls}">${esc(last.Value || '')}</td>
      <td class="c-best">${esc(best || '')}</td>
      <td class="c-sec">${secCell(secs[0])}</td>
      <td class="c-sec">${secCell(secs[1])}</td>
      <td class="c-sec">${secCell(secs[2])}</td>
      <td class="c-tyre">${l.InPit ? '<span class="badge">PIT</span>' : tyre}</td>
      <td class="c-ghost${w && w.pos > pos ? ' drop' : ''}"${w ? ` title="${esc(pitText(w))}"` : ''}>${w ? `P${w.pos}` : ''}</td>
      <td class="c-pit">${l.NumberOfPitStops || ''}</td>
    </tr>`;
  }).join('') + koLine;
  renderFavBar(rows, kind);
}

// "Your driver": position plus the gaps to the cars ahead and behind.
function renderFavBar(rows, kind) {
  const bar = $('favBar');
  const fnum = favNum();
  const i = rows.findIndex(([num]) => num === fnum);
  if (!fnum || i < 0 || !hasSession()) { bar.hidden = true; return; }
  const [, l] = rows[i];
  const qi = qInfo();
  const pgs = kind !== 'race' && !qi ? practiceGaps(rows) : null;
  const numOfLine = (line) => rows.find(([, x]) => x === line)?.[0];
  const gapOf = (line) => (pgs ? pgs[numOfLine(line)]?.int : kind === 'race'
    ? line?.IntervalToPositionAhead?.Value
    : qi ? partStat(line, qi.part, 'TimeDiffToPositionAhead')
      : lastWith(line?.Stats, 'TimeDiffToPositionAhead') || line?.TimeDiffToPositionAhead) || '';
  const ahead = rows[i - 1], behind = rows[i + 1];
  const st = list(state.TimingAppData?.Lines?.[fnum]?.Stints).pop();
  const comp = (st?.Compound || '').toUpperCase();
  const parts = [
    `<span class="fb-me"><span class="bar" style="background:${colorOf(fnum)}"></span><b>${esc(tlaOf(fnum))}</b> <span class="fb-pos">P${esc(posOf(fnum) || '–')}</span></span>`,
  ];
  if (l.Retired || l.Stopped) parts.push('<span class="muted">Out</span>');
  else {
    if (ahead) parts.push(`<span class="fb-gap"><span class="muted">Ahead</span> <b>${esc(tlaOf(ahead[0]))}</b> ${esc(gapOf(l) || '–')}</span>`);
    if (behind && !(behind[1].Retired || behind[1].Stopped)) parts.push(`<span class="fb-gap"><span class="muted">Behind</span> <b>${esc(tlaOf(behind[0]))}</b> ${esc(gapOf(behind[1]) || '–')}</span>`);
    if (st) parts.push(`<span class="fb-gap"><span class="muted">Tyre</span> <b>${LETTER[comp] || '?'}</b> ${esc(st.TotalLaps ?? '')} laps</span>`);
    if (l.LastLapTime?.Value) parts.push(`<span class="fb-gap"><span class="muted">Last</span> ${esc(l.LastLapTime.Value)}</span>`);
    const q = qInfo();
    if (q?.advance && !l.KnockedOut) {
      const cut = cutoff(rows, q);
      const mine = parseLap(partBest(l, q.part));
      const pos = Number(l.Position);
      if (mine == null) parts.push('<span class="fb-gap"><span class="muted">No time yet in</span> <b>' + esc(q.label) + '</b></span>');
      else if (pos > q.advance && cut) parts.push(`<span class="fb-gap q-risk"><span class="muted">Needs</span> <b>−${(mine - cut.secs).toFixed(3)}</b> to get through</span>`);
      else {
        const first = rows.find(([, x]) => Number(x.Position) === q.advance + 1);
        const fdz = first ? parseLap(partBest(first[1], q.part)) : null;
        if (fdz != null) parts.push(`<span class="fb-gap q-safe"><span class="muted">Clear of the drop zone by</span> <b>${(fdz - mine).toFixed(3)}</b></span>`);
      }
    }
    const w = kind === 'race' ? pitWindow()?.map[fnum] : null;
    if (w) parts.push(`<span class="fb-gap"><span class="muted">${esc(pitText(w).split(',')[0])}</span>${w.ahead ? ` ${w.ahead.d.toFixed(1)}s behind <b>${esc(tlaOf(w.ahead.n))}</b>` : ''}</span>`);
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
let trackLayer, flagLayer, ghostLayer, carLayer;
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
  ghostLayer = document.createElementNS(SVGNS, 'g');
  carLayer = document.createElementNS(SVGNS, 'g');
  svg.append(trackLayer, flagLayer, ghostLayer, carLayer);
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
  const nHidden = Object.values(state.DriverList || {}).filter((d) => d?.Tla && mapHidden.has(d.Tla)).length;
  $('mapShowAll').hidden = !nHidden;
  $('mapShowAll').textContent = `${nHidden} hidden · Show all`;
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
    const koHidden = !showKO && state.TimingData?.Lines?.[num]?.KnockedOut && qInfo()?.part > 1;
    g.style.display = mapHidden.has(d.Tla || num) || koHidden ? 'none' : '';
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
  renderGhost(entries);
}

// ---------- units ----------
// The feed is metric (°C, km/h, wind in m/s); these convert for display only.
const imperialSpeed = () => units.speed === 'mph';
const tempVal = (c) => (units.temp === 'F' ? Number(c) * 1.8 + 32 : Number(c));
const tempDelta = (d) => (units.temp === 'F' ? d * 1.8 : d);
const tempStr = (c) => `${tempVal(c).toFixed(1)}°${units.temp === 'F' ? 'F' : ''}`;
const speedVal = (kmh) => (imperialSpeed() ? Math.round(Number(kmh) * 0.621371) : Math.round(Number(kmh)));
const speedUnit = () => (imperialSpeed() ? 'mph' : 'km/h');
const windStr = (ms) => (imperialSpeed() ? [(Number(ms) * 2.23694).toFixed(1), 'mph'] : [Number(ms).toFixed(1), 'm/s']);

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
  const trend = Math.abs(dT) >= 0.5 ? `<span class="wx-trend">${dT > 0 ? '▲' : '▼'} ${Math.abs(tempDelta(dT)).toFixed(1)}°</span>` : '';
  const [windV, windU] = windStr(w.WindSpeed);
  const dir = Number(w.WindDirection);
  const hasDir = Number.isFinite(dir) && w.WindDirection != null;
  const rain = w.Rainfall === '1' || w.Rainfall === 1;
  el.innerHTML = `
    <div class="wx-item"><span class="wx-k">Air</span><span class="wx-v">${tempStr(w.AirTemp)}</span></div>
    <div class="wx-item"><span class="wx-k">Track</span><span class="wx-v">${tempStr(w.TrackTemp)}${trend}</span>${sparkline(track)}</div>
    <div class="wx-item"><span class="wx-k">Humidity</span><span class="wx-v">${Math.round(w.Humidity)}<span class="wx-u">%</span></span></div>
    <div class="wx-item"><span class="wx-k">Wind</span><span class="wx-v">${hasDir ? `<span class="wx-arrow" style="transform:rotate(${dir + 180}deg)" title="From ${COMPASS[Math.round(dir / 45) % 8]}">↑</span>` : ''}${windV}<span class="wx-u">${windU}${hasDir ? ` ${COMPASS[Math.round(dir / 45) % 8]}` : ''}</span></span></div>
    <div class="wx-item"><span class="wx-k">Weather</span><span class="wx-v ${rain ? 'wx-rain' : ''}">${rain ? '🌧 Raining' : 'Dry'}</span></div>`;
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
  const key = order.map(([n]) => n).join(',') + fav + isPracticeView();
  const num = teleNum();
  if (key !== teleOptsKey) {
    teleOptsKey = key;
    sel.innerHTML = order.map(([n], i) => `<option value="${esc(tlaOf(n))}">P${esc(isPracticeView() ? i + 1 : state.TimingData.Lines[n].Position || '')} ${esc(tlaOf(n))}${tlaOf(n) === fav ? ' ★' : ''}</option>`).join('');
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
  const line = state.TimingData?.Lines?.[num] || {};
  const parked = s.off || (line.InPit && s.v < 1);
  const where = line.InPit || s.off ? 'In the garage' : 'Stopped';
  el.innerHTML = `
    <div class="tele-top">
      <div class="tele-big"><span class="tele-speed">${speedVal(s.v)}</span><span class="tele-unit">${speedUnit()}</span></div>
      <div class="tele-gear"><span class="tele-k">Gear</span><b>${s.gear || 'N'}</b></div>
      ${parked ? `<div class="tele-parked">${where}<span class="muted">${s.off ? ' · engine off' : ''}</span></div>` : ''}
      <div class="tele-bars"${parked ? ' hidden' : ''}>
        <div class="tb"><span class="tele-k">RPM</span><span class="tb-track"><span class="tb-fill rpm" style="width:${rpmPct}%"></span></span><span class="tb-v">${s.rpm.toLocaleString('en-GB')}</span></div>
        <div class="tb"><span class="tele-k">Throttle</span><span class="tb-track"><span class="tb-fill thr" style="width:${Math.min(100, s.thr)}%"></span></span><span class="tb-v">${s.thr}%</span></div>
        <div class="tb"><span class="tele-k">Brake</span><span class="tb-track"><span class="tb-fill brk" style="width:${s.brk > 0 ? 100 : 0}%"></span></span><span class="tb-v">${s.brk > 0 ? 'On' : 'Off'}</span></div>
      </div>
    </div>
    ${teleTrace(imperialSpeed() ? buf.map((x) => ({ ...x, v: x.v * 0.621371 })) : buf,
    imperialSpeed() ? { width: el.clientWidth - 24, max: 225, ticks: [50, 100, 150, 200] } : { width: el.clientWidth - 24 })}`;
}

// Pit window ghost on the map: where the favourite (or the telemetry driver) would rejoin
// if they pitted now, between the two cars around that spot.
let ghostKey = '';
function renderGhost(entries) {
  if (!ghostLayer || !geom || !circuit?.x?.length) return;
  const target = (isLive() && favNum()) || (isLive() ? teleNum() : null);
  const w = target && !mapHidden.has(tlaOf(target)) ? pitWindow()?.map[target] : null;
  if (!w || !entries) { if (ghostKey) { ghostLayer.innerHTML = ''; ghostKey = ''; } return; }
  const N = circuit.x.length;
  const idxOf = (num) => (entries[num] ? nearestIndex({ x: entries[num].X, y: entries[num].Y }) : null);
  const A = w.ahead ? idxOf(w.ahead.n) : null;
  const B = w.behind ? idxOf(w.behind.n) : null;
  let k = null;
  if (A != null && B != null) {
    const span = (A - B + N) % N; // forward along the track from the car behind to the car ahead
    const tot = w.ahead.d + w.behind.d;
    k = Math.round(B + span * (tot > 0 ? w.behind.d / tot : 0.5)) % N;
  } else if (A != null) {
    const lapSec = parseLap(state.TimingData?.Lines?.[target]?.LastLapTime?.Value) || 90;
    k = Math.round(A - (w.ahead.d / lapSec) * N + N * 10) % N;
  }
  if (k == null) { ghostLayer.innerHTML = ''; ghostKey = ''; return; }
  const key = `${target}|${k}`;
  if (key === ghostKey) return;
  ghostKey = key;
  const [x, y] = geom.pts[k];
  const r = geom.scale * 0.016;
  const fs = geom.scale * 0.022;
  ghostLayer.innerHTML = `<g class="ghost" style="transform:translate(${x}px,${y}px)">
    <circle r="${r * 1.5}" stroke="${colorOf(target)}" stroke-width="${r * 0.4}" stroke-dasharray="${r * 0.6} ${r * 0.45}"/>
    <text x="${r * 2}" y="${-r * 1.2}" font-size="${fs}" stroke-width="${fs * 0.18}">${esc(tlaOf(target))} pit → P${w.pos}</text>
  </g>`;
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
const isRaceSession = () => sessionType() === 'Race';
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
  else if (tab === 'pits') renderPits();
  else if (tab === 'speeds') renderSpeeds();
  else if (tab === 'h2h') renderH2H();
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
    num, pos: isPracticeView() ? order.findIndex(([n]) => n === num) + 1 : l.Position, tla: tlaOf(num), color: colorOf(num), fav: num === fnum,
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

// Lap-based charts on screen, for hover: id -> { scale, tip(lap) -> html }
const chartReg = {};

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
  chartReg.trace = {
    scale,
    tip: (lap) => {
      const rows = series.map((x) => ({ s: x, g: x.points.find((pt) => pt[0] === lap)?.[1] })).filter((r) => r.g != null).sort((a, b) => a.g - b.g);
      return `<b>Lap ${lap}</b>${rows.length ? rows.slice(0, 12).map((r) => `<div class="tip-row"><span class="tip-sw${r.s.dashed ? ' dashed' : ''}" style="border-color:${esc(r.s.color)}"></span>${esc(r.s.tla)}<span>${r.g === 0 ? 'Leader' : `+${r.g.toFixed(1)}s`}</span></div>`).join('') : '<div class="muted">No data</div>'}`;
    },
  };
  const legend = `<div class="legend">${series.map((s) => `<button type="button" class="lg lg-btn${traceFocus === s.num ? ' on' : ''}" data-trace-focus="${esc(s.num)}"><span class="lg-line${s.dashed ? ' dashed' : ''}" style="border-color:${esc(s.color)}"></span>${esc(s.tla)}</button>`).join('')}</div>`;
  setBody(key, tools, `${legend}<div class="trace-wrap">${svg}</div><p class="hint chart-note">Gap to the leader at the end of each lap. Lapped cars drop off the chart. Shaded: safety car, VSC or red flag.</p>`);
}

function chartHover(ev) {
  const svg = ev.target.closest('svg[data-chart]');
  const reg = svg && chartReg[svg.dataset.chart];
  if (!reg) return hideTip();
  const rect = svg.getBoundingClientRect();
  const { padL, padR, W, lapMax, x } = reg.scale;
  const px = ((ev.clientX - rect.left) / rect.width) * W;
  const lap = Math.round(1 + ((px - padL) / (W - padL - padR)) * (lapMax - 1));
  if (lap < 1 || lap > lapMax) return hideTip();
  hideCross();
  const cross = svg.querySelector('.rt-cross');
  cross.setAttribute('x1', x(lap)); cross.setAttribute('x2', x(lap)); cross.setAttribute('visibility', 'visible');
  showTip(ev, reg.tip(lap));
}

// Points for the running order, if this session counts.
const RACE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];
function projection() {
  if (!standings || !isRaceSession()) return null;
  if (!['Started', 'Aborted', 'Finished', 'Finalised', 'Ends'].includes(sessionStatus())) return null;
  const sprint = /sprint/i.test(sessionName() || '');
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

// ---------- pit stops ----------
const tyreChip = (c) => (c ? `<span class="tyre"><span class="t ${esc(c)}"><span>${COMPOUND_LETTER[c] || '?'}</span></span></span>` : '');

function renderPits() {
  const pits = shownHist().filter((e) => e.k === 'pit');
  const app = state.TimingAppData?.Lines || {};
  const fnum = favNum();
  const key = `pits|${pits.length}|${fnum}|${JSON.stringify(Object.keys(app).map((n) => list(app[n]?.Stints).length))}`;
  if (!pits.length) {
    return setBody(key, '', `<div class="empty">${isRaceSession() ? 'No pit stops yet.' : 'Pit stops are logged during races and sprints.'}</div>`);
  }
  const count = {};
  const rows = pits.map((p) => {
    count[p.n] = (count[p.n] || 0) + 1;
    // The stint that ended nearest this lap, and the one after it.
    const ranges = stintRanges(app[p.n]?.Stints);
    let i = -1, best = Infinity;
    ranges.slice(0, -1).forEach((r, k) => { const d = Math.abs(r.to - p.lap); if (d < best) { best = d; i = k; } });
    return { ...p, stop: count[p.n], from: ranges[i]?.compound, to: ranges[i + 1]?.compound, fresh: ranges[i + 1]?.fresh };
  });
  const fastest = Math.min(...rows.map((r) => r.dur).filter((d) => d > 0));
  const html = `<div class="table-wrap"><table class="tbl">
    <thead><tr><th class="num-c">Lap</th><th>Driver</th><th class="num-c">Stop</th><th>Tyres</th><th class="num-c">Pit lane</th></tr></thead>
    <tbody>${rows.slice().reverse().map((r) => `<tr class="${r.n === fnum ? 'fav' : ''}">
      <td class="num-c b">${r.lap}</td>
      <td><span class="drv"><span class="bar" style="background:${colorOf(r.n)}"></span><span class="tla">${esc(tlaOf(r.n))}</span></span></td>
      <td class="num-c muted">${r.stop}</td>
      <td><span class="tyre-change">${tyreChip(r.from)}${r.to ? `<span class="arrow">→</span>${tyreChip(r.to)}${r.fresh === false ? '<span class="used">used</span>' : ''}` : ''}</span></td>
      <td class="num-c b${r.dur === fastest ? ' t-ob' : ''}">${r.dur ? `${r.dur.toFixed(1)} s` : ''}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="hint chart-note">Pit lane: time from pit entry to pit exit; the quickest is purple. Newest first.</p>`;
  setBody(key, '', html);
}

// ---------- speed traps ----------
const TRAPS = [['I1', 'I1'], ['I2', 'I2'], ['FL', 'Finish'], ['ST', 'Trap']];
let speedSort = store.get('speedSort', 'ST');

function renderSpeeds() {
  const best = {};
  for (const e of shownHist()) if (e.k === 'spd') { const b = (best[e.n] ||= {}); b[e.trap] = Math.max(b[e.trap] || 0, speedVal(e.v)); }
  const nums = Object.keys(best).filter((n) => DL()[n]);
  const fnum = favNum();
  const key = `spd|${JSON.stringify(best)}|${speedSort}|${fnum}|${units.speed}`;
  if (!nums.length) return setBody(key, '', '<div class="empty">Speed-trap readings appear once cars are running.</div>');
  const top = {};
  for (const [t] of TRAPS) top[t] = Math.max(0, ...nums.map((n) => best[n][t] || 0));
  nums.sort((a, b) => (best[b][speedSort] || 0) - (best[a][speedSort] || 0));
  const html = `<div class="table-wrap"><table class="tbl">
    <thead><tr><th class="num-c">#</th><th>Driver</th>${TRAPS.map(([t, l]) => `<th class="num-c"><button type="button" class="th-sort${speedSort === t ? ' on' : ''}" data-speed-sort="${t}">${l}${speedSort === t ? ' ▾' : ''}</button></th>`).join('')}</tr></thead>
    <tbody>${nums.map((n, i) => `<tr class="${n === fnum ? 'fav' : ''}">
      <td class="num-c muted">${i + 1}</td>
      <td><span class="drv"><span class="bar" style="background:${colorOf(n)}"></span><span class="tla">${esc(tlaOf(n))}</span></span></td>
      ${TRAPS.map(([t]) => { const v = best[n][t]; return `<td class="num-c${v && v === top[t] ? ' t-ob b' : ''}${t === speedSort ? ' b' : ''}">${v || ''}</td>`; }).join('')}
    </tr>`).join('')}</tbody></table></div>
    <p class="hint chart-note">Best speed this session in ${speedUnit()}. I1 and I2 are the intermediate timing points, Finish is the finish line and Trap is the speed trap. Fastest at each point in purple. Tap a column to sort.</p>`;
  setBody(key, '', html);
}

// ---------- head-to-head ----------
function h2hPair() {
  const order = runningOrder();
  const has = (tla) => tla && numOfTla(tla) && order.some(([n]) => n === numOfTla(tla));
  let a = has(h2h.a) ? numOfTla(h2h.a) : favNum() && has(fav) ? favNum() : order[0]?.[0];
  let b = has(h2h.b) ? numOfTla(h2h.b) : null;
  if (!b || b === a) {
    const i = order.findIndex(([n]) => n === a);
    b = (order[i - 1] || order[i + 1])?.[0] || null;
  }
  return [a, b];
}

function renderH2H() {
  const order = runningOrder();
  if (order.length < 2) return setBody('h2h|none', '', '<div class="empty">Head-to-head works once a session has data.</div>');
  const [a, b] = h2hPair();
  const q = qInfo();
  const race = isRaceSession();
  const laps = shownHist().filter((e) => e.k === 'lap' && (e.n === a || e.n === b));
  const secLaps = shownHist().filter((e) => e.k === 'sec' && (e.n === a || e.n === b));
  const width = $('insBody').clientWidth - 8;
  const lines = state.TimingData?.Lines || {};
  const la = lines[a] || {}, lb = lines[b] || {};
  const key = `h2h|${a}|${b}|${laps.length}|${secLaps.length}|${width}|${JSON.stringify([la.Position, lb.Position, la.GapToLeader, lb.GapToLeader, la.LastLapTime?.Value, lb.LastLapTime?.Value, q?.part])}`;
  if (key === insKey) return;
  const opts = (sel) => order.map(([n, l], i) => `<option value="${esc(tlaOf(n))}"${n === sel ? ' selected' : ''}>P${esc(isPracticeView() ? i + 1 : l.Position || '')} ${esc(tlaOf(n))}</option>`).join('');
  const tools = `<div class="h2h-pick"><select class="sel" data-h2h="a" aria-label="First driver">${opts(a)}</select><span class="muted">vs</span><select class="sel" data-h2h="b" aria-label="Second driver">${opts(b)}</select></div>`;

  const sameTeam = DL()[a]?.TeamName && DL()[a]?.TeamName === DL()[b]?.TeamName;
  const colA = colorOf(a), colB = colorOf(b);
  const byLap = (n) => {
    const m = {};
    for (const e of laps) if (e.n === n) m[e.lap] = e;
    return m;
  };
  const LA = byLap(a), LB = byLap(b);
  // Lap times per lap; a repeat of the previous lap's time means no new time was set (out/in laps).
  const times = (m) => Object.values(m).sort((x, y) => x.lap - y.lap)
    .filter((e, i, arr) => e.time && (i === 0 || e.time !== arr[i - 1].time))
    .map((e) => [e.lap, parseLap(e.time)]).filter(([, t]) => t != null);
  const ta = times(LA), tb = times(LB);
  // Representative laps: within 7% of the median, so pit, safety-car and odd timing laps
  // (one bad value can't distort the scale) are left out.
  // Push laps: within 7% of the fastest real lap. "Real" skips timing glitches far below
  // the typical lap. In practice most laps are out-laps and in-laps, so the fastest lap,
  // not the typical one, sets what counts as a push lap.
  const PUSH = 1.07;
  const fastest = (arr) => {
    if (!arr.length) return null;
    const sorted = arr.map(([, t]) => t).sort((x, y) => x - y);
    const floor = sorted[Math.floor(sorted.length / 2)] * 0.6;
    return sorted.find((t) => t >= floor) ?? null;
  };
  const pushLaps = (arr, ref = fastest(arr)) => (ref == null ? [] : arr.filter(([, t]) => t >= ref * 0.995 && t <= ref * PUSH));
  const avg5 = (arr) => { const c = pushLaps(arr).slice(-5); return c.length ? c.reduce((s2, [, t]) => s2 + t, 0) / c.length : null; };
  const fmt = (t) => (t == null ? '–' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`);
  const stint = (n) => list(state.TimingAppData?.Lines?.[n]?.Stints).pop();
  const tyre = (n) => { const st = stint(n); const c = (st?.Compound || '').toUpperCase(); return st ? `${tyreChip(c)} <span class="muted">${esc(st.TotalLaps ?? '')} laps</span>` : '–'; };

  // Gap between them now: positive = A ahead.
  let gapNow = null, gapLabel = '';
  if (race) {
    const ga = gapSec(la), gb = gapSec(lb);
    if (ga != null && gb != null) gapNow = gb - ga;
    gapLabel = 'Gap on track';
  } else {
    const pa = parseLap(q ? partBest(la, q.part) : la.BestLapTime?.Value), pb = parseLap(q ? partBest(lb, q.part) : lb.BestLapTime?.Value);
    if (pa != null && pb != null) gapNow = pb - pa;
    gapLabel = q ? `Best in ${q.label}` : 'Best lap';
  }
  const ahead = gapNow == null ? '' : gapNow >= 0 ? tlaOf(a) : tlaOf(b);
  const headline = gapNow == null
    ? `<span class="muted">${gapLabel}: no comparison yet</span>`
    : `<b>${esc(ahead)}</b> ${race ? 'ahead by' : 'faster by'} <b>${Math.abs(gapNow).toFixed(race ? 1 : 3)} s</b> <span class="muted">· ${esc(gapLabel)}</span>`;

  const rowsH = [
    ['Position', `P${esc(posOf(a) || '–')}`, `P${esc(posOf(b) || '–')}`],
    q ? [`Best in ${q.label}`, fmt(parseLap(partBest(la, q.part))), fmt(parseLap(partBest(lb, q.part)))]
      : ['Best lap', fmt(parseLap(la.BestLapTime?.Value || lastWith(la.BestLapTimes, 'Value'))), fmt(parseLap(lb.BestLapTime?.Value || lastWith(lb.BestLapTimes, 'Value')))],
    ['Last lap', esc(la.LastLapTime?.Value || '–'), esc(lb.LastLapTime?.Value || '–')],
    ['Avg last 5', fmt(avg5(ta)), fmt(avg5(tb))],
    ['Tyre', tyre(a), tyre(b)],
    ...(race ? [['Pit stops', esc(la.NumberOfPitStops ?? 0), esc(lb.NumberOfPitStops ?? 0)]] : []),
  ];
  const head = (n) => `<span class="drv"><span class="bar" style="background:${colorOf(n)}"></span><span class="tla">${esc(tlaOf(n))}</span><span class="team">${esc(DL()[n]?.TeamName || '')}</span></span>`;
  const statTable = `<table class="tbl h2h-tbl"><thead><tr><th></th><th>${head(a)}</th><th>${head(b)}</th></tr></thead>
    <tbody>${rowsH.map(([k, x, y]) => `<tr><td class="muted">${k}</td><td>${x}</td><td>${y}</td></tr>`).join('')}</tbody></table>`;

  // Lap times chart: push laps only, scaled from the fastest lap of the two.
  const all = [...ta, ...tb];
  let charts = '';
  const ref = fastest(all);
  const pa = pushLaps(ta, ref), pb = pushLaps(tb, ref);
  if (pa.length || pb.length) {
    const shown = [...pa, ...pb];
    const hidden = all.length - shown.length;
    const yMin = Math.min(...shown.map(([, t]) => t)) - 0.15;
    const yMax = Math.max(...shown.map(([, t]) => t)) + 0.15;
    const maxLap = Math.max(...all.map(([l]) => l), race ? Number(state.LapCount?.TotalLaps) || 0 : 0);
    const series = [
      { label: tlaOf(a), color: colA, dashed: false, points: pa, all: ta },
      { label: tlaOf(b), color: colB, dashed: sameTeam, points: pb, all: tb },
    ];
    const lt = lapChart(series, { id: 'h2hTimes', width, height: width < 520 ? 190 : 230, maxLap, yMin, yMax, yFmt: (v) => `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}`, label: 'Lap times' });
    chartReg.h2hTimes = { scale: lt.scale, tip: (lap) => `<b>Lap ${lap}</b>${series.map((x) => {
      const t = x.all.find((p) => p[0] === lap)?.[1];
      const slow = t != null && !x.points.some((p) => p[0] === lap);
      return `<div class="tip-row"><span class="tip-sw${x.dashed ? ' dashed' : ''}" style="border-color:${esc(x.color)}"></span>${esc(x.label)}<span>${fmt(t)}${slow ? ' (slow lap)' : ''}</span></div>`;
    }).join('')}` };
    const legend = `<div class="legend">${series.map((x) => `<span class="lg"><span class="lg-line${x.dashed ? ' dashed' : ''}" style="border-color:${esc(x.color)}"></span>${esc(x.label)}</span>`).join('')}</div>`;
    charts += `<h3 class="sub-h">Lap times</h3>${legend}<div class="trace-wrap">${lt.svg}</div><p class="hint chart-note">Lower is faster. Push laps only: within 7% of the fastest lap.${hidden ? ` ${hidden} slower lap${hidden === 1 ? '' : 's'} (out-laps, in-laps, pit stops, safety car) left out; hover a lap to see its time.` : ''}</p>`;

    if (race) {
      const gaps = Object.keys(LA).map(Number).filter((l) => LB[l] && LA[l].gap != null && LB[l].gap != null)
        .sort((x, y) => x - y).map((l) => [l, LB[l].gap - LA[l].gap]);
      if (gaps.length) {
        const vals = gaps.map(([, g]) => g);
        const m = Math.max(1, ...vals.map(Math.abs));
        const gc = lapChart([{ label: 'Gap', color: 'var(--text)', points: gaps }], { id: 'h2hGap', width, height: width < 520 ? 160 : 190, maxLap, yMin: Math.min(0, ...vals) - 0.3, yMax: Math.max(0, ...vals) + 0.3, yFmt: (v) => (Math.abs(v) < 1e-9 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(m < 5 ? 1 : 0)}`), zero: true, label: 'Gap between the two drivers' });
        chartReg.h2hGap = { scale: gc.scale, tip: (lap) => { const g = gaps.find((p) => p[0] === lap)?.[1]; return `<b>Lap ${lap}</b><div>${g == null ? '<span class="muted">No data</span>' : `${esc(g >= 0 ? tlaOf(a) : tlaOf(b))} ahead by ${Math.abs(g).toFixed(1)} s`}</div>`; } };
        charts += `<h3 class="sub-h">Gap between them <span class="muted">· above 0: ${esc(tlaOf(a))} ahead, below: ${esc(tlaOf(b))} ahead</span></h3><div class="trace-wrap">${gc.svg}</div>`;
      }
    }
  } else {
    charts = '<p class="hint chart-note">Charts fill in lap by lap while the page is open on the server.</p>';
  }
  setBody(key, tools, `<div class="h2h-head">${headline}</div>${statTable}${sectorCompare(a, b, secLaps, q, race)}${charts}`);
}

// Sector by sector: each driver's last lap in races, their fastest lap otherwise
// (in qualifying, their fastest in the part that's running).
function sectorsOf(n, secLaps, q, race) {
  const mine = secLaps.filter((e) => e.n === n);
  const l = state.TimingData?.Lines?.[n] || {};
  if (race) {
    const e = mine[mine.length - 1];
    return e ? { s: e.s3, lap: e.lap } : null;
  }
  // In qualifying: fastest in this part; until they've set one, fastest so far.
  const inPart = q ? parseLap(partBest(l, q.part)) : null;
  const target = inPart ?? bestOf(l);
  const earlier = Boolean(q) && inPart == null;
  if (target != null) {
    // Sector times add up to the lap time (to within rounding).
    const e = mine.slice().reverse().find((x) => Math.abs(x.s3[0] + x.s3[1] + x.s3[2] - target) < 0.06);
    if (e) return { s: e.s3, lap: e.lap, earlier };
  }
  // Not seen that lap (page opened later): personal best sectors, which can be from different laps.
  const bs = list(state.TimingStats?.Lines?.[n]?.BestSectors).map((x) => Number(x?.Value));
  return bs.length === 3 && bs.every((v) => v > 0) ? { s: bs, mixed: true, earlier } : null;
}

function sectorCompare(a, b, secLaps, q, race) {
  const A = sectorsOf(a, secLaps, q, race), B = sectorsOf(b, secLaps, q, race);
  const what = race ? 'last lap' : q && !A?.earlier && !B?.earlier ? `fastest lap in ${q.label}` : q ? 'fastest lap so far' : 'fastest lap';
  if (!A || !B) {
    return `<h3 class="sub-h">Sectors · ${what}</h3><p class="hint chart-note">Appears once both drivers have completed a ${race ? 'lap' : 'timed lap'} while the page is open on the server.</p>`;
  }
  const rows = [0, 1, 2].map((i) => ({ label: `S${i + 1}`, a: A.s[i], b: B.s[i] }));
  rows.push({ label: 'Lap', a: A.s[0] + A.s[1] + A.s[2], b: B.s[0] + B.s[1] + B.s[2], total: true });
  const scale = Math.max(0.05, ...rows.map((r) => Math.abs(r.b - r.a)));
  const ca = colorOf(a), cb = colorOf(b);
  const fmtS = (v, total) => (total ? `${Math.floor(v / 60)}:${(v % 60).toFixed(3).padStart(6, '0')}` : v.toFixed(3));
  const body = rows.map((r) => {
    const d = r.b - r.a; // positive: A faster
    const w = Math.min(48, (Math.abs(d) / scale) * 48);
    const fasterA = d > 0.0005, fasterB = d < -0.0005;
    const bar = fasterA
      ? `<span class="sc-bar" style="right:50%;width:${w.toFixed(1)}%;background:${esc(ca)}"></span><span class="sc-d" style="left:calc(50% + 6px)">−${Math.abs(d).toFixed(3)}</span>`
      : fasterB
        ? `<span class="sc-bar" style="left:50%;width:${w.toFixed(1)}%;background:${esc(cb)}"></span><span class="sc-d" style="right:calc(50% + 6px)">−${Math.abs(d).toFixed(3)}</span>`
        : '<span class="sc-d" style="left:50%;transform:translateX(-50%)">equal</span>';
    return `<div class="sc-row${r.total ? ' total' : ''}">
      <span class="sc-k">${r.label}</span>
      <span class="sc-t r${fasterA ? ' win' : ''}">${fmtS(r.a, r.total)}</span>
      <span class="sc-mid">${bar}</span>
      <span class="sc-t${fasterB ? ' win' : ''}">${fmtS(r.b, r.total)}</span>
    </div>`;
  }).join('');
  const lapNote = (x, n) => (x.mixed ? `${esc(tlaOf(n))}: best sectors (from different laps)` : x.lap ? `${esc(tlaOf(n))}: lap ${x.lap}` : '');
  return `<h3 class="sub-h">Sectors · ${what}</h3>
    <div class="sec-cmp">
      <div class="sc-row sc-head"><span></span><span class="r">${esc(tlaOf(a))}</span><span class="sc-mid-h"><span>◂ ${esc(tlaOf(a))} faster</span><span>${esc(tlaOf(b))} faster ▸</span></span><span>${esc(tlaOf(b))}</span></div>
      ${body}
    </div>
    <p class="hint chart-note">Bars show who was quicker in each sector and by how much. ${[lapNote(A, a), lapNote(B, b)].filter(Boolean).join(' · ')}</p>`;
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
function hideCross() {
  for (const c of document.querySelectorAll('.rt-cross')) c.setAttribute('visibility', 'hidden');
}
function hideTip() {
  tip.hidden = true;
  hideCross();
}
$('insBody').addEventListener('pointermove', (ev) => {
  const st = ev.target.closest('[data-tip]');
  if (st) return showTip(ev, esc(st.dataset.tip));
  if (ev.target.closest('svg[data-chart]')) return chartHover(ev);
  hideTip();
});
$('insBody').addEventListener('pointerleave', hideTip);
$('insBody').addEventListener('pointerdown', (ev) => { if (ev.pointerType !== 'mouse' && ev.target.closest('svg[data-chart]')) chartHover(ev); });

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
  $('pitLoss').value = pitLossManual || 9.5;
  renderUnits();
  renderWakeState();
  showPitLoss();
  renderSettings();
  $('settings').showModal();
}
function renderUnits() {
  for (const b of document.querySelectorAll('[data-unit]')) {
    const [k, v] = b.dataset.unit.split(':');
    b.classList.toggle('on', units[k] === v);
    b.setAttribute('aria-pressed', String(units[k] === v));
  }
}
function showPitLoss() {
  const p = pitLoss();
  $('pitLossVal').textContent = pitLossManual ? `${p.secs} s` : `Auto · ${p.secs} s`;
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
$('settings').addEventListener('click', (e) => {
  const wb = e.target.closest('[data-wake]');
  if (wb) {
    wakeMode = wb.dataset.wake;
    store.set('wake', wakeMode);
    updateWake(); // inside the tap, which some browsers require
    return;
  }
  const b = e.target.closest('[data-unit]');
  if (!b) return;
  const [k, v] = b.dataset.unit.split(':');
  units = { ...units, [k]: v };
  store.set('units', units);
  renderUnits();
  insKey = '';
  dirty = true;
});
$('pitLoss').addEventListener('input', (e) => {
  pitLossManual = Number(e.target.value) < 10 ? 0 : Number(e.target.value); // below 10 s means automatic
  store.set('pitLoss', pitLossManual);
  showPitLoss();
  ghostKey = '';
  dirty = true;
});
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
  if (e.target.closest('[data-ko]')) {
    showKO = !showKO;
    store.set('showKO', showKO);
    dirty = true;
    return;
  }
  const vis = e.target.closest('[data-vis]');
  if (vis) {
    const k = vis.dataset.vis;
    if (mapHidden.has(k)) mapHidden.delete(k); else mapHidden.add(k);
    store.set('mapHidden', [...mapHidden]);
    ghostKey = '';
    dirty = true;
    return;
  }
  const tr = e.target.closest('tr[data-num]');
  if (!tr || !isLive()) return;
  teleTla = tlaOf(tr.dataset.num);
  store.set('teleTla', teleTla);
  dirty = true;
});
$('mapShowAll').addEventListener('click', () => {
  mapHidden.clear();
  store.set('mapHidden', []);
  ghostKey = '';
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
  const t = e.target.closest('[data-trace-filter],[data-trace-focus],[data-stand],[data-res-kind],[data-speed-sort]');
  if (!t) return;
  if (t.dataset.speedSort) { speedSort = t.dataset.speedSort; store.set('speedSort', speedSort); }
  if (t.dataset.traceFilter != null) { traceFilter = Number(t.dataset.traceFilter); store.set('traceFilter', traceFilter); }
  if (t.dataset.traceFocus != null) traceFocus = traceFocus === t.dataset.traceFocus ? null : t.dataset.traceFocus;
  if (t.dataset.stand) { standTab = t.dataset.stand; store.set('standTab', standTab); }
  if (t.dataset.resKind) { resSel = { ...resSel, kind: t.dataset.resKind }; store.set('resSel', resSel); }
  insKey = '';
  dirty = true;
});
$('insCard').addEventListener('change', (e) => {
  if (e.target.dataset.h2h) {
    h2h = { ...h2h, [e.target.dataset.h2h]: e.target.value };
    if (e.target.dataset.h2h === 'a' && h2h.b === h2h.a) h2h.b = '';
    store.set('h2h', h2h);
    insKey = ''; dirty = true;
    return;
  }
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

// ---------- keep the screen awake ----------
// Screen Wake Lock API: works over HTTPS in current Safari (iOS 16.4+) and Chrome. The browser
// drops the lock when the page is hidden, so it's taken again when the page comes back.
let wakeLock = null, wakeBusy = false, wakeErr = '';
const wakeSupported = () => 'wakeLock' in navigator;
async function updateWake() {
  if (!wakeSupported() || wakeBusy) return;
  const want = document.visibilityState === 'visible' && (wakeMode === 'always' || (wakeMode === 'live' && isLive()));
  wakeBusy = true;
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeErr = '';
      wakeLock.addEventListener('release', () => { wakeLock = null; renderWakeState(); });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {
    wakeErr = e.message || 'refused';
  } finally {
    wakeBusy = false;
    renderWakeState();
  }
}
function renderWakeState() {
  for (const b of document.querySelectorAll('[data-wake]')) b.classList.toggle('on', b.dataset.wake === wakeMode);
  const el = $('wakeState');
  if (!el) return;
  if (!wakeSupported()) { el.textContent = window.isSecureContext ? 'Not supported by this browser' : 'Needs the https:// address'; el.className = 'warn'; }
  else if (wakeErr) { el.textContent = `Not allowed (${wakeErr})`; el.className = 'warn'; }
  else if (wakeLock) { el.textContent = 'On now'; el.className = 'ok'; }
  else { el.textContent = wakeMode === 'off' ? 'Off' : wakeMode === 'live' ? 'Waiting for a session' : 'Off'; el.className = ''; }
}
document.addEventListener('visibilitychange', updateWake);
document.addEventListener('pointerdown', () => { if (!wakeLock) updateWake(); }, { passive: true }); // some browsers need a tap first
setInterval(updateWake, 5000); // follows sessions starting and ending

// ---------- your own layout ----------
// Cards can be moved up and down, between the two columns (on wide screens) and hidden.
// Wide and narrow screens keep separate layouts, saved in this browser.
const CARDS = {
  towerCard: 'Timing', insCard: 'Insights', mapCard: 'Track map', teleCard: 'Telemetry',
  rcCard: 'Race control', radioCard: 'Team radio', weekendCard: 'Next race weekend',
};
const DEFAULT_WIDE = { main: ['towerCard', 'insCard'], side: ['mapCard', 'teleCard', 'rcCard', 'radioCard', 'weekendCard'], hidden: [] };
const DEFAULT_NARROW = { main: ['towerCard', 'mapCard', 'teleCard', 'rcCard', 'radioCard', 'insCard', 'weekendCard'], side: [], hidden: [] };
const narrowMQ = window.matchMedia('(max-width: 980px)');
let editing = false;
const layoutKey = () => (narrowMQ.matches ? 'layoutNarrow' : 'layoutWide');

function getLayout() {
  const narrow = narrowMQ.matches;
  const def = narrow ? DEFAULT_NARROW : DEFAULT_WIDE;
  const saved = store.get(layoutKey(), null);
  if (!saved) return clone(def);
  const ids = Object.keys(CARDS);
  const seen = new Set();
  const keep = (arr) => (arr || []).filter((id) => ids.includes(id) && !seen.has(id) && seen.add(id));
  const L = { main: keep(saved.main), side: narrow ? [] : keep(saved.side), hidden: (saved.hidden || []).filter((id) => ids.includes(id)) };
  if (narrow) L.main.push(...keep(saved.side));
  // Cards added in a later version go where the default puts them.
  for (const id of ids) {
    if (seen.has(id)) continue;
    const col = def.main.includes(id) ? 'main' : 'side';
    L[col].push(id);
  }
  return L;
}

function applyLayout() {
  const L = getLayout();
  const cols = { main: document.querySelector('.col-main'), side: document.querySelector('.col-side') };
  for (const col of ['main', 'side']) {
    L[col].forEach((id, i) => {
      const el = $(id);
      if (el.parentElement !== cols[col]) cols[col].append(el);
      el.style.order = String(i);
      const hidden = L.hidden.includes(id);
      el.classList.toggle('user-hidden', hidden && !editing);
      el.classList.toggle('edit-hidden', hidden && editing);
    });
  }
  if (editing) renderLayoutControls(L);
  insKey = ''; // chart widths may have changed
  dirty = true;
}

function saveLayout(L) {
  store.set(layoutKey(), L);
  applyLayout();
}

function renderLayoutControls(L) {
  const narrow = narrowMQ.matches;
  for (const id of Object.keys(CARDS)) {
    const el = $(id);
    let ctl = el.querySelector(':scope > .lay-ctl');
    if (!ctl) {
      ctl = document.createElement('div');
      ctl.className = 'lay-ctl';
      el.prepend(ctl);
    }
    const col = L.main.includes(id) ? 'main' : 'side';
    const i = L[col].indexOf(id);
    const hidden = L.hidden.includes(id);
    const b = (act, label, text, disabled) => `<button type="button" class="lay-btn" data-lay="${act}" data-card="${id}" aria-label="${esc(label)}" title="${esc(label)}"${disabled ? ' disabled' : ''}>${text}</button>`;
    ctl.innerHTML = `<span class="lay-name">${esc(CARDS[id])}${hidden ? ' <span class="lay-tag">Hidden</span>' : ''}${id === 'teleCard' ? ' <span class="muted">· live only</span>' : ''}</span>
      <span class="lay-btns">
        ${b('up', `Move ${CARDS[id]} up`, '↑', i === 0)}
        ${b('down', `Move ${CARDS[id]} down`, '↓', i === L[col].length - 1)}
        ${narrow ? '' : b('swap', `Move ${CARDS[id]} to the ${col === 'main' ? 'right' : 'left'} column`, col === 'main' ? '→' : '←')}
        ${b('hide', hidden ? `Show ${CARDS[id]}` : `Hide ${CARDS[id]}`, hidden ? 'Show' : 'Hide')}
      </span>`;
  }
}

function layoutAction(act, id) {
  const L = getLayout();
  const col = L.main.includes(id) ? 'main' : 'side';
  const arr = L[col];
  const i = arr.indexOf(id);
  if (act === 'up' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
  else if (act === 'down' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
  else if (act === 'swap') { arr.splice(i, 1); L[col === 'main' ? 'side' : 'main'].push(id); }
  else if (act === 'hide') L.hidden = L.hidden.includes(id) ? L.hidden.filter((x) => x !== id) : [...L.hidden, id];
  saveLayout(L);
  // Keep the moved card in view.
  $(id).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  $('layoutBar').hidden = !on;
  $('layoutBtn').classList.toggle('on', on);
  $('layoutHint').textContent = narrowMQ.matches ? '· this screen size' : '· wide screens';
  if (!on) for (const c of document.querySelectorAll('.lay-ctl')) c.remove();
  applyLayout();
}

$('layoutBtn').addEventListener('click', () => setEditing(!editing));
$('layoutDone').addEventListener('click', () => setEditing(false));
$('layoutReset').addEventListener('click', () => { store.set(layoutKey(), null); applyLayout(); });
document.querySelector('main.grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lay]');
  if (b) { e.stopPropagation(); layoutAction(b.dataset.lay, b.dataset.card); }
}, true);
narrowMQ.addEventListener('change', () => { if (editing) for (const c of document.querySelectorAll('.lay-ctl')) c.remove(); applyLayout(); });
applyLayout();

// ---------- loop ----------
// Each part renders on its own: an error in one card is reported and the rest keep updating.
const PARTS = [
  ['header', renderHeader], ['header', renderNext], ['next race weekend', renderWeekend], ['timing', renderTower],
  ['track map', renderMap], ['telemetry', renderTele], ['race control', renderRC], ['team radio', renderRadio],
  ['insights', renderInsights], ['settings', () => { if ($('settings').open) renderSettings(); }],
];
const failing = new Map(); // part -> message
function render() {
  for (const [name, fn] of PARTS) {
    try {
      fn();
      if (failing.delete(name)) showErrors();
    } catch (e) {
      if (failing.get(name) !== e.message) {
        console.error(`f1live: ${name} failed`, e);
        failing.set(name, e.message);
        showErrors();
      }
    }
  }
}
function showErrors() {
  let el = document.getElementById('errBox');
  if (!failing.size) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'errBox'; el.className = 'err-box'; document.body.append(el); }
  el.textContent = `Display problem in ${[...failing].map(([n, m]) => `${n} (${m})`).join(', ')}. The rest of the page keeps updating.`;
}

setInterval(drain, 200);
setInterval(() => { dirty = true; }, 1000); // clocks and countdowns
setInterval(loadSchedule, 10 * 60000);
setInterval(() => loadStandings(), 60000);
(function frame() {
  requestAnimationFrame(frame); // scheduled first, so the loop can never stop
  if (dirty) { dirty = false; render(); }
})();

loadSchedule();
connect();
