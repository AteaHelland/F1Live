// A tiny fake of F1's SignalR Core hub, fed by the race simulator, to test the real client end to end.
// Usage: node test/fake-hub.js [port]
import http from 'node:http';
import crypto from 'node:crypto';
import { RaceSimulator } from '../lib/demo.js';

const PORT = Number(process.argv[2] || 9100);
const RS = '\x1e';
const sim = new RaceSimulator();
const sockets = new Set();
let validToken = 'good.token.sig';

function frame(text) {
  const p = Buffer.from(text);
  let head;
  if (p.length < 126) head = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([head, p]);
}

function parseFrames(conn, chunk) {
  conn.buf = Buffer.concat([conn.buf, chunk]);
  const out = [];
  while (conn.buf.length >= 2) {
    const b = conn.buf;
    const op = b[0] & 0x0f;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = b[1] & 0x80;
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) break;
    let payload = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      payload = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
    }
    conn.buf = b.subarray(need);
    out.push({ op, text: payload.toString() });
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/signalrcore/negotiate') && req.method === 'POST') {
    const auth = req.headers.authorization;
    if (auth && auth !== `Bearer ${validToken}`) { res.writeHead(401); return res.end('unauthorized'); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'AWSALBCORS=sticky123; Path=/; Secure' });
    return res.end(JSON.stringify({ negotiateVersion: 1, connectionId: 'c1', connectionToken: 'tok-1', availableTransports: [{ transport: 'WebSockets' }] }));
  }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('id') !== 'tok-1' || !String(req.headers.cookie).includes('AWSALBCORS=sticky123')) {
    console.log('rejected upgrade', req.url, req.headers.cookie);
    socket.destroy();
    return;
  }
  const authed = req.headers.authorization === `Bearer ${validToken}`;
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const conn = { socket, buf: Buffer.alloc(0), subscribed: null, authed };
  sockets.add(conn);
  const send = (obj) => socket.write(frame(JSON.stringify(obj) + RS));
  socket.on('data', (chunk) => {
    for (const f of parseFrames(conn, chunk)) {
      if (f.op === 8) { socket.end(); return; }
      for (const raw of f.text.split(RS).filter(Boolean)) {
        const m = JSON.parse(raw);
        if (m.protocol) { socket.write(frame('{}' + RS)); continue; }
        if (m.type === 1 && m.target === 'Subscribe') {
          const topics = m.arguments[0];
          const snap = sim.rawSnapshot();
          const result = {};
          for (const t of topics) {
            if (t.endsWith('.z') && !conn.authed) continue;
            if (snap[t] !== undefined) result[t] = snap[t];
          }
          conn.subscribed = new Set(topics.filter((t) => !t.endsWith('.z') || conn.authed));
          console.log(`subscribe (${conn.authed ? 'with' : 'without'} token):`, Object.keys(result).join(','));
          send({ type: 3, invocationId: m.invocationId, result });
        }
      }
    }
  });
  socket.on('close', () => sockets.delete(conn));
  socket.on('error', () => sockets.delete(conn));
});

sim.on('raw', (topic, data) => {
  for (const c of sockets) {
    if (c.subscribed?.has(topic)) c.socket.write(frame(JSON.stringify({ type: 1, target: 'feed', arguments: [topic, data, new Date().toISOString()] }) + RS));
  }
});
setInterval(() => sim.tick(0.5), 500);
setInterval(() => { for (const c of sockets) c.socket.write(frame('{"type":6}' + RS)); }, 10000);
server.listen(PORT, () => console.log(`fake hub on :${PORT}`));
