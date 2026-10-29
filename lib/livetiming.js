// Minimal SignalR Core (JSON protocol) client for F1 live timing.
// No dependencies: uses Node's built-in fetch and WebSocket (Node 22+).
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';

const RS = '\x1e'; // SignalR record separator
const UA = 'f1-home-dashboard/1.0';

export const BASE_TOPICS = [
  'Heartbeat', 'SessionInfo', 'SessionStatus', 'TrackStatus', 'LapCount',
  'ExtrapolatedClock', 'DriverList', 'TimingData', 'TimingAppData',
  'TimingStats', 'RaceControlMessages', 'WeatherData',
];
// Only delivered with a valid F1 TV subscription token.
export const AUTH_TOPICS = ['Position.z'];

export function decodeZ(str) {
  return JSON.parse(zlib.inflateRawSync(Buffer.from(str, 'base64')).toString('utf8'));
}

// Turn a raw hub topic into what we store; returns [topic, data] or null.
export function normalize(topic, data) {
  if (topic === 'Position.z') {
    const d = typeof data === 'string' ? decodeZ(data) : data;
    const samples = d && d.Position;
    if (!samples || !samples.length) return null;
    return ['Position', samples[samples.length - 1]];
  }
  if (topic.endsWith('.z')) return null;
  return [topic, data];
}

export class LiveTimingClient extends EventEmitter {
  constructor({ baseUrl = 'https://livetiming.formula1.com/signalrcore', getToken = () => null } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.getToken = getToken;
    this.wanted = false;
    this.ws = null;
    this.status = 'idle';
    this.lastError = null;
    this.lastMessageAt = null;
    this.positionEnabled = false;
    this.tokenRejected = false;
    this.attempt = 0;
    this.invId = 0;
  }

  setStatus(s, err) {
    this.status = s;
    if (err !== undefined) this.lastError = err;
    this.emit('status', this.info());
  }

  info() {
    return {
      status: this.status,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      positionEnabled: this.positionEnabled,
      tokenRejected: this.tokenRejected,
    };
  }

  start() {
    this.wanted = true;
    if (!this.ws && !this.connecting) this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.teardown();
    this.setStatus('idle');
  }

  // Reconnect, e.g. after the token changed.
  restart() {
    this.tokenRejected = false;
    this.teardown();
    if (this.wanted) this.connect();
  }

  teardown() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = ws.onmessage = ws.onerror = null;
      try { ws.close(); } catch {}
    }
  }

  scheduleRetry() {
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    const delays = [2, 5, 10, 30, 60];
    const s = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect(), s * 1000);
  }

  async connect() {
    if (this.connecting) return;
    this.connecting = true;
    this.teardown();
    this.setStatus('connecting');
    try {
      const token = this.tokenRejected ? null : this.getToken();
      const headers = { 'User-Agent': UA };
      if (token) headers.Authorization = `Bearer ${token}`;

      const neg = await fetch(`${this.baseUrl}/negotiate?negotiateVersion=1`, { method: 'POST', headers });
      if ((neg.status === 401 || neg.status === 403) && token) {
        this.tokenRejected = true;
        throw new Error('F1 TV token was rejected (expired?) — running without it');
      }
      if (!neg.ok) throw new Error(`negotiate failed: HTTP ${neg.status}`);
      const cookies = (neg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
      const info = await neg.json();
      const id = info.connectionToken || info.connectionId;
      if (!id) throw new Error('negotiate returned no connection id');

      const wsHeaders = { ...headers };
      if (cookies) wsHeaders.Cookie = cookies;
      const url = `${this.baseUrl.replace(/^http/, 'ws')}?id=${encodeURIComponent(id)}`;
      const ws = new WebSocket(url, { headers: wsHeaders });
      this.ws = ws;
      this.buf = '';
      this.handshaken = false;
      this.withAuth = Boolean(token);

      ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ws.onmessage = (ev) => {
        try { this.onData(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); }
        catch (e) { this.setStatus('error', `bad message: ${e.message}`); }
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        clearInterval(this.pingTimer);
        this.ws = null;
        this.setStatus('disconnected', this.lastError || `socket closed (${ev.code})`);
        this.scheduleRetry();
      };
    } catch (e) {
      this.setStatus('error', e.message);
      if (this.tokenRejected && /rejected/.test(e.message)) {
        setTimeout(() => this.connect(), 500); // retry right away without the token
      } else {
        this.scheduleRetry();
      }
    } finally {
      this.connecting = false;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj) + RS);
  }

  subscribe(withAuth) {
    const topics = withAuth ? [...BASE_TOPICS, ...AUTH_TOPICS] : BASE_TOPICS;
    this.subId = String(++this.invId);
    this.subWithAuth = withAuth;
    this.send({ type: 1, invocationId: this.subId, target: 'Subscribe', arguments: [topics] });
  }

  onData(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf(RS)) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!raw) continue;
      const msg = JSON.parse(raw);
      if (!this.handshaken) {
        if (msg.error) throw new Error(`handshake: ${msg.error}`);
        this.handshaken = true;
        this.pingTimer = setInterval(() => this.send({ type: 6 }), 15000);
        this.subscribe(this.withAuth);
        continue;
      }
      this.lastMessageAt = Date.now();
      if (msg.type === 1 && String(msg.target).toLowerCase() === 'feed') {
        const [topic, data] = msg.arguments || [];
        const n = normalize(topic, data);
        if (n) this.emit('update', n[0], n[1]);
      } else if (msg.type === 3 && msg.invocationId === this.subId) {
        if (msg.error) {
          if (this.subWithAuth) { this.subscribe(false); continue; }
          throw new Error(`subscribe: ${msg.error}`);
        }
        this.attempt = 0;
        this.positionEnabled = this.subWithAuth;
        const snap = {};
        for (const [topic, data] of Object.entries(msg.result || {})) {
          const n = normalize(topic, data);
          if (n) snap[n[0]] = n[1];
        }
        this.lastError = this.tokenRejected ? this.lastError : null;
        this.setStatus('connected');
        this.emit('snapshot', snap);
      } else if (msg.type === 7) {
        this.lastError = msg.error ? `server closed: ${msg.error}` : null;
      }
    }
  }
}
