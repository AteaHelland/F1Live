// Teammates compared over a season, from the qualifying and race results of every round:
// who qualified and finished ahead how often, and the typical gap in qualifying.
const secs = (v) => {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(v || '').trim());
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// rounds: [{ qualifying: rows, race: rows }] with rows as Jolpica.results() gives them.
export function teammates(rounds) {
  const pairs = new Map(); // "team|A|B" → tallies, codes in alphabetical order
  const pairFor = (team, x, y) => {
    const [a, b] = x.code < y.code ? [x, y] : [y, x];
    const k = `${team}|${a.code}|${b.code}`;
    if (!pairs.has(k)) {
      pairs.set(k, { team, a: { code: a.code, name: a.name }, b: { code: b.code, name: b.name },
        quali: { a: 0, b: 0 }, race: { a: 0, b: 0 }, dnf: { a: 0, b: 0 }, gaps: [], rounds: 0 });
    }
    return [pairs.get(k), a, b];
  };
  const byTeam = (rows) => {
    const t = {};
    for (const r of rows || []) if (r.code && r.team) (t[r.team] ||= []).push(r);
    return Object.entries(t).filter(([, d]) => d.length === 2);
  };
  for (const rd of rounds) {
    const seen = new Set();
    for (const [team, [x, y]] of byTeam(rd.qualifying)) {
      const [p, a, b] = pairFor(team, x, y);
      seen.add(p);
      if (a.pos && b.pos) p.quali[a.pos < b.pos ? 'a' : 'b']++;
      // The gap in the last part both took part in.
      for (const q of ['q3', 'q2', 'q1']) {
        const ta = secs(a[q]), tb = secs(b[q]);
        if (ta != null && tb != null) { p.gaps.push(tb - ta); break; }
      }
    }
    for (const [team, [x, y]] of byTeam(rd.race)) {
      const [p, a, b] = pairFor(team, x, y);
      seen.add(p);
      const fa = /^\d+$/.test(a.posText), fb = /^\d+$/.test(b.posText);
      if (!fa) p.dnf.a++;
      if (!fb) p.dnf.b++;
      if (fa && fb) p.race[a.pos < b.pos ? 'a' : 'b']++; // only when both were classified
    }
    for (const p of seen) p.rounds++;
  }
  return [...pairs.values()].map(({ gaps, ...p }) => {
    const m = median(gaps);
    // gap > 0: driver a is the quicker one, by that many seconds (median over the season).
    return { ...p, gap: m == null ? null : Math.round(m * 1000) / 1000, gapRounds: gaps.length };
  }).sort((x, y) => y.rounds - x.rounds || x.team.localeCompare(y.team));
}
