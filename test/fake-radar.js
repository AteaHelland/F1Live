// A stand-in for RainViewer's radar API and the CARTO base map, for testing the weather map
// without internet access:
//   node test/fake-radar.js
//   RAINVIEWER_URL=http://localhost:3098 BASEMAP_URL='http://localhost:3098/base/{z}/{x}/{y}.png' npm run demo
// The fake radar shows showers drifting east, a frame every 10 minutes; the lower left of every
// tile in column x % 4 == 1 has no radar coverage.
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.PORT || 3098);
const host = `http://localhost:${PORT}`;

function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const COLORS = [[136, 221, 238], [0, 153, 204], [0, 119, 170], [0, 85, 136], [255, 238, 0], [255, 68, 0], [193, 0, 0]];
// Rain intensity 0..1 at a point of the zoom-7 world (512-px tiles), at unix time t.
function rain(gx, gy, t) {
  const drift = (t / 600) * 6; // ~6 px (about 15 km) east every 10 minutes
  const a = Math.sin((gx - drift) / 23) * Math.sin(gy / 31) + 0.6 * Math.sin((gx - drift) / 9 + gy / 13);
  return Math.max(0, (a - 0.95) / 0.65);
}

const frames = () => {
  const last = Math.floor((Date.now() / 1000 - 120) / 600) * 600;
  return Array.from({ length: 13 }, (_, i) => last - (12 - i) * 600).map((time) => ({ time, path: `/v2/radar/${time}` }));
};

const cache = new Map();
function cached(key, make) {
  if (!cache.has(key)) { cache.set(key, make()); if (cache.size > 500) cache.delete(cache.keys().next().value); }
  return cache.get(key);
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  let m, body = null, type = 'image/png';
  if (p === '/public/weather-maps.json') {
    type = 'application/json';
    body = JSON.stringify({ version: '2.0', generated: Math.floor(Date.now() / 1000), host, radar: { past: frames(), nowcast: [] }, satellite: { infrared: [] } });
  } else if ((m = /^\/v2\/radar\/(\d+)\/(256|512)\/(\d+)\/(\d+)\/(\d+)\/\d+\/[\d_]+\.png$/.exec(p))) {
    const [, t, size, , x, y] = m.map(Number);
    body = cached(p, () => png(size, size, (px, py) => {
      const v = rain(x * 512 + (px * 512) / size, y * 512 + (py * 512) / size, t);
      if (v <= 0) return [0, 0, 0, 0];
      return [...COLORS[Math.min(COLORS.length - 1, Math.floor(v * COLORS.length))], 230];
    }));
  } else if ((m = /^\/v2\/coverage\/0\/(256|512)\/\d+\/(\d+)\/(\d+)\/0\/0_0\.png$/.exec(p))) {
    const [, size, x] = m.map(Number);
    body = cached(p, () => png(size, size, (px, py) => (x % 4 === 1 && px < size / 3 && py > size / 2 ? [0, 0, 0, 255] : [0, 0, 0, 0])));
  } else if ((m = /^\/base\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(p))) {
    const [, , x, y] = m.map(Number);
    body = cached(p, () => png(512, 512, (px, py) => {
      const grid = px % 128 === 0 || py % 128 === 0;
      const land = Math.sin((x * 512 + px) / 200) + Math.cos((y * 512 + py) / 170) > -0.6;
      return grid ? [44, 50, 58, 255] : land ? [30, 33, 38, 255] : [18, 22, 30, 255];
    }));
  }
  res.writeHead(body ? 200 : 404, { 'Content-Type': body ? type : 'text/plain' });
  res.end(body || 'not found');
}).listen(PORT, () => console.log(`fake radar on :${PORT}`));
