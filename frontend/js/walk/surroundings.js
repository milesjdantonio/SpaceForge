// What the walkthrough shows outside the windows: the real ground round the building (satellite
// imagery draped over the terrain's real heights) and the neighbouring buildings from the map, all in
// building metres, so each window looks at what really stands there. Anything that can't load falls
// back quietly: flat ground, a plain colour, no neighbours.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { config } from '../config.js';
import { projection, pointInPolygon } from '../lib/geo.js';

const RADIUS = 180;      // metres of real ground round the building
const IMAGERY_Z = 18;    // satellite tiles, about 0.5 m a pixel
const TERRAIN_Z = 15;    // elevation tiles, about 4 m a pixel
const GRID = 96;         // ground mesh cells per side
const PAD_M = 4;         // the ground is flat this far round the building (its pad)
const BLEND_M = 16;      // and eases back to its real height over this distance
const MAX_TILES = 36;

// Converters between [lng, lat] and building metres: x along the width, y along the depth.
export function buildingFrame(placement) {
  const proj = projection(placement.origin);
  const b = (placement.xAxisBearingDeg * Math.PI) / 180;
  const ux = [Math.sin(b), Math.cos(b)], uy = [-Math.cos(b), Math.sin(b)];
  return {
    toLocal(ll) { const [e, n] = proj.toLocal(ll); return [e * ux[0] + n * ux[1], e * uy[0] + n * uy[1]]; },
    toGeo([x, y]) { return proj.toGeo([x * ux[0] + y * uy[0], x * ux[1] + y * uy[1]]); },
  };
}

// Web Mercator tile coordinates (fractional) of a point at a zoom.
function tileXY([lng, lat], z) {
  const n = 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

function loadImage(url, signal) {
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
// origin at that zoom, or null if nothing loaded.
async function mosaic(corners, z, urlFor, signal) {
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

// Ground height (metres above sea level) from Terrarium elevation tiles, sampled bilinearly.
async function terrain(corners, signal) {
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

// Distance from a point to the building's footprint rectangle (0 inside it).
const rectDistance = (x, y, W, D) => Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - D));
const smooth = (t) => t * t * (3 - 2 * t);

// Builds the surroundings for a building placed at `placement` with footprint W x D metres.
// Resolves to a THREE.Group in building metres (x -> X, y -> Z, up -> Y), to be added beside the
// building itself.
export async function buildSurroundings({ map, placement, W, D, signal }) {
  const frame = buildingFrame(placement);
  const cx = W / 2, cy = D / 2;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => frame.toGeo([cx + a * RADIUS, cy + b * RADIUS]));
  const [heightAt, imagery] = await Promise.all([
    terrain(corners, signal).catch((e) => { if (e.name === 'AbortError') throw e; return null; }),
    mosaic(corners, IMAGERY_Z, (z, x, y) => config.map.satellite.url.replace('{z}/{y}/{x}', `${z}/${y}/${x}`), signal)
      .catch((e) => { if (e.name === 'AbortError') throw e; return null; }),
  ]);
  const h0 = heightAt ? heightAt(frame.toGeo([cx, cy])) : 0;
  // Ground height in the walkthrough: real terrain, flattened into a pad round the building.
  const groundAt = (x, y) => {
    if (!heightAt) return 0;
    const t = smooth(Math.min(1, Math.max(0, (rectDistance(x, y, W, D) - PAD_M) / BLEND_M)));
    return (heightAt(frame.toGeo([x, y])) - h0) * t;
  };

  const group = new THREE.Group();
  group.name = 'surroundings';

  // ---- the ground ------------------------------------------------------------------------------
  const n = GRID + 1;
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  let edge = 0, edges = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = cx - RADIUS + (2 * RADIUS * i) / GRID, y = cy - RADIUS + (2 * RADIUS * j) / GRID;
      const k = j * n + i;
      const g = groundAt(x, y) - 0.04; // a touch under the ground floor
      pos.set([x, g, y], k * 3);
      if (i === 0 || j === 0 || i === GRID || j === GRID) { edge += g; edges++; }
      if (imagery) {
        const [tx, ty] = tileXY(frame.toGeo([x, y]), imagery.z);
        uv.set([(tx * 256 - imagery.px0) / imagery.canvas.width, 1 - (ty * 256 - imagery.py0) / imagery.canvas.height], k * 2);
      }
    }
  }
  const index = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  groundGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  groundGeo.setIndex(index);
  groundGeo.computeVertexNormals();
  let groundMat;
  if (imagery) {
    const tex = new THREE.CanvasTexture(imagery.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    groundMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, side: THREE.DoubleSide });
  } else {
    groundMat = new THREE.MeshStandardMaterial({ color: 0x77925a, roughness: 1, side: THREE.DoubleSide });
  }
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  group.add(ground);

  // ---- neighbouring buildings, from the map's own building layer --------------------------------
  const neighbours = buildNeighbours(map, frame, { W, D, groundAt });
  if (neighbours) group.add(neighbours);

  group.userData = { edgeHeight: edges ? edge / edges : 0, imagery: !!imagery, terrain: !!heightAt, neighbours: neighbours?.userData.count ?? 0 };
  return group;
}

function buildNeighbours(map, frame, { W, D, groundAt }) {
  const layer = map?.getStyle()?.layers.find((l) => l.type === 'fill-extrusion');
  if (!layer) return null;
  let features;
  try { features = map.querySourceFeatures(layer.source, { sourceLayer: layer['source-layer'] }); } catch { return null; }
  const site = [[-1, -1], [W + 1, -1], [W + 1, D + 1], [-1, D + 1]];
  const seen = new Set();
  const geos = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const p = f.properties || {};
    const top = Number(p.render_height ?? p.height ?? 6), base = Number(p.render_min_height ?? p.min_height ?? 0);
    if (!(top > base)) continue;
    for (const rings of polys) {
      const outer = rings[0].slice(0, -1).map((ll) => frame.toLocal(ll));
      if (outer.length < 3) continue;
      const mx = outer.reduce((s, q) => s + q[0], 0) / outer.length, my = outer.reduce((s, q) => s + q[1], 0) / outer.length;
      if (Math.hypot(mx - W / 2, my - D / 2) > RADIUS) continue;
      // The same piece can come from more than one tile.
      const key = `${mx.toFixed(1)},${my.toFixed(1)},${outer.length},${top}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Whatever stands where the new building goes is left out: the design replaces it.
      if (outer.some(([x, y]) => pointInPolygon([x, y], site)) || site.some((q) => pointInPolygon(q, outer)) || pointInPolygon([mx, my], site)) continue;
      const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const hole of rings.slice(1)) shape.holes.push(new THREE.Path(hole.slice(0, -1).map((ll) => new THREE.Vector2(...frame.toLocal(ll)))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: top - base, bevelEnabled: false });
      // Shapes are drawn in x/y; turn them so x -> X, y -> Z and the extrusion runs down from y 0.
      geo.rotateX(Math.PI / 2);
      geo.translate(0, groundAt(mx, my) + top, 0);
      geos.push(geo);
    }
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos);
  geos.forEach((geo) => geo.dispose());
  if (!merged) return null;
  merged.computeVertexNormals();
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xdcd8d0, roughness: 0.9, side: THREE.DoubleSide }));
  mesh.name = 'neighbours';
  mesh.userData.count = geos.length;
  return mesh;
}
