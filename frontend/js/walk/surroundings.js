// What the walkthrough shows outside the windows: the real ground round the building (satellite
// imagery draped over the terrain's real heights) and the neighbouring buildings from the map, all in
// building metres, so each window looks at what really stands there. Anything that can't load falls
// back quietly: flat ground, a plain colour, no neighbours.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { config } from '../config.js';
import { projection, pointInPolygon } from '../lib/geo.js';
import { buildingLayers } from '../map/map.js';
import { tileXY, mosaic, heightSampler } from '../lib/terrain.js';

const RADIUS = 180;      // metres of real ground round the building
const IMAGERY_Z = 18;    // satellite tiles, about 0.5 m a pixel
const GRID = 96;         // ground mesh cells per side
const PAD_M = 4;         // the ground is flat this far round the building (its pad)
const BLEND_M = 16;      // and eases back to its real height over this distance

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

// Distance from a point to the building's footprint rectangle (0 inside it).
const rectDistance = (x, y, W, D) => Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - D));
const smooth = (t) => t * t * (3 - 2 * t);

// Builds the surroundings for a building placed at `placement` with footprint W x D metres.
// Resolves to a THREE.Group in building metres (x -> X, y -> Z, up -> Y), to be added beside the
// building itself.
export async function buildSurroundings({ map, placement, W, D, foundation = null, signal }) {
  const frame = buildingFrame(placement);
  const cx = W / 2, cy = D / 2;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => frame.toGeo([cx + a * RADIUS, cy + b * RADIUS]));
  const [heightAt, imagery] = await Promise.all([
    heightSampler(corners, signal).catch((e) => { if (e.name === 'AbortError') throw e; return null; }),
    mosaic(corners, IMAGERY_Z, (z, x, y) => config.map.satellite.url.replace('{z}/{y}/{x}', `${z}/${y}/${x}`), signal)
      .catch((e) => { if (e.name === 'AbortError') throw e; return null; }),
  ]);
  // On a slope the design says how the ground meets the building (foundation.groundM, from the
  // ground floor's floor); the real terrain is lined up with that and left as it is. Elsewhere it's
  // flattened into a pad round the building.
  const sloped = foundation && foundation.dropM >= 0.4;
  const groundMid = sloped ? foundation.groundM.reduce((s, v) => s + v, 0) / 4 : 0;
  const h0 = (heightAt ? heightAt(frame.toGeo([cx, cy])) : 0) - groundMid;
  const groundAt = (x, y) => {
    if (!heightAt) return sloped ? groundMid : 0;
    if (sloped) return heightAt(frame.toGeo([x, y])) - h0;
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

// A building's top and base in metres, from Overture (height, floors) or OpenFreeMap (render_height).
function heights(p) {
  const top = p.height ?? (p.num_floors != null ? p.num_floors * STOREY_M : null) ?? p.render_height ?? 5;
  const base = p.min_height ?? (p.min_floor != null ? p.min_floor * STOREY_M : null) ?? p.render_min_height ?? 0;
  return [Number(top), Number(base)];
}
const STOREY_M = 3.2;

function buildNeighbours(map, frame, { W, D, groundAt }) {
  if (!map) return null;
  // The same buildings the map draws: Overture's (whole buildings without parts, and parts), or the
  // OpenFreeMap fallback.
  let features = [];
  try {
    for (const id of buildingLayers(map)) {
      const layer = map.getLayer(id);
      const own = id === 'buildings-world' ? (f) => f.properties.has_parts !== true : () => true;
      features.push(...map.querySourceFeatures(layer.source, { sourceLayer: layer.sourceLayer }).filter((f) => f.properties.is_underground !== true && own(f)));
    }
  } catch { return null; }
  const site = [[-1, -1], [W + 1, -1], [W + 1, D + 1], [-1, D + 1]];
  const seen = new Set();
  const geos = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const [top, base] = heights(f.properties || {});
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
