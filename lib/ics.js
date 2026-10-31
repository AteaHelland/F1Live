// iCalendar feed of every session in the season, for subscribing from Calendar apps.
import { sessionEnd } from './schedule.js';

const MAIN = new Set(['Race', 'Qualifying', 'Sprint', 'SprintQualifying', 'SprintShootout']);

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets are folded with CRLF + space (RFC 5545 §3.1).
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// opts: { main: only race/qualifying/sprint sessions, alarm: minutes before (0 = none), url }
export function buildIcs(races, { main = false, alarm = 0, url = '', now = Date.now() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//f1live//F1 sessions//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${main ? 'F1 (race, quali, sprint)' : 'F1 sessions'}`,
    'X-WR-CALDESC:Formula 1 session times from f1live', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
  ];
  for (const r of races) {
    for (const s of r.sessions || []) {
      if (!s.start || (main && !MAIN.has(s.key))) continue;
      const start = new Date(s.start).getTime();
      lines.push(
        'BEGIN:VEVENT',
        `UID:f1live-${r.season}-${r.round}-${s.key}@f1live`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(start)}`,
        `DTEND:${stamp(sessionEnd(s))}`,
        `SUMMARY:${text(`F1 ${s.name} · ${r.name}`)}`,
        `LOCATION:${text([r.circuit, r.locality, r.country].filter(Boolean).join(', '))}`,
        `DESCRIPTION:${text(`Round ${r.round} of the ${r.season} season.${url ? ` Live timing: ${url}` : ''}`)}`,
        ...(url ? [`URL:${text(url)}`] : []),
        `CATEGORIES:${s.key === 'Race' ? 'Race' : 'F1'}`,
        'TRANSP:TRANSPARENT',
      );
      if (alarm > 0) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(`${s.name} starts in ${alarm} minutes`)}`,
          `TRIGGER:-PT${alarm}M`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
