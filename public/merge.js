// Shared by the server and the browser: how F1 live-timing updates are merged into state.
// F1 sends partial updates; arrays in the first snapshot get patched later with
// objects keyed by index ("Sectors": {"1": {...}}), and keys can be removed via "_deleted".

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function deepMerge(target, source) {
  if (source === null || typeof source !== 'object') return source;
  if (Array.isArray(source)) return clone(source);
  if (target === null || typeof target !== 'object') target = {};
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (key === '_deleted' && Array.isArray(val)) {
      for (const k of val) {
        if (Array.isArray(target)) target[k] = undefined;
        else delete target[k];
      }
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      target[key] = deepMerge(target[key], val);
    } else {
      target[key] = clone(val);
    }
  }
  return target;
}

// Apply one buffered item to a state object (mutates and returns it).
export function applyItem(state, item) {
  if (item.kind === 'snap') return clone(item.data);
  const { topic, data } = item;
  if (topic === 'Position' || topic === 'Heartbeat' || topic === 'CarData') {
    state[topic] = clone(data); // latest sample only
  } else {
    state[topic] = deepMerge(state[topic], data);
  }
  return state;
}

// Arrays may have turned into index-keyed objects after merges; read either.
export function list(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter((v) => v != null);
  return Object.keys(x)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => x[k])
    .filter((v) => v != null);
}

// Identifies one session, so per-session history can be told apart from the last one.
export function sessionKey(state) {
  const si = state && state.SessionInfo;
  if (!si || !si.Name) return null;
  return `${si.Path || si.Meeting?.Name || ''}|${si.Name}|${si.StartDate || ''}`;
}

// Race-lap ranges of each tyre stint. TotalLaps counts laps on the set including any it
// had before (StartLaps), so the laps run in this stint are TotalLaps − StartLaps.
export function stintRanges(stints) {
  let at = 0;
  return list(stints).map((s) => {
    const laps = Math.max(0, (Number(s.TotalLaps) || 0) - (Number(s.StartLaps) || 0));
    const r = { compound: String(s.Compound || 'UNKNOWN').toUpperCase(), fresh: s.New !== 'false', from: at, to: at + laps };
    at += laps;
    return r;
  });
}
