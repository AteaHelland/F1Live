// Accepts the raw token, the whole `login-session` cookie value, or its decoded JSON.
export function extractToken(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch {}
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      return j?.data?.subscriptionToken || j?.subscriptionToken || null;
    } catch { return null; }
  }
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s) ? s : null;
}

