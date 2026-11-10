// Championship maths: who can still win the title, and what the leader needs to settle it at
// the next round. Pure functions, shared by the page and the tests.
export const RACE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];
// The most one driver, or one team's two cars, can score in a session.
const MAX = { driver: { race: 25, sprint: 8 }, team: { race: 43, sprint: 15 } };

// rows: [{ label, pts }] in championship order; remaining: sessions still to be run after the
// points in `rows`, in order: [{ round, name, kind: 'race' | 'sprint' }].
// Level on points is decided on wins, which is left out: a rival who can only draw level still
// counts as in it, and the leader must end up clear to have it settled.
export function titleFight(rows, remaining, who = 'driver') {
  if (rows.length < 2) return null;
  const max = MAX[who];
  const sum = (list) => list.reduce((n, s) => n + max[s.kind], 0);
  const left = sum(remaining);
  const [leader, ...rest] = rows;
  const rivals = rest.filter((r) => r.pts + left >= leader.pts);
  if (!rivals.length) return { decided: true, leader, lead: leader.pts - rest[0].pts, left };
  const next = remaining[0];
  const weekend = remaining.filter((s) => s.round === next.round);
  const weekendMax = sum(weekend);
  const after = left - weekendMax; // still to win once the next round is over
  // need: how many points more than this rival the leader must score at the next round.
  // Zero or less: the title is the leader's unless the rival outscores them by 1 - need.
  const vs = rivals.map((r) => ({ rival: r, lead: leader.pts - r.pts, need: after - (leader.pts - r.pts) + 1 }));
  const canClinch = vs.every((v) => v.need <= weekendMax);
  // One ordinary race left in the round: where each rival may finish for each leader result.
  let table = null;
  if (who === 'driver' && canClinch && weekend.length === 1 && weekend[0].kind === 'race') {
    table = [];
    for (let p = 1; p <= 11; p++) { // 11 = outside the points
      const gain = RACE_PTS[p - 1] || 0;
      const cells = vs.map((v) => {
        const allowed = gain - v.need; // the most the rival may score
        if (allowed < 0) return null;  // not enough whatever the rival does
        if (allowed >= RACE_PTS[0]) return 0; // any result
        const i = RACE_PTS.findIndex((x) => x <= allowed);
        const q = i < 0 ? 11 : i + 1;
        return q === p ? Math.min(11, q + 1) : q; // the leader holds that place
      });
      if (cells.some((c) => c === null)) break;
      table.push({ pos: p, cells });
    }
    if (!table.length) table = null;
  }
  return { decided: false, leader, left, after, next, weekend, weekendMax, vs, canClinch, table };
}
