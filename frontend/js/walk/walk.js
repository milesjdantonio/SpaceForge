// Walkthrough: the whole building drawn from its terrasim.design/2 file, every level at its real
// height. The file lists every wall, opening, stair, elevator, balcony and piece of furniture, and
// this draws exactly those. Look around by dragging; click a spot on the floor (or a step, or a floor
// seen up the stairwell) to glide there, the way Street View moves. Inside an elevator, pick a floor.
// Building metres map to three.js as x -> X, y -> Z, height -> Y, inside a world group that flips Z
// so the building isn't mirrored (see openWalkthrough). Outside the windows are the real ground and
// neighbouring buildings (surroundings.js).

import * as THREE from 'three';
import { icon } from '../ui/icons.js';
import { buildFurnishings } from './furniture.js';
import { buildSurroundings } from './surroundings.js';
import { openingSegment, wallLength, wallPointAt, rectPoly, bounds, centroid, pointInPolygon, roomAt, renderable } from '../lib/design.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const EYE = 1.6;

const FINISH_COLORS = { wood: 0xb48c63, tile: 0xd5d8da, carpet: 0x9a958c, concrete: 0xa8a6a1, stone: 0xc9c2b6, vinyl: 0xbdb3a3 };
const FINISH_ROUGH = { wood: 0.65, tile: 0.4, carpet: 1, concrete: 0.85, stone: 0.5, vinyl: 0.6 };

function paletteHex(design, use, fallback) {
  const p = (design.exterior?.materials?.palette || []).find((x) => (x.use || '').toLowerCase() === use);
  return p ? new THREE.Color(p.hex) : new THREE.Color(fallback);
}

function materials(design) {
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide, ...extra });
  const floors = {};
  for (const [k, c] of Object.entries(FINISH_COLORS)) floors[k] = std(c, { roughness: FINISH_ROUGH[k] });
  return {
    interior: std(paletteHex(design, 'interior-walls', 0xf1ece4)),
    party: std(0xe9e3d9),
    exterior: std(paletteHex(design, 'walls', 0xe8e2d7)),
    floors,
    ceil: std(0xfbf9f5, { roughness: 1 }),
    slab: std(0xbdb7ad),
    stair: std(0xa47b55, { roughness: 0.6 }),
    stairBody: std(0xe6e0d6),
    rail: std(0x2c3035, { roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xcfe2f2, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, side: THREE.DoubleSide }),
    frame: std(paletteHex(design, 'windows', 0x2b2f33), { roughness: 0.6 }),
    door: std(paletteHex(design, 'doors', 0x8a6a4a), { roughness: 0.7 }),
    elevator: std(0x9aa1a8, { roughness: 0.35, metalness: 0.5 }),
  };
}

// Builds the building a floor at a time, as you get near each one. Returns the group, the surfaces
// you can click to move to, the stairs, and showAround(level), which builds and shows the floors
// next to `level` and hides the rest, so a big building only draws what can be seen.
function buildBuilding(design) {
  const M = materials(design);
  const group = new THREE.Group();
  const levelGroups = design.levels.map((l, li) => { const g = new THREE.Group(); g.userData.level = li; g.visible = false; group.add(g); return g; });
  const built = new Set();
  let into = group; // where the helpers below put what they make
  const walkable = new Set();
  const stairs = [];
  const levels = design.levels;
  const top = levels.length - 1;

  const flat = (poly, y, mat, { walk = false, level = 0, holes = [] } = {}) => {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, z)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z))));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.userData = { level, floor: walk };
    into.add(mesh);
    if (walk) walkable.add(mesh);
    return mesh;
  };

  // A slab of a wall between two points along it (t0..t1), from height y0 to y1. A curved wall is
  // built from short straight slabs that follow its curve, each a little longer so they meet.
  const piece = (w, t0, t1, y0, y1, mat, thick) => {
    if (w.arc) {
      const len = wallLength(w);
      const n = Math.max(1, Math.ceil(((t1 - t0) * len) / 0.35));
      let last = null;
      for (let i = 0; i < n; i++) {
        const a = wallPointAt(w, (t0 + ((t1 - t0) * i) / n) * len), b = wallPointAt(w, (t0 + ((t1 - t0) * (i + 1)) / n) * len);
        last = slab(a, b, y0, y1, mat, thick, i < n - 1 ? 0.02 : 0);
      }
      return last;
    }
    const ax = w.x1 + (w.x2 - w.x1) * t0, az = w.y1 + (w.y2 - w.y1) * t0;
    const bx = w.x1 + (w.x2 - w.x1) * t1, bz = w.y1 + (w.y2 - w.y1) * t1;
    return slab([ax, az], [bx, bz], y0, y1, mat, thick);
  };
  const slab = ([ax, az], [bx, bz], y0, y1, mat, thick, extra = 0) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02 || y1 - y0 < 0.02) return null;
    const m = new THREE.Mesh(new THREE.BoxGeometry(len + extra, y1 - y0, thick), mat);
    m.position.set((ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2);
    m.rotation.y = -Math.atan2(bz - az, bx - ax);
    into.add(m);
    return m;
  };

  // A door leaf hinged at the opening's start, swung 90° to lie along the wall's inward side.
  const openLeaf = (w, t0, t1, y0, y1, mat, level) => {
    const ax = w.x1 + (w.x2 - w.x1) * t0, az = w.y1 + (w.y2 - w.y1) * t0;
    const bx = w.x1 + (w.x2 - w.x1) * t1, bz = w.y1 + (w.y2 - w.y1) * t1;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.2) return null;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let nx = -uz, nz = ux;
    if (!pointInPolygon((ax + bx) / 2 + nx * 0.3, (az + bz) / 2 + nz * 0.3, level.outline)) { nx = -nx; nz = -nz; }
    const leafLen = len - 0.04, thick = 0.045;
    const m = new THREE.Mesh(new THREE.BoxGeometry(leafLen, y1 - y0, thick), mat);
    const t = (w.thicknessM ?? 0.12) / 2 + thick / 2;
    m.position.set(ax + ux * 0.02 + nx * (leafLen / 2 + t) + ux * thick / 2, (y0 + y1) / 2, az + uz * 0.02 + nz * (leafLen / 2 + t) + uz * thick / 2);
    m.rotation.y = -Math.atan2(nz, nx);
    m.userData.door = true;
    into.add(m);
    return m;
  };

  function buildLevel(li) {
    const level = levels[li];
    into = levelGroups[li];
    const base = level.elevationM;
    const ceilY = base + (level.ceilingHeightM ?? level.heightM - 0.3);
    const wallTop = li < top ? base + level.heightM : ceilY + 0.05;

    // Floors: each room in its own finish, except where a stair arrives from below (the well).
    const arriving = (design.stairs || []).filter((s) => s.toLevel === li);
    const wellAt = (r) => arriving.some((s) => pointInPolygon(s.x + s.widthM / 2, s.y + s.depthM / 2, r.polygon));
    for (const r of level.rooms) {
      if (r.type === 'stair' && wellAt(r)) continue;
      flat(r.polygon, base + 0.002, M.floors[r.floorFinish] ?? M.floors.wood, { walk: true, level: li });
    }
    // Ceiling over the whole outline, open over stairs leaving this level; a slab edge below it.
    const leaving = (design.stairs || []).filter((s) => s.fromLevel === li).map(rectPoly);
    flat(level.outline, ceilY, M.ceil, { level: li, holes: leaving });

    // Walls exactly as listed, with their openings cut out.
    const byWall = new Map();
    for (const o of level.openings || []) {
      if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
      byWall.get(o.wallId).push(o);
    }
    for (const w of level.walls || []) {
      const mat = M[w.kind] ?? M.interior;
      const thick = w.thicknessM ?? 0.12;
      const len = wallLength(w);
      const ops = (byWall.get(w.id) || []).map((o) => ({ o, ...openingSegment(w, o) })).sort((a, b) => a.t0 - b.t0);
      let t = 0;
      for (const { o, t0, t1 } of ops) {
        if (t0 > t) piece(w, t, t0, base, wallTop, mat, thick);
        const head = base + (o.headM ?? 2.1);
        if (o.kind === 'window') {
          const sill = base + (o.sillM ?? 0.8);
          piece(w, t0, t1, base, sill, mat, thick);
          piece(w, t0, t1, head, wallTop, mat, thick);
          piece(w, t0, t1, sill, head, M.glass, 0.03);
          piece(w, t0, t1, sill - 0.04, sill, M.frame, thick + 0.05);
          piece(w, t0, t1, head, head + 0.04, M.frame, thick + 0.03);
        } else {
          piece(w, t0, t1, head, wallTop, mat, thick);
          if (o.kind === 'patio') {
            piece(w, t0, t1, base, head, M.glass, 0.03);
            piece(w, t0 + (t1 - t0) * 0.495, t0 + (t1 - t0) * 0.505, base, head, M.frame, 0.06);
          }
          // Doors stand open so you can walk in: the front door swung into the room on its hinge,
          // the garage door rolled up out of the way.
          if (o.kind === 'entry') openLeaf(w, t0, t1, base, head - 0.02, M.door, level);
          if (o.kind === 'door' || o.kind === 'entry') piece(w, t0, t1, head, head + 0.05, M.frame, thick + 0.02);
        }
        t = Math.max(t, t1);
      }
      if (t < 1) piece(w, t, 1, base, wallTop, mat, thick);
    }

    // Elevator cabs: a lit floor and steel walls are the walls of the room; add a call panel mark.
    for (const e of design.elevators || []) {
      if (!e.levels.includes(li)) continue;
      flat(rectPoly(e), base + 0.006, M.elevator, { walk: true, level: li }).userData.elevator = e.id;
    }

    // Balconies: a slab and a railing on every edge not against the building.
    for (const b of level.balconies || []) {
      const slab = flat(b.polygon, base + 0.002, M.floors.wood, { walk: true, level: li });
      slab.userData.balcony = b.id;
      const under = new THREE.Mesh(new THREE.BoxGeometry(1, 0.18, 1), M.slab);
      const bb = bounds(b.polygon);
      under.scale.set(bb.x1 - bb.x0, 1, bb.y1 - bb.y0);
      under.position.set((bb.x0 + bb.x1) / 2, base - 0.09, (bb.y0 + bb.y1) / 2);
      into.add(under);
      const railMat = b.railing === 'glass' ? M.glass : b.railing === 'solid' ? M.exterior : M.rail;
      for (let i = 0; i < b.polygon.length; i++) {
        const a = b.polygon[i], c = b.polygon[(i + 1) % b.polygon.length];
        const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        const n = [-(c[1] - a[1]), c[0] - a[0]];
        const nl = Math.hypot(n[0], n[1]) || 1;
        // Skip the edge that sits against the outer wall.
        const probe = [mid[0] + (n[0] / nl) * 0.3, mid[1] + (n[1] / nl) * 0.3];
        const probe2 = [mid[0] - (n[0] / nl) * 0.3, mid[1] - (n[1] / nl) * 0.3];
        if (pointInPolygon(...probe, level.outline) || pointInPolygon(...probe2, level.outline)) continue;
        const seg = { x1: a[0], y1: a[1], x2: c[0], y2: c[1] };
        piece(seg, 0, 1, base, base + 1.05, railMat, b.railing === 'metal' ? 0.03 : 0.04);
        piece(seg, 0, 1, base + 1.05, base + 1.09, M.rail, 0.06);
      }
    }

    // Furniture.
    const furn = buildFurnishings(level, { ceiling: ceilY - base });
    into.add(furn);
    mergeStatic(levelGroups[li], li);
    into = group;
  }

  // Everything on a floor you can't click (walls, glass, frames, ceilings, furniture) is merged into
  // one mesh per material, and the floors you can walk on into one per finish: hundreds of draw
  // calls become a few dozen. Elevator floors, balconies, door leaves and rugs stay separate.
  function mergeStatic(lg, li) {
    lg.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(lg.matrixWorld).invert();
    const buckets = new Map();
    const drop = [];
    lg.traverse((o) => {
      if (!o.isMesh || o.userData.elevator || o.userData.balcony || o.userData.door) return;
      const rug = o.parent?.userData?.furnishing === 'rug';
      const floor = walkable.has(o);
      const key = `${o.material.uuid}:${floor ? 'f' : rug ? 'r' : 's'}`;
      let geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((geo.attributes.position.count) * 2), 2));
      geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      if (!buckets.has(key)) buckets.set(key, { material: o.material, floor, rug, geos: [] });
      buckets.get(key).geos.push(geo);
      drop.push(o);
    });
    for (const o of drop) { o.parent.remove(o); o.geometry.dispose(); walkable.delete(o); }
    for (const { material, floor, rug, geos } of buckets.values()) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const m = new THREE.Mesh(merged, material);
      m.userData = { level: li, floor, rug };
      lg.add(m);
      if (floor) walkable.add(m);
    }
  }

  // On a slope (exterior.foundation): what holds the ground floor up on the downhill side, down to
  // the ground, whose height under the building comes from the design's corner heights.
  const fnd = design.exterior?.foundation;
  if (fnd && fnd.dropM >= 0.4 && ['piers', 'stepped', 'walkout'].includes(fnd.type)) {
    const W = design.size.widthM, D = design.size.depthM, [g00, gW0, gWD, g0D] = fnd.groundM;
    const groundAt = (x, y) => { const u = x / W, v = y / D; return (g00 * (1 - u) + gW0 * u) * (1 - v) + (g0D * (1 - u) + gWD * u) * v; };
    const ground = levels.find((l) => l.elevationM >= 0) ?? levels[0];
    const lowest = Math.min(0, ...levels.map((l) => l.elevationM));
    const foot = new THREE.MeshStandardMaterial({ color: 0x9c968c, roughness: 0.95 });
    if (fnd.type === 'piers') {
      const b = bounds(ground.outline);
      const nx = Math.max(2, Math.ceil((b.x1 - b.x0 - 0.6) / 3) + 1), ny = Math.max(2, Math.ceil((b.y1 - b.y0 - 0.6) / 3) + 1);
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const x = b.x0 + 0.3 + ((b.x1 - b.x0 - 0.6) * i) / (nx - 1), y = b.y0 + 0.3 + ((b.y1 - b.y0 - 0.6) * j) / (ny - 1);
          const h = -groundAt(x, y);
          if (h < 0.05 || !pointInPolygon(x, y, ground.outline)) continue;
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.32, h, 0.32), foot);
          m.position.set(x, -h / 2 - 0.02, y);
          group.add(m);
        }
      }
    } else {
      // The footing's outer face: from the lowest floor down to the ground, along the outline.
      const pts = ground.outline, verts = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        const ta = Math.min(lowest, 0), ga = Math.min(ta, groundAt(ax, ay)), gb = Math.min(ta, groundAt(bx, by));
        if (ta - ga < 0.03 && ta - gb < 0.03) continue;
        verts.push(ax, ta, ay, bx, ta, by, bx, gb, by, ax, ta, ay, bx, gb, by, ax, ga, ay);
      }
      if (verts.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.computeVertexNormals();
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9c968c, roughness: 0.95, side: THREE.DoubleSide })));
      }
    }
  }

  // Stairs, each built in its own frame (entered from local low y) and turned to its access side.
  for (const s of design.stairs || []) {
    const from = levels[s.fromLevel], to = levels[s.toLevel];
    if (!from || !to) continue;
    const base = from.elevationM, rise = to.elevationM - base;
    // Local frame: width runs along the access side, depth away from it.
    const across = s.accessSide === 'left' || s.accessSide === 'right';
    const lw = across ? s.depthM : s.widthM, ld = across ? s.widthM : s.depthM;
    const frame = new THREE.Group();
    const place = {
      front: { pos: [s.x, s.y], rot: 0 },
      back: { pos: [s.x + s.widthM, s.y + s.depthM], rot: Math.PI },
      left: { pos: [s.x, s.y + s.depthM], rot: Math.PI / 2 },
      right: { pos: [s.x + s.widthM, s.y], rot: -Math.PI / 2 },
    }[s.accessSide] ?? { pos: [s.x, s.y], rot: 0 };
    frame.position.set(place.pos[0], 0, place.pos[1]);
    frame.rotation.y = place.rot;
    group.add(frame);
    const stair = { id: s.id, level: s.fromLevel, toLevel: s.toLevel, base, rise, rect: rectPoly(s), route: [], frame };
    const step = (x0, x1, z0, z1, h) => {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.05, z1 - z0), M.stair);
      tread.position.set((x0 + x1) / 2, base + h - 0.025, (z0 + z1) / 2);
      tread.userData = { stair, level: s.fromLevel };
      frame.add(tread);
      walkable.add(tread);
      const bh = Math.max(0.02, h - 0.05);
      const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, bh, z1 - z0), M.stairBody);
      body.position.set((x0 + x1) / 2, base + bh / 2, (z0 + z1) / 2);
      body.userData = { stair, level: s.fromLevel };
      frame.add(body);
      walkable.add(body);
    };
    const local = [];
    if (s.shape === 'straight') {
      const n = Math.max(8, Math.round(rise / 0.185));
      const run = ld / n;
      for (let i = 0; i < n; i++) step(0, lw, i * run, (i + 1) * run, (rise / n) * (i + 1));
      local.push([lw / 2, base + EYE, -0.55], [lw / 2, base + rise + EYE, ld + 0.55]);
    } else {
      const half = lw / 2;
      const landingD = Math.min(1.1, ld * 0.34);
      const perFlight = Math.max(6, Math.round(rise / 2 / 0.185));
      const run = (ld - landingD) / perFlight;
      const stepH = rise / (perFlight * 2);
      for (let i = 0; i < perFlight; i++) step(0, half, i * run, (i + 1) * run, stepH * (i + 1));
      step(0, lw, ld - landingD, ld, rise / 2);
      for (let i = 0; i < perFlight; i++) {
        const z1 = ld - landingD - i * run, z0 = z1 - run;
        step(half, lw, z0, z1, rise / 2 + stepH * (i + 1));
      }
      const div = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, ld - landingD), M.rail);
      div.position.set(half, base + rise / 2, (ld - landingD) / 2);
      frame.add(div);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(half, 0.05, 0.05), M.rail);
      rail.position.set(half / 2, base + rise + 0.95, 0);
      frame.add(rail);
      local.push(
        [half / 2, base + EYE, -0.55],
        [half / 2, base + rise / 2 + EYE, ld - landingD / 2],
        [half * 1.5, base + rise / 2 + EYE, ld - landingD / 2],
        [half * 1.5, base + rise + EYE, -0.55],
      );
    }
    frame.updateMatrixWorld(true);
    stair.route = local.map(([x, y, z]) => frame.localToWorld(new THREE.Vector3(x, y, z)));
    stairs.push(stair);
  }
  function showAround(li) {
    for (let k = li - 1; k <= li + 1; k++) if (levels[k] && !built.has(k)) { built.add(k); buildLevel(k); }
    levelGroups.forEach((g, k) => { g.visible = Math.abs(k - li) <= 1; });
    for (const s of stairs) s.frame.visible = Math.abs(s.level - li) <= 1 || Math.abs(s.toLevel - li) <= 1;
  }
  return { group, walkable, stairs, showAround };
}

function levelAtHeight(design, y) {
  let li = 0;
  design.levels.forEach((l, i) => { if (y - EYE >= l.elevationM - 0.3) li = i; });
  return li;
}

// Where to stand at the start: a house starts in its living room; a bigger building in the room
// its main entrance opens into.
function startSpot(design) {
  const g = design.levels.find((l) => l.elevationM === 0) ?? design.levels[0];
  let room = null;
  if (design.housingType === 'house' || design.housingType === 'tiny-home') {
    const living = g.rooms.filter((r) => ['living', 'family'].includes(r.type));
    room = (living.length ? living : g.rooms).reduce((a, b) => (b.areaM2 > a.areaM2 ? b : a));
  } else {
    const entry = (g.openings || []).find((o) => o.kind === 'entry' && (o.connects || []).includes('outside'));
    const id = entry?.connects.find((c) => c !== 'outside');
    room = g.rooms.find((r) => r.id === id) ?? g.rooms.reduce((a, b) => (b.areaM2 > a.areaM2 ? b : a));
  }
  // Stand where there's most room: the point in the room farthest from furniture and walls.
  const furn = (g.furnishings || []).filter((f) => f.type !== 'rug' && f.type !== 'pendant');
  const rb = bounds(room.polygon);
  const edgeDist = (x, y) => {
    let m = Infinity;
    for (let i = 0; i < room.polygon.length; i++) {
      const [ax, ay] = room.polygon[i], [bx, by] = room.polygon[(i + 1) % room.polygon.length];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      m = Math.min(m, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return m;
  };
  let best = { s: -Infinity, x: centroid(room.polygon)[0], y: centroid(room.polygon)[1] };
  for (let x = rb.x0 + 0.3; x < rb.x1; x += 0.25) {
    for (let y = rb.y0 + 0.3; y < rb.y1; y += 0.25) {
      if (!pointInPolygon(x, y, room.polygon)) continue;
      let s = edgeDist(x, y);
      for (const f of furn) {
        const r = Math.max(f.w, f.d) / 2 + 0.2;
        s = Math.min(s, Math.hypot(x - f.x, y - f.y) - r);
      }
      if (s > best.s) best = { s, x, y };
    }
  }
  // Look across the room toward its middle, or toward the building's middle from the middle.
  const [cx, cy] = centroid(room.polygon);
  const look = Math.hypot(cx - best.x, cy - best.y) > 0.8 ? [cx, cy] : centroid(g.outline);
  const yaw = Math.atan2(-(look[0] - best.x), -(look[1] - best.y));
  return { level: design.levels.indexOf(g), x: best.x, z: best.y, yaw };
}

// `map` and `placement` (where the building stands) let the view outside show the real surroundings.
export function openWalkthrough(host, design, { map = null, placement = null } = {}) {
  design = renderable(design); // curved edges as short straight pieces
  host.hidden = false;
  const title = design.overview?.title ?? 'Walkthrough';
  host.innerHTML = `
    <canvas class="walk-canvas" tabindex="0" aria-label="Walkthrough of ${title}"></canvas>
    <div class="walk-top">
      <div><h2 class="walk-title">${title}</h2><p class="walk-room" aria-live="polite"></p></div>
      <div class="walk-tools">
        <button type="button" class="btn" data-exit>${icon('close')}<span>Back to the map</span></button>
      </div>
    </div>
    <div class="walk-lift" hidden role="group" aria-label="Elevator"></div>
    <div class="walk-lift walk-stairs" hidden role="group" aria-label="Stairs"></div>
    <div class="walk-start">
      <p class="walk-start-title">Look around inside</p>
      <p>Drag to look. Click a spot on the floor to move there. Click the stairs, or a floor seen up the stairwell, to change floors.${(design.elevators || []).length ? ' Step into the elevator to pick a floor.' : ''}</p>
      <button type="button" class="btn btn-primary" data-begin>Start</button>
    </div>
    ${design.sample ? '<p class="walk-note">Sample house</p>' : ''}`;

  const canvas = host.querySelector('canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    host.querySelector('.walk-start').innerHTML = `<p class="walk-start-title">The walkthrough can’t start here</p>
      <p>It needs WebGL (3D graphics), which this browser has turned off. Turn on hardware acceleration in the browser’s settings and reload, or look at the floor plans instead.</p>
      <button type="button" class="btn btn-primary" data-plans>See the floor plans</button>`;
    // Nothing else was set up, so closing only hides the walkthrough.
    const leave = () => { host.hidden = true; host.replaceChildren(); };
    host.querySelector('[data-plans]').addEventListener('click', () => { leave(); document.querySelector('#panel [data-tab="plans"]')?.click(); });
    host.querySelector('[data-exit]').addEventListener('click', leave);
    return;
  }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb7cde3);
  // The fog closes in where the real ground ends (surroundings.js draws 180 m round the building).
  scene.fog = new THREE.Fog(0xb7cde3, 45, 175);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfc0, 1.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff3e0, 1.3);
  sun.position.set(-8, 14, -12);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x7a7866, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const { group, walkable, stairs, showAround } = buildBuilding(design);
  // Building metres are right-handed (x and y on the ground, height up). Putting y on three.js's Z
  // alone would show the building mirrored, so the world group flips Z back: inside matches the map
  // and the plans. Positions below (`pos`, stair routes, paths) stay in building metres; only the
  // camera, the click ring and raycast hits are in three.js space.
  const world = new THREE.Group();
  world.scale.z = -1;
  world.add(group);
  scene.add(world);
  const toBuilding = (v) => new THREE.Vector3(v.x, v.y, -v.z);

  // The real ground and neighbours outside, once they load; the walkthrough works without them.
  const outside = new AbortController();
  let surroundings = null;
  if (map && placement) {
    buildSurroundings({ map, placement, W: design.size.widthM, D: design.size.depthM, foundation: design.exterior?.foundation, signal: outside.signal })
      .then((s) => {
        if (outside.signal.aborted) return;
        surroundings = s;
        world.add(s);
        // The far ground sits just under the real ground's edge, past the fog.
        ground.position.y = s.userData.edgeHeight - 0.6;
        host.__walk.surroundings = s.userData;
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        console.warn('[TerraSim] The view outside could not load:', e);
        const note = document.createElement('p');
        note.className = 'walk-note walk-note-outside';
        note.textContent = 'The view outside couldn’t load, so plain ground shows. The rooms are exact.';
        host.append(note);
      });
  }

  // 58° tall is about what eyes see; wider stretches rooms like a wide-angle lens, so they feel too big.
  const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';
  const pos = new THREE.Vector3(); // where you stand, in building metres (x, height, y)
  let yaw = 0, pitch = -0.05;      // yaw is in three.js space, so dragging and keys turn the way they look
  {
    const s = startSpot(design);
    pos.set(s.x, design.levels[s.level].elevationM + EYE, s.z);
    showAround(s.level);
    yaw = Math.PI - s.yaw; // startSpot faces along building metres; the world flips Z
  }

  // Look: drag with mouse, finger or pen. Click without dragging: move.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw, pitch, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    updateCursor(e);
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    const k = (camera.fov * Math.PI / 180) / canvas.clientHeight;
    // Grab the view, as in Street View: drag right and the room follows the pointer (you turn left);
    // drag down and you look up.
    yaw = drag.yaw + dx * k;
    pitch = Math.max(-1.35, Math.min(1.35, drag.pitch + dy * k));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) moveTo(e);
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.fov = Math.max(35, Math.min(75, camera.fov + Math.sign(e.deltaY) * 4));
    camera.updateProjectionMatrix();
  }, { passive: false });
  const onKey = (e) => {
    const step = 0.08;
    if (e.key === 'ArrowLeft') yaw += step;
    else if (e.key === 'ArrowRight') yaw -= step;
    else if (e.key === 'ArrowUp') pitch = Math.min(1.35, pitch + step);
    else if (e.key === 'ArrowDown') pitch = Math.max(-1.35, pitch - step);
    else if (e.key === 'Escape') { close(); return; }
    else return;
    e.preventDefault();
  };
  addEventListener('keydown', onKey);

  // Where a click lands: the first thing it hits; only floors and steps can be moved to.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(group.children, true);
    // Rugs lie on the floor: a click on one goes to the floor under it. Hidden floors don't count.
    const onRug = (o) => o.userData.rug || o.parent?.userData?.furnishing === 'rug';
    const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    const hit = hits.find((h) => !h.object.material?.transparent && !onRug(h.object) && shown(h.object));
    if (!hit || !walkable.has(hit.object) || hit.distance > 22) return null;
    return hit;
  };

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 10;
  ring.visible = false;
  scene.add(ring);
  function updateCursor(e) {
    if (drag?.moved) { ring.visible = false; return; }
    const hit = pick(e);
    ring.visible = !!hit;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (hit) ring.position.set(hit.point.x, hit.point.y + 0.01, hit.point.z);
  }

  // Gliding along a path of points.
  let travel = null;
  function glide(path) {
    const lengths = [0];
    for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + path[i].distanceTo(path[i - 1]));
    const total = lengths[lengths.length - 1];
    travel = { path, lengths, total, start: performance.now(), duration: Math.min(4200, 450 + total * 240) };
  }

  // The stair between two neighbouring levels nearest to a point.
  const nearestStair = (lo, p) => stairs.filter((s) => s.level === lo).sort((a, b) => a.route[0].distanceTo(p) - b.route[0].distanceTo(p))[0];

  function moveTo(e) {
    const hit = pick(e);
    if (!hit) return;
    const at = toBuilding(hit.point);
    const back = new THREE.Vector3(pos.x - at.x, 0, pos.z - at.z);
    const pull = Math.min(0.45, back.length() * 0.3);
    if (back.lengthSq() > 0) back.normalize().multiplyScalar(pull);
    let target = new THREE.Vector3(at.x + back.x, at.y + EYE, at.z + back.z);
    const stair = hit.object.userData.stair;
    const from = pos.clone();
    const path = [from];
    if (stair) {
      // Clicking the stairs takes you to the far end: up if you're below, down if you're above.
      const goingUp = from.y - EYE < stair.base + stair.rise / 2;
      const way = goingUp ? stair.route : stair.route.slice().reverse();
      path.push(...way.slice(0, -1));
      target = way[way.length - 1];
    } else {
      // A floor seen up or down the stairwell: go there by the stairs, a flight at a time.
      path.push(...stairPath(from, hit.object.userData.level).slice(1));
    }
    path.push(target);
    glide(path);
  }

  // The way by the stairs from a point to another level, a flight at a time: points to glide through.
  function stairPath(from, toLevel) {
    const path = [from.clone()];
    let at = levelAtHeight(design, from.y);
    while (at !== toLevel) {
      const up = toLevel > at;
      const s = nearestStair(up ? at : at - 1, path[path.length - 1]);
      if (!s) break;
      path.push(...(up ? s.route : s.route.slice().reverse()));
      at += up ? 1 : -1;
    }
    return path;
  }

  // The stairs: standing at the foot or head of a stair (or on it), a panel offers the floors the
  // stairs reach from here, like the elevator's.
  const stairsBox = host.querySelector('.walk-stairs');
  let stairsShown = null;
  function stairNear(li) {
    const p = pos;
    return stairs.find((s) => (s.level === li && s.route[0].distanceTo(p) < 2.4) || (s.toLevel === li && s.route[s.route.length - 1].distanceTo(p) < 2.4)
      || ((s.level === li || s.toLevel === li) && pointInPolygon(p.x, p.z, s.rect)));
  }
  function showStairs(near, li) {
    if (!near) { if (stairsShown !== null) { stairsShown = null; stairsBox.hidden = true; } return; }
    // Every floor joined to this one by stairs, highest first.
    const reach = new Set([li]);
    for (let at = li; stairs.some((s) => s.level === at); at++) reach.add(at + 1);
    for (let at = li; stairs.some((s) => s.toLevel === at); at--) reach.add(at - 1);
    const key = `${li}:${[...reach].join(',')}`;
    if (stairsShown === key) return;
    stairsShown = key;
    if (reach.size < 2) { stairsBox.hidden = true; return; }
    stairsBox.hidden = false;
    stairsBox.innerHTML = `<span class="walk-lift-label">Stairs</span>${[...reach].sort((a, b) => b - a).map((l) => `<button type="button" class="btn btn-small" data-stairs="${l}" aria-pressed="${l === li}" title="${l === li ? 'You’re here' : l > li ? `Up to ${design.levels[l].name}` : `Down to ${design.levels[l].name}`}">${shortLevel(design.levels[l], l)}</button>`).join('')}`;
  }
  stairsBox.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-stairs]');
    if (!b) return;
    const to = Number(b.dataset.stairs);
    if (to === levelAtHeight(design, pos.y)) return;
    glide(stairPath(pos, to));
    stairsShown = null;
  });

  // The elevator: inside a cab, a panel offers the floors it serves.
  const lift = host.querySelector('.walk-lift');
  let liftShown = null;
  function showLift(e, li) {
    const key = `${e?.id}:${li}`;
    if (liftShown === key) return;
    liftShown = key;
    if (!e) { lift.hidden = true; return; }
    lift.hidden = false;
    lift.innerHTML = `<span class="walk-lift-label">Elevator</span>${e.levels.map((l) => `<button type="button" class="btn btn-small" data-lift="${l}" aria-pressed="${l === li}">${shortLevel(design.levels[l], l)}</button>`).join('')}`;
  }
  lift.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lift]');
    if (!b) return;
    const to = design.levels[Number(b.dataset.lift)];
    const p = pos.clone();
    glide([p, new THREE.Vector3(p.x, to.elevationM + EYE, p.z)]);
    liftShown = null;
  });

  const roomLabel = host.querySelector('.walk-room');
  const start = host.querySelector('.walk-start');
  host.querySelector('[data-begin]').addEventListener('click', () => { start.classList.add('is-hidden'); canvas.focus(); });
  host.querySelector('[data-exit]').addEventListener('click', close);
  const unitName = new Map((design.units || []).map((u) => [u.id, u.name]));

  // For automated checks: stand somewhere (building metres: x, eye height, y) and look (three.js yaw).
  host.__walk = {
    pose(x, y, z, yawDeg = 0, pitchDeg = 0) { travel = null; pos.set(x, y, z); yaw = (yawDeg * Math.PI) / 180; pitch = (pitchDeg * Math.PI) / 180; },
    surroundings: null,
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    stairs: () => stairs.map((st) => ({ level: st.level, toLevel: st.toLevel, foot: st.route[0].toArray() })),
    shownFloors: () => group.children.filter((g) => g.userData.level != null && g.visible).map((g) => g.userData.level),
  };

  let raf = 0;
  let shownLevel = -1;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const w = host.clientWidth, h = host.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (travel) {
      const t = reduced ? 1 : Math.min(1, (now - travel.start) / travel.duration);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const d = ease * travel.total;
      let i = 1;
      while (i < travel.lengths.length - 1 && travel.lengths[i] < d) i++;
      const seg = travel.lengths[i] - travel.lengths[i - 1] || 1;
      pos.lerpVectors(travel.path[i - 1], travel.path[i], (d - travel.lengths[i - 1]) / seg);
      if (t >= 1) travel = null;
    }
    camera.position.set(pos.x, pos.y, -pos.z);
    camera.rotation.set(pitch, yaw, 0);
    const li = levelAtHeight(design, pos.y);
    if (li !== shownLevel) { shownLevel = li; showAround(li); }
    const lvl = design.levels[li];
    const x = pos.x, z = pos.z;
    const r = roomAt(lvl, x, z);
    const onStairs = stairs.some((s) => (s.level === li || s.toLevel === li) && pointInPolygon(x, z, s.rect) && Math.abs(pos.y - EYE - lvl.elevationM) > 0.2);
    const balcony = (lvl.balconies || []).find((b) => pointInPolygon(x, z, b.polygon));
    const where = onStairs ? 'Stairs' : balcony ? 'Balcony' : r ? r.name : 'Outside';
    const home = (balcony?.unitId ?? r?.unitId) && design.units?.length > 1 ? unitName.get(balcony?.unitId ?? r?.unitId) : null;
    const label = [where, home, lvl.name].filter(Boolean).join(' · ');
    if (roomLabel.textContent !== label) roomLabel.textContent = label;
    const cab = !travel && (design.elevators || []).find((e) => e.levels.includes(li) && pointInPolygon(x, z, rectPoly(e)));
    showLift(cab, li);
    showStairs(!travel && !cab ? stairNear(li) : null, li);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  function close() {
    outside.abort();
    surroundings?.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey);
    group.traverse((o) => o.geometry?.dispose());
    renderer?.dispose();
    host.hidden = true;
    host.replaceChildren();
  }
}

function shortLevel(level, i) {
  if (/ground/i.test(level.name)) return 'G';
  if (/basement/i.test(level.name)) return 'B';
  const n = level.name.match(/\d+/);
  return n ? n[0] : String(i);
}
