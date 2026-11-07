// Shared by the server and the browser: which map tiles make up the weather map around a circuit.
//
// Everything is measured in zoom-8 web-map pixels (256-px tiles). The base map is drawn from
// zoom-8 tiles; the rain radar comes as 512-px zoom-7 tiles, which cover exactly 2×2 zoom-8
// tiles, so both line up pixel for pixel.

export const BASE_Z = 8;
export const RADAR_Z = 7;           // RainViewer's free API stops at zoom 7
export const RADAR_SIZE = 512;
export const VIEW_W = 768, VIEW_H = 576; // the map shown: about 470 × 350 km at the equator

const R = 6378137;

// Latitude/longitude → pixel position in the zoom-8 world.
export function worldPx(lat, lon) {
  const n = 256 * 2 ** BASE_Z;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

// The map window around a point, plus metres per pixel there.
export function mapView(lat, lon) {
  const [cx, cy] = worldPx(lat, lon);
  return {
    cx, cy, w: VIEW_W, h: VIEW_H, x0: cx - VIEW_W / 2, y0: cy - VIEW_H / 2,
    mPerPx: (2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** BASE_Z),
  };
}

// Tiles at zoom `z` that overlap the window: { z, x, y, left, top, size } in window pixels.
export function tilesFor(v, z) {
  const size = 256 * 2 ** (BASE_Z - z); // a tile's width in zoom-8 pixels
  const max = 2 ** z;
  const out = [];
  for (let y = Math.floor(v.y0 / size); y * size < v.y0 + v.h; y++) {
    if (y < 0 || y >= max) continue;
    for (let x = Math.floor(v.x0 / size); x * size < v.x0 + v.w; x++) {
      out.push({ z, x: ((x % max) + max) % max, y, left: x * size - v.x0, top: y * size - v.y0, size });
    }
  }
  return out;
}

export const radarTiles = (lat, lon) => tilesFor(mapView(lat, lon), RADAR_Z);
export const baseTiles = (lat, lon) => tilesFor(mapView(lat, lon), BASE_Z);
