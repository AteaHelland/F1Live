// Small SVG/HTML chart builders for the dashboard. They return markup plus the scale
// information the page needs for hover; colours of text stay in text tokens (CSS).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function niceMax(v, steps = 4) {
  if (!(v > 0)) return { max: 1, step: 1 };
  const raw = v / steps;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { max: Math.ceil(v / step) * step, step };
}

// ---------- tyre strategy (HTML, scales with its container) ----------
export const COMPOUND_LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

// rows: [{ num, pos, tla, color, out, fav, ranges: [{ compound, fresh, from, to }] }]
export function strategyChart(rows, { totalLaps, currentLap }) {
  const maxLap = Math.max(totalLaps || 0, currentLap || 0, ...rows.flatMap((r) => r.ranges.map((x) => x.to)), 1);
  const pct = (lap) => `${((lap / maxLap) * 100).toFixed(3)}%`;
  const step = maxLap > 50 ? 10 : 5;
  const ticks = [];
  for (let l = 0; l <= maxLap; l += step) ticks.push(l);
  const axis = `<div class="st-axis"><span class="st-lbl"></span><div class="st-track">${ticks.map((l) => `<span class="st-tick" style="left:${pct(l)}">${l}</span>`).join('')}</div></div>`;
  const now = currentLap ? `<span class="st-now" style="left:${pct(currentLap)}"></span>` : '';
  const body = rows.map((r) => {
    const last = r.ranges.length - 1;
    return `<div class="st-row${r.out ? ' out' : ''}${r.fav ? ' fav' : ''}">
      <span class="st-lbl"><span class="st-pos">${esc(r.pos || '')}</span><span class="bar" style="background:${esc(r.color)}"></span><b>${esc(r.tla)}</b></span>
      <div class="st-track">${now}${r.ranges.map((x, i) => {
        const laps = x.to - x.from;
        const letter = COMPOUND_LETTER[x.compound] || '?';
        const live = i === last && !r.out;
        const tip = `${r.tla} · stint ${i + 1}: ${x.compound.toLowerCase()}${x.fresh ? '' : ' (used set)'} · laps ${x.from + 1}–${x.to}${live ? ' so far' : ''} (${laps} lap${laps === 1 ? '' : 's'})`;
        return `<span class="st-stint c-${esc(x.compound)}${x.fresh ? '' : ' used'}${live ? ' live' : ''}" style="left:${pct(x.from)};width:calc(${pct(laps)} - 2px)" data-tip="${esc(tip)}"><span>${laps >= Math.max(4, maxLap / 9) ? `${letter} ${laps}` : laps >= Math.max(2, maxLap / 16) ? letter : ''}</span></span>`;
      }).join('')}</div>
    </div>`;
  }).join('');
  const legend = `<div class="legend">${['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) =>
    `<span class="lg"><span class="lg-sw c-${c}"></span>${c[0]}${c.slice(1).toLowerCase()}</span>`).join('')}<span class="lg"><span class="lg-sw used-sw"></span>Used set</span></div>`;
  return `${legend}<div class="strategy">${axis}${body}</div>`;
}

// ---------- race trace (SVG sized to the container width) ----------
// series: [{ num, tla, color, dashed, emphasis, points: [[lap, gapSeconds|null], ...] }]
// bands: [{ from, to, label }]
export function raceTrace(series, { width, height, maxLap, bands = [], endLabels = true }) {
  const pad = { l: 50, r: endLabels ? 44 : 12, t: 16, b: 24 };
  const W = Math.max(260, Math.round(width));
  const H = height;
  let gmax = 0;
  for (const s of series) for (const [, g] of s.points) if (g != null && g > gmax) gmax = g;
  const { max, step } = niceMax(Math.max(gmax, 2));
  const lapMax = Math.max(maxLap, 2);
  const x = (lap) => pad.l + ((lap - 1) / (lapMax - 1)) * (W - pad.l - pad.r);
  const y = (g) => pad.t + (g / max) * (H - pad.t - pad.b);
  const parts = [];

  let lastLbl = -Infinity;
  for (const b of bands) {
    const x0 = x(Math.max(1, b.from)), x1 = x(Math.min(lapMax, Math.max(b.to, b.from + 0.6)));
    parts.push(`<rect class="rt-band b-${esc(b.kind)}" x="${x0.toFixed(1)}" y="${pad.t}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${H - pad.t - pad.b}"/>`);
    const lx = (x0 + x1) / 2;
    if (lx - lastLbl < 28) continue; // labels would overlap; the shading still shows
    lastLbl = lx;
    parts.push(`<text class="rt-band-lbl" x="${lx.toFixed(1)}" y="${pad.t - 4}">${esc(b.label)}</text>`);
  }
  for (let g = 0; g <= max + 1e-9; g += step) {
    const yy = y(g).toFixed(1);
    parts.push(`<line class="rt-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="rt-ylbl" x="${pad.l - 6}" y="${yy}">${g === 0 ? 'Leader' : `+${+g.toFixed(1)}s`}</text>`);
  }
  const lstep = lapMax > 60 ? 10 : lapMax > 25 ? 5 : lapMax > 10 ? 2 : 1;
  for (let l = 1; l <= lapMax; l += 1) {
    if (l !== 1 && l % lstep !== 0) continue;
    parts.push(`<text class="rt-xlbl" x="${x(l).toFixed(1)}" y="${H - 6}">${l}</text>`);
  }

  const ordered = [...series].sort((a, b) => (a.emphasis || 0) - (b.emphasis || 0));
  const ends = [];
  for (const s of ordered) {
    let d = '';
    let pen = false;
    let lastPt = null;
    for (const [lap, g] of s.points) {
      if (g == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(lap).toFixed(1)},${y(g).toFixed(1)}`;
      pen = true;
      lastPt = [lap, g];
    }
    if (!d) continue;
    const cls = `rt-line${s.dashed ? ' dashed' : ''}${s.emphasis > 0 ? ' em' : ''}${s.emphasis < 0 ? ' dim' : ''}`;
    parts.push(`<path class="rt-halo${s.emphasis < 0 ? ' dim' : ''}" d="${d}"/><path class="${cls}" d="${d}" style="stroke:${esc(s.color)}"/>`);
    if (lastPt && s.points.length === 1) parts.push(`<circle class="rt-dot" cx="${x(lastPt[0])}" cy="${y(lastPt[1])}" r="3" style="fill:${esc(s.color)}"/>`);
    if (lastPt && s.emphasis >= 0) ends.push({ x: x(lastPt[0]), y: y(lastPt[1]), s });
  }
  if (endLabels) {
    ends.sort((a, b) => a.y - b.y);
    const gap = 12;
    for (let i = 1; i < ends.length; i++) if (ends[i].y < ends[i - 1].y + gap) ends[i].y = ends[i - 1].y + gap;
    const bottom = H - pad.b;
    for (let i = ends.length - 1; i >= 0; i--) {
      const lim = i === ends.length - 1 ? bottom : ends[i + 1].y - gap;
      if (ends[i].y > lim) ends[i].y = lim;
    }
    for (const e of ends) {
      parts.push(`<text class="rt-end${e.s.emphasis > 0 ? ' em' : ''}" x="${W - pad.r + 6}" y="${e.y.toFixed(1)}"><tspan style="fill:${esc(e.s.color)}">▪</tspan> ${esc(e.s.tla)}</text>`);
    }
  }
  parts.push(`<line class="rt-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`);
  const svg = `<svg class="trace" data-chart="trace" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Race trace: each driver's gap to the leader by lap">${parts.join('')}</svg>`;
  return { svg, scale: { padL: pad.l, padR: pad.r, W, lapMax, x } };
}

// ---------- tiny line for weather trends ----------
export function sparkline(values, w = 64, h = 18) {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((n - lo) / span) * (h - 4)).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ---------- telemetry trace: speed line + throttle and brake strips, last `span` seconds ----------
// samples: [{ t (ms), v, thr, brk }]
// Speeds in `samples` are already in the unit to show; `max` and `ticks` follow that unit.
export function teleTrace(samples, { width, span = 30, max = 360, ticks = [100, 200, 300] }) {
  const W = Math.max(240, Math.round(width));
  const H = 118, padL = 34, padR = 8, top = 6, lineH = 70, stripH = 9;
  if (!samples.length) return '';
  const tEnd = samples[samples.length - 1].t;
  const x = (t) => padL + (1 - (tEnd - t) / (span * 1000)) * (W - padL - padR);
  const y = (v) => top + lineH - (Math.min(max, v) / max) * lineH;
  const vis = samples.filter((s) => tEnd - s.t <= span * 1000);
  const parts = [];
  for (const v of ticks) {
    parts.push(`<line class="rt-grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="rt-ylbl" x="${padL - 5}" y="${y(v)}">${v}</text>`);
  }
  parts.push(`<path class="tt-speed" d="${vis.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join('')}"/>`);
  const strip = (row, key, cls, label) => {
    const yy = top + lineH + 8 + row * (stripH + 5);
    parts.push(`<text class="rt-ylbl" x="${padL - 5}" y="${yy + stripH / 2}">${label}</text>`);
    parts.push(`<rect class="tt-strip-bg" x="${padL}" y="${yy}" width="${W - padL - padR}" height="${stripH}" rx="2"/>`);
    for (let i = 0; i < vis.length; i++) {
      const s = vis[i];
      const val = key === 'brk' ? (s.brk > 0 ? 100 : 0) : s.thr;
      if (!val) continue;
      const x0 = x(s.t), x1 = i + 1 < vis.length ? x(vis[i + 1].t) : W - padR;
      parts.push(`<rect class="${cls}" x="${x0.toFixed(1)}" y="${yy}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${stripH}" opacity="${(0.25 + 0.75 * val / 100).toFixed(2)}"/>`);
    }
  };
  strip(0, 'thr', 'tt-thr', 'Thr');
  strip(1, 'brk', 'tt-brk', 'Brk');
  return `<svg class="tele-trace" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Speed, throttle and brake over the last ${span} seconds">${parts.join('')}</svg>`;
}

// ---------- generic lap chart: one value per lap per series (lap times, gaps) ----------
// series: [{ label, color, dashed, points: [[lap, value], ...] }]
// Values outside yMin..yMax are drawn as open markers on the edge, so outliers (pit laps,
// safety car laps, timing glitches) don't squash the rest of the chart.
export function lapChart(series, { id, width, height, maxLap, yMin, yMax, yFmt = (v) => v.toFixed(1), zero = false, label = '' }) {
  const pad = { l: 58, r: 12, t: 10, b: 24 };
  const W = Math.max(260, Math.round(width));
  const H = height;
  const lapMax = Math.max(maxLap, 2);
  const span = yMax - yMin || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const lo = Math.floor(yMin / step) * step, hi = Math.ceil(yMax / step) * step;
  const x = (lap) => pad.l + ((lap - 1) / (lapMax - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (Math.max(lo, Math.min(v, hi)) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const parts = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const yy = y(v).toFixed(1);
    parts.push(`<line class="rt-grid${zero && Math.abs(v) < 1e-9 ? ' zero' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="rt-ylbl" x="${pad.l - 6}" y="${yy}">${esc(yFmt(v))}</text>`);
  }
  const lstep = lapMax > 60 ? 10 : lapMax > 25 ? 5 : lapMax > 10 ? 2 : 1;
  for (let l = 1; l <= lapMax; l++) if (l === 1 || l % lstep === 0) parts.push(`<text class="rt-xlbl" x="${x(l).toFixed(1)}" y="${H - 6}">${l}</text>`);
  for (const s of series) {
    let d = '', pen = false;
    const marks = [];
    for (const [lap, v] of s.points) {
      if (v == null || !Number.isFinite(v)) { pen = false; continue; }
      if (v > hi || v < lo) { // out of range: open marker on the edge, line broken
        marks.push(`<circle class="lc-clip" cx="${x(lap).toFixed(1)}" cy="${y(v > hi ? hi : lo).toFixed(1)}" r="3" style="stroke:${esc(s.color)}"/>`);
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(lap).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
      marks.push(`<circle class="lc-dot" cx="${x(lap).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" style="fill:${esc(s.color)}"/>`);
    }
    if (d) parts.push(`<path class="rt-halo" d="${d}"/><path class="rt-line${s.dashed ? ' dashed' : ''}" d="${d}" style="stroke:${esc(s.color)}"/>`);
    parts.push(marks.join(''));
  }
  parts.push(`<line class="rt-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`);
  const svg = `<svg class="trace lapchart" data-chart="${esc(id)}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${parts.join('')}</svg>`;
  return { svg, scale: { padL: pad.l, padR: pad.r, W, lapMax, x } };
}
