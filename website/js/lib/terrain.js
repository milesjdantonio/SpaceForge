// Ground heights anywhere on Earth, from Terrarium elevation tiles (config.map.terrain, about 4 m a
// pixel at zoom 15), and what they say about a piece of land: how much it rises and falls, how
// steep it is, which way it drops, and contour lines across it.

import { config } from '../config.js';
import { projection, pointInPolygon, ringCentroidLngLat } from './geo.js';

export const TERRAIN_Z = 15;
const MAX_TILES = 36;

// Web Mercator tile coordinates (fractional) of a point at a zoom.
export function tileXY([lng, lat], z) {
  const n = 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function loadImage(url, signal) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`Couldn't load ${url}`));
    signal?.addEventListener('abort', () => { img.src = ''; fail(new DOMException('Aborted', 'AbortError')); }, { once: true });
    img.src = url;
  });
}

// Draws the tiles covering [lng, lat] corners into one canvas. Returns the canvas and its pixel
// origin at that zoom, or null if nothing loaded (or it would take too many tiles).
export async function mosaic(corners, z, urlFor, signal) {
  const xy = corners.map((c) => tileXY(c, z));
  const tx0 = Math.floor(Math.min(...xy.map((p) => p[0]))), tx1 = Math.floor(Math.max(...xy.map((p) => p[0])));
  const ty0 = Math.floor(Math.min(...xy.map((p) => p[1]))), ty1 = Math.floor(Math.max(...xy.map((p) => p[1])));
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_TILES) return null;
  const canvas = document.createElement('canvas');
  canvas.width = (tx1 - tx0 + 1) * 256;
  canvas.height = (ty1 - ty0 + 1) * 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  let loaded = 0;
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      jobs.push(loadImage(urlFor(z, x, y), signal).then((img) => { ctx.drawImage(img, (x - tx0) * 256, (y - ty0) * 256); loaded++; }).catch((e) => { if (e.name === 'AbortError') throw e; }));
    }
  }
  await Promise.all(jobs);
  return loaded ? { canvas, ctx, px0: tx0 * 256, py0: ty0 * 256, z } : null;
}

// A function giving the ground height (metres above sea level) at [lng, lat], sampled bilinearly
// from the tiles covering the corners. null when the tiles can't load.
export async function heightSampler(corners, signal) {
  const m = await mosaic(corners, TERRAIN_Z, (z, x, y) => `${config.map.terrain}/${z}/${x}/${y}.png`, signal);
  if (!m) return null;
  const { width: w, height: h } = m.canvas;
  const px = m.ctx.getImageData(0, 0, w, h).data;
  const at = (i, j) => {
    const k = (Math.max(0, Math.min(h - 1, j)) * w + Math.max(0, Math.min(w - 1, i))) * 4;
    return px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
  };
  return (ll) => {
    const [tx, ty] = tileXY(ll, TERRAIN_Z);
    const fx = tx * 256 - m.px0 - 0.5, fy = ty * 256 - m.py0 - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    return (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
  };
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

// The lie of the land inside an outline ([lng, lat] ring): a height grid over it (in local metres),
// the lowest and highest points, the average and steepest slope (%), which way it drops, and
// contour lines. Resolves to null when there's no elevation data.
// `imperial` picks contour intervals that are round in feet, so their labels read 5,400 ft not 5,397.
export async function surveyLand(ring, { signal, cell, imperial = false } = {}) {
  const c = ringCentroidLngLat(ring);
  const proj = projection(c);
  const local = ring.map(proj.toLocal);
  const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
  const pad = 8;
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const heightAt = await heightSampler([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(proj.toGeo), signal);
  if (!heightAt) return null;
  // About 60 cells across, never finer than 1 m (the data is ~4 m).
  const step = cell ?? Math.max(1, Math.max(x1 - x0, y1 - y0) / 60);
  const cols = Math.ceil((x1 - x0) / step) + 1, rows = Math.ceil((y1 - y0) / step) + 1;
  const z = new Float64Array(rows * cols);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) z[j * cols + i] = heightAt(proj.toGeo([x0 + i * step, y0 + j * step]));
  const grid = { x0, y0, step, cols, rows, z };

  // Inside the land only: extremes, slopes, and the overall fall (a plane fitted to the heights).
  let lo = Infinity, hi = -Infinity, sum = 0, n = 0, steep = 0;
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  const inside = (x, y) => pointInPolygon([x, y], local);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const x = x0 + i * step, y = y0 + j * step;
      if (!inside(x, y)) continue;
      const h = z[j * cols + i];
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      const gx = (z[j * cols + i + 1] - z[j * cols + i - 1]) / (2 * step);
      const gy = (z[(j + 1) * cols + i] - z[(j - 1) * cols + i]) / (2 * step);
      const s = Math.hypot(gx, gy) * 100;
      sum += s; n++; steep = Math.max(steep, s);
      sx += x; sy += y; sz += h; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * h; syz += y * h;
    }
  }
  if (!n) return null;
  // Least-squares plane h = a x + b y + c: its downhill direction is -(a, b).
  const det = (A) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const D = det(M);
  let a = 0, b = 0;
  if (Math.abs(D) > 1e-9) {
    a = det([[sxz, sxy, sx], [syz, syy, sy], [sz, sy, n]]) / D;
    b = det([[sxx, sxz, sx], [sxy, syz, sy], [sx, sz, n]]) / D;
  }
  const fallPct = Math.hypot(a, b) * 100;
  const downhill = ((Math.atan2(-a, -b) * 180) / Math.PI + 360) % 360; // compass bearing
  const relief = hi - lo;
  // About 4 to 10 lines across the land, at a round interval.
  const FT = 0.3048;
  const steps = imperial ? [2, 5, 10, 20, 50, 100].map((f) => f * FT) : [0.5, 1, 2, 5, 10, 20];
  const interval = steps.find((s) => relief / s <= 10) ?? steps[steps.length - 1];
  return {
    lowM: lo, highM: hi, reliefM: relief,
    slopeMeanPct: sum / n, slopeMaxPct: steep, fallPct,
    downhillDeg: downhill, downhillName: COMPASS[Math.round(downhill / 45) % 8],
    steepness: slopeClass(sum / n),
    interval,
    contours: contourLines(grid, interval).map((l) => ({ level: l.level, coords: l.points.map(([x, y]) => proj.toGeo([x, y])) })),
  };
}

// Plain words for an average slope, and what building on it involves.
export function slopeClass(pct) {
  if (pct < 3) return { name: 'flat', note: 'A level pad needs little earthwork.' };
  if (pct < 8) return { name: 'gentle slope', note: 'A slab with a little grading, or a raised floor on one side.' };
  if (pct < 15) return { name: 'moderate slope', note: 'Expect a stepped foundation, a walkout level or retaining walls.' };
  if (pct < 30) return { name: 'steep slope', note: 'Suits a split-level, a walkout basement or a floor raised on piers; costs more to build.' };
  return { name: 'very steep', note: 'Needs piers, deep foundations or a cantilever, with a geotechnical survey first.' };
}

// Contour lines by marching squares over the grid, joined into polylines.
function contourLines(g, interval) {
  const { x0, y0, step, cols, rows, z } = g;
  let lo = Infinity, hi = -Infinity;
  for (const v of z) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const out = [];
  for (let level = Math.ceil(lo / interval) * interval; level <= hi; level += interval) {
    const segs = [];
    const at = (i, j) => z[j * cols + i];
    const lerp = (i1, j1, i2, j2) => {
      const a = at(i1, j1), b = at(i2, j2), t = (level - a) / (b - a || 1e-9);
      return [x0 + (i1 + (i2 - i1) * t) * step, y0 + (j1 + (j2 - j1) * t) * step];
    };
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const c = (at(i, j) >= level ? 1 : 0) | (at(i + 1, j) >= level ? 2 : 0) | (at(i + 1, j + 1) >= level ? 4 : 0) | (at(i, j + 1) >= level ? 8 : 0);
        if (c === 0 || c === 15) continue;
        const e = { t: () => lerp(i, j, i + 1, j), r: () => lerp(i + 1, j, i + 1, j + 1), b: () => lerp(i, j + 1, i + 1, j + 1), l: () => lerp(i, j, i, j + 1) };
        const pairs = { 1: ['l', 't'], 2: ['t', 'r'], 3: ['l', 'r'], 4: ['r', 'b'], 5: ['l', 't', 'r', 'b'], 6: ['t', 'b'], 7: ['l', 'b'], 8: ['b', 'l'], 9: ['b', 't'], 10: ['t', 'r', 'b', 'l'], 11: ['b', 'r'], 12: ['r', 'l'], 13: ['r', 't'], 14: ['t', 'l'] }[c];
        for (let k = 0; k < pairs.length; k += 2) segs.push([e[pairs[k]](), e[pairs[k + 1]]()]);
      }
    }
    for (const points of joinSegments(segs)) if (points.length > 2) out.push({ level, points });
  }
  return out;
}

// Joins segments that share end points into longer lines.
function joinSegments(segs) {
  const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const ends = new Map();
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [...segs[i]];
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) || []).find((k) => !used[k]);
        if (next == null) break;
        used[next] = 1;
        const [a, b] = segs[next];
        const other = key(a) === key(tip) ? b : a;
        if (forward) line.push(other); else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}
