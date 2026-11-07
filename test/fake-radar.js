// A stand-in for RainViewer's radar API, the CARTO base map and MET Norway's Locationforecast,
// for testing the weather map without internet access:
//   node test/fake-radar.js
//   RAINVIEWER_URL=http://localhost:3098 BASEMAP_URL='http://localhost:3098/base/{z}/{x}/{y}.png' \
//     MET_URL=http://localhost:3098/weatherapi npm run demo
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

// Made-up hourly forecast: dry for a few hours, then a shower. Changes every half hour.
const forecastAt = () => Math.floor(Date.now() / 1800000) * 1800000;
function forecast(lat, lon) {
  const start = Math.ceil(Date.now() / 3600000) * 3600000 - 3600000;
  const SYMS = ['partlycloudy_night', 'cloudy', 'cloudy', 'lightrain', 'rain', 'heavyrainandthunder', 'rain', 'lightrain', 'cloudy', 'fair_night', 'clearsky_night', 'clearsky_night'];
  const MM = [0, 0, 0, 0.3, 1.2, 4.1, 1.6, 0.4, 0, 0, 0, 0];
  return {
    type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat, 0] },
    properties: {
      meta: { updated_at: new Date(forecastAt()).toISOString(), units: { precipitation_amount: 'mm' } },
      timeseries: Array.from({ length: 24 }, (_, i) => ({
        time: new Date(start + i * 3600000).toISOString().replace('.000', ''),
        data: {
          instant: { details: { air_temperature: 21 - i * 0.4, wind_speed: 3.1 } },
          next_1_hours: {
            summary: { symbol_code: SYMS[i % 12] },
            details: { precipitation_amount: MM[i % 12], precipitation_amount_min: MM[i % 12] / 2, precipitation_amount_max: MM[i % 12] * 1.8, probability_of_precipitation: Math.min(95, MM[i % 12] * 30 + 5), probability_of_thunder: i % 12 === 5 ? 40 : 0 },
          },
        },
      })),
    },
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m, body = null, type = 'image/png';
  if (p === '/weatherapi/locationforecast/2.0/complete') {
    const lm = new Date(forecastAt()).toUTCString();
    const headers = { 'Last-Modified': lm, Expires: new Date(forecastAt() + 1800000).toUTCString() };
    if (!/^f1-home-dashboard/.test(req.headers['user-agent'] || '')) { res.writeHead(403); return res.end('identify yourself'); }
    if (req.headers['if-modified-since'] === lm) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(forecast(Number(url.searchParams.get('lat')), Number(url.searchParams.get('lon')))));
  } else if (p === '/public/weather-maps.json') {
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
