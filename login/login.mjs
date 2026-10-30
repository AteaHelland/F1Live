// F1 TV auto-login for the f1.home.arpa dashboard.
// Signs in to formula1.com with a headless browser, reads the subscription token from the
// login-session cookie, and hands it to the dashboard's /api/token endpoint. Checks every few
// hours and only signs in again when the token is about to run out.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const env = (k, d) => process.env[k] ?? d;
const EMAIL = env('F1_EMAIL');
const PASSWORD = env('F1_PASSWORD');
const DASHBOARD_URL = env('DASHBOARD_URL', 'http://192.168.1.250:3080').replace(/\/+$/, '');
const LOGIN_URL = env('LOGIN_URL', 'https://account.formula1.com/#/en/login');
const HOME_URL = env('HOME_URL', 'https://www.formula1.com/');
const CHECK_HOURS = Number(env('CHECK_HOURS', '6'));
const RENEW_HOURS = Number(env('RENEW_HOURS', '36'));   // sign in again when less than this is left
const MAX_FAILURES = Number(env('MAX_FAILURES', '3'));  // then stop trying until you press /run
const PORT = Number(env('PORT', '3081'));
const DATA = env('DATA_DIR', '/data');
const STATE_FILE = `${DATA}/login-state.json`;
const PROFILE_DIR = `${DATA}/browser-profile`;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let state = { tokenExpires: null, sentHash: null, lastAttempt: null, lastResult: 'not run yet', failures: 0, paused: false };
let running = false;
let lastManualRun = 0;

async function loadState() {
  try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; } catch {}
}
async function saveState() {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// ---- token helpers -------------------------------------------------------

function findToken(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.subscriptionToken === 'string') return obj.subscriptionToken;
  for (const v of Object.values(obj)) { const t = findToken(v); if (t) return t; }
  return null;
}
export function parseCookie(value) {
  let s = value;
  for (let i = 0; i < 3; i++) {
    try { return findToken(JSON.parse(s)); } catch {}
    try { s = decodeURIComponent(s); } catch { break; }
  }
  return null;
}
export function jwtExpiry(t) {
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}
const hoursLeft = (exp) => (exp ? (exp - Date.now()) / 3.6e6 : -1);
// Renew RENEW_HOURS before expiry, or at half the token's life if F1 hands out short ones,
// so a short token doesn't mean a sign-in at every check.
const renewAt = () => Math.min(RENEW_HOURS, (state.tokenHours || Infinity) / 2);

async function tokenFromContext(ctx) {
  for (const c of await ctx.cookies()) {
    if (c.name !== 'login-session') continue;
    const t = parseCookie(c.value);
    if (t) return t;
  }
  return null;
}

// ---- browser steps -------------------------------------------------------

// Cookie banners live in iframes on F1's sites; click the accept button wherever it is.
async function acceptConsent(page) {
  const re = /^(accept all|accept|i accept|agree|allow all|godta alle|godta)$/i;
  for (const frame of page.frames()) {
    try {
      const btn = frame.getByRole('button', { name: re }).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        log('closed cookie banner');
        // accepting can reload the page; let that finish before navigating anywhere else
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(1500);
        return;
      }
    } catch {}
  }
}

// Navigate, but survive F1's redirects: account.formula1.com hands off to id.formula1.com while
// loading, which Chromium reports as ERR_ABORTED. In that case carry on from wherever we landed.
async function go(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    if (!/ERR_ABORTED|interrupted by another navigation|frame was detached/i.test(e.message)) throw e;
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await sleep(2000);
    log(`navigation to ${new URL(url).host} was redirected; now on ${where(page)}`);
  }
}

// Page address without the query string (that holds one-time sign-in values).
const where = (page) => {
  try { const u = new URL(page.url()); return u.origin === 'null' ? 'a blank page' : u.origin + u.pathname; } catch { return page.url(); }
};

const USERNAME = 'input[type=email], input[name=username], input#username, input[name=Login], input[autocomplete=username], input[autocomplete=email], input[name*=email i], input[id*=email i]';

async function findVisible(page, selector, ms) {
  const loc = page.locator(selector).first();
  return (await loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false)) ? loc : null;
}

// Bot-protection pages and puzzles. If one shows up we stop and say so rather than retry.
async function challengeShown(page) {
  // Look at host and path only: F1's normal sign-in URL carries "code_challenge=" in its query.
  const bare = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return ''; } };
  if (page.frames().some((f) => /captcha|challenge|turnstile|arkoselabs|funcaptcha/i.test(bare(f.url())))) return true;
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
  return /verify you are (a )?human|are you a robot|unusual activity|access denied|pardon our interruption/i.test(text);
}

async function loginError(page) {
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
  const m = text.match(/(incorrect|invalid|wrong)[^\n]{0,80}(password|email|details|credentials)[^\n]*/i);
  return m ? m[0].trim() : null;
}

async function waitForToken(ctx, page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await tokenFromContext(ctx);
    if (t) return t;
    if (await challengeShown(page)) throw new Error('F1 showed a bot check (captcha) instead of signing in. Sign in by hand or with the browser extension this time; the container tries again at the next check.');
    const err = await loginError(page);
    if (err) throw new Error(`F1 rejected the sign-in: ${err}`);
    await sleep(1000);
  }
  return null;
}

async function signIn(ctx) {
  let page = ctx.pages()[0] || (await ctx.newPage());
  try {
    // 1. A saved browser session may still be signed in; visiting F1 can refresh the cookie
    //    without typing the password at all.
    await go(page, HOME_URL);
    await sleep(3000);
    await acceptConsent(page);
    let t = await tokenFromContext(ctx);
    if (t && hoursLeft(jwtExpiry(t)) > renewAt()) { log('saved session still valid'); return t; }

    // 2. Sign in with email and password, in a fresh tab so nothing from step 1 interferes.
    if (!EMAIL || !PASSWORD) throw new Error('F1_EMAIL and F1_PASSWORD are not set in .env');
    log('signing in with email and password');
    page = await ctx.newPage();
    await go(page, LOGIN_URL);
    await sleep(2000);
    await acceptConsent(page);
    if (await challengeShown(page)) throw new Error('F1 showed a bot check (captcha) on the sign-in page. Sign in by hand or with the browser extension this time.');

    let email = await findVisible(page, USERNAME, 30000);
    if (!email) {
      // Fallback: start from formula1.com and click its Sign in link.
      log(`no sign-in form on ${where(page)}; trying the Sign in link on formula1.com`);
      await go(page, HOME_URL);
      await acceptConsent(page);
      await page.getByRole('link', { name: /sign in|log in/i }).or(page.getByRole('button', { name: /sign in|log in/i })).first().click({ timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await acceptConsent(page);
      email = await findVisible(page, USERNAME, 30000);
    }
    if (!email) throw new Error(`couldn't find the sign-in form (ended on ${where(page)})`);
    log(`sign-in form on ${where(page)}`);
    await email.fill(EMAIL);

    let pw = await findVisible(page, 'input[type=password]', 1500);
    if (!pw) {
      // two-step sign-in: email first, then password
      const next = page.getByRole('button', { name: /^(next|continue|fortsett|neste|sign in|log in|sign on)$/i }).first();
      if (await next.isVisible().catch(() => false)) await next.click(); else await email.press('Enter');
      pw = await findVisible(page, 'input[type=password]', 30000);
      if (!pw) {
        if (await challengeShown(page)) throw new Error('F1 showed a bot check (captcha) after the email step. Sign in by hand or with the browser extension this time.');
        const err = await loginError(page);
        throw new Error(err ? `F1 rejected the sign-in: ${err}` : `no password field appeared after the email step (on ${where(page)})`);
      }
    }
    await pw.fill(PASSWORD);
    await acceptConsent(page);

    // Prefer the submit button in the password field's own form (not an earlier "Continue"),
    // then a visible sign-in button, then Enter.
    const formBtn = pw.locator('xpath=ancestor::form[1]').locator('button[type=submit], input[type=submit], button:not([type])').first();
    const namedBtn = page.getByRole('button', { name: /^(sign in|log in|login|sign on|logg inn|continue|submit)$/i }).last();
    if (await formBtn.isVisible().catch(() => false)) await formBtn.click();
    else if (await namedBtn.isVisible().catch(() => false)) await namedBtn.click();
    else await pw.press('Enter');

    t = await waitForToken(ctx, page, 60000);
    if (!t) {
      // Some flows only set the cookie once you land back on formula1.com.
      await go(page, HOME_URL);
      t = await waitForToken(ctx, page, 20000);
    }
    if (!t) {
      const names = [...new Set((await ctx.cookies()).filter((c) => /formula1/.test(c.domain)).map((c) => c.name))];
      throw new Error(`signed in, but no F1 TV token appeared (ended on ${where(page)}; F1 cookies: ${names.join(', ') || 'none'}). Is F1 TV active on this account?`);
    }
    return t;
  } catch (e) {
    await page.screenshot({ path: `${DATA}/last-error.png`, fullPage: true }).catch(() => {});
    throw e;
  }
}

async function sendToDashboard(token) {
  const res = await fetch(`${DASHBOARD_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, source: 'auto' }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`dashboard answered ${res.status}${j.error ? `: ${j.error}` : ''}`);
  }
}

// ---- the check -----------------------------------------------------------

async function check(reason) {
  if (running) return;
  running = true;
  state.lastAttempt = Date.now();
  let ctx;
  try {
    if (state.tokenExpires && hoursLeft(state.tokenExpires) > renewAt() && state.sentHash) {
      state.lastResult = 'token still valid, nothing to do';
      log(`${reason}: ${state.lastResult} (${hoursLeft(state.tokenExpires).toFixed(0)} h left)`);
      return;
    }
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      locale: 'en-GB',
      viewport: { width: 1280, height: 900 },
    });
    const token = await signIn(ctx);
    const exp = jwtExpiry(token);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    if (hash !== state.sentHash) {
      await sendToDashboard(token);
      state.sentHash = hash;
      log('new token sent to dashboard');
    }
    state.tokenExpires = exp;
    state.tokenHours = exp ? hoursLeft(exp) : null;
    state.failures = 0;
    state.paused = false;
    state.lastResult = `ok, token valid until ${exp ? new Date(exp).toISOString() : 'unknown'}`;
    await fs.rm(`${DATA}/last-error.png`, { force: true });
    log(`${reason}: ${state.lastResult}`);
  } catch (e) {
    state.failures += 1;
    state.lastResult = `failed: ${e.message}`;
    if (state.failures >= MAX_FAILURES) {
      state.paused = true;
      state.lastResult += ` (stopped after ${state.failures} failures so F1 doesn't lock the account; fix it, then press run)`;
    }
    log(`${reason}: ${state.lastResult}`);
  } finally {
    await ctx?.close().catch(() => {});
    await saveState().catch(() => {});
    running = false;
  }
}

// ---- small status server (for Uptime Kuma and a manual "run now") --------

function statusView() {
  const valid = state.tokenExpires && state.tokenExpires > Date.now();
  return {
    ok: Boolean(valid) && !state.paused,
    tokenExpires: state.tokenExpires ? new Date(state.tokenExpires).toISOString() : null,
    hoursLeft: state.tokenExpires ? Math.round(hoursLeft(state.tokenExpires)) : null,
    lastAttempt: state.lastAttempt ? new Date(state.lastAttempt).toISOString() : null,
    lastResult: state.lastResult,
    failures: state.failures,
    paused: state.paused,
    running,
  };
}

http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/status') { const s = statusView(); return send(s.ok ? 200 : 503, s); }
  if (req.url === '/run' && req.method === 'POST') {
    if (running) return send(409, { error: 'already running' });
    if (Date.now() - lastManualRun < 5 * 60 * 1000) return send(429, { error: 'wait a few minutes between manual runs' });
    lastManualRun = Date.now();
    state.paused = false;
    state.failures = 0;
    state.sentHash = null; // force a fresh look and a re-send
    state.tokenExpires = null;
    check('manual run');
    return send(202, { started: true });
  }
  send(404, { error: 'try GET /status or POST /run' });
}).listen(PORT, () => log(`f1tv-login status on :${PORT}`));

await fs.mkdir(DATA, { recursive: true });
await loadState();
if (state.paused) log(`paused after repeated failures: ${state.lastResult}. POST /run to try again.`);
else check('startup');
setInterval(() => { if (!state.paused) check('scheduled'); }, CHECK_HOURS * 3.6e6);
