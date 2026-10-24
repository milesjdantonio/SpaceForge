// Walkthrough: the whole building drawn from its terrasim.design/2 file, every level at its real
// height. The file lists every wall, opening, stair, elevator, balcony and piece of furniture, and
// this draws exactly those. Look around by dragging; click a spot on the floor (or a step, or a floor
// seen up the stairwell) to glide there, the way Street View moves. Inside an elevator, pick a floor.
// Building metres map to three.js as x -> X, y -> Z, height -> Y.

import * as THREE from 'three';
import { icon } from '../ui/icons.js';
import { buildFurnishings } from './furniture.js';
import { openingSegment, wallLength, rectPoly, bounds, centroid, pointInPolygon, roomAt } from '../lib/design.js';

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

// Builds the whole building. Returns the group, the surfaces you can click to move to, and the stairs.
function buildBuilding(design) {
  const M = materials(design);
  const group = new THREE.Group();
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
    group.add(mesh);
    if (walk) walkable.add(mesh);
    return mesh;
  };

  // A slab of a wall between two points along it (t0..t1), from height y0 to y1.
  const piece = (w, t0, t1, y0, y1, mat, thick) => {
    const ax = w.x1 + (w.x2 - w.x1) * t0, az = w.y1 + (w.y2 - w.y1) * t0;
    const bx = w.x1 + (w.x2 - w.x1) * t1, bz = w.y1 + (w.y2 - w.y1) * t1;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02 || y1 - y0 < 0.02) return null;
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, thick), mat);
    m.position.set((ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2);
    m.rotation.y = -Math.atan2(bz - az, bx - ax);
    group.add(m);
    return m;
  };

  levels.forEach((level, li) => {
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
          if (o.kind === 'entry' || o.kind === 'garage') {
            const leaf = piece(w, t0 + 0.02 / len, t1 - 0.02 / len, base, head - 0.02, o.kind === 'garage' ? M.exterior : M.door, 0.05);
            if (leaf) leaf.userData.door = true;
          }
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
      group.add(under);
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
    group.add(furn);
  });

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
    const stair = { id: s.id, level: s.fromLevel, toLevel: s.toLevel, base, rise, rect: rectPoly(s), route: [] };
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
  return { group, walkable, stairs };
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

export function openWalkthrough(host, design) {
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
    host.querySelector('.walk-start').innerHTML = '<p class="walk-start-title">The walkthrough needs WebGL, which this browser has turned off.</p>';
    host.querySelector('[data-exit]').addEventListener('click', close);
    return;
  }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb7cde3);
  scene.fog = new THREE.Fog(0xb7cde3, 40, 160);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfc0, 1.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff3e0, 1.3);
  sun.position.set(-8, 14, -12);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x77925a, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const { group, walkable, stairs } = buildBuilding(design);
  scene.add(group);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';
  let yaw = 0, pitch = -0.05;
  {
    const s = startSpot(design);
    camera.position.set(s.x, design.levels[s.level].elevationM + EYE, s.z);
    yaw = s.yaw;
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
    yaw = drag.yaw + dx * k;
    pitch = Math.max(-1.35, Math.min(1.35, drag.pitch + dy * k));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) moveTo(e);
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.fov = Math.max(35, Math.min(90, camera.fov + Math.sign(e.deltaY) * 4));
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
    const hit = hits.find((h) => !h.object.material?.transparent);
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
    const back = new THREE.Vector3(camera.position.x - hit.point.x, 0, camera.position.z - hit.point.z);
    const pull = Math.min(0.45, back.length() * 0.3);
    if (back.lengthSq() > 0) back.normalize().multiplyScalar(pull);
    let target = new THREE.Vector3(hit.point.x + back.x, hit.point.y + EYE, hit.point.z + back.z);
    const stair = hit.object.userData.stair;
    const from = camera.position.clone();
    const path = [from];
    if (stair) {
      // Clicking the stairs takes you to the far end: up if you're below, down if you're above.
      const goingUp = from.y - EYE < stair.base + stair.rise / 2;
      const way = goingUp ? stair.route : stair.route.slice().reverse();
      path.push(...way.slice(0, -1));
      target = way[way.length - 1];
    } else {
      // A floor seen up or down the stairwell: go there by the stairs, a flight at a time.
      let at = levelAtHeight(design, from.y);
      const toLevel = hit.object.userData.level;
      while (at !== toLevel) {
        const up = toLevel > at;
        const s = nearestStair(up ? at : at - 1, path[path.length - 1]);
        if (!s) break;
        path.push(...(up ? s.route : s.route.slice().reverse()));
        at += up ? 1 : -1;
      }
    }
    path.push(target);
    glide(path);
  }

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
    const p = camera.position.clone();
    glide([p, new THREE.Vector3(p.x, to.elevationM + EYE, p.z)]);
    liftShown = null;
  });

  const roomLabel = host.querySelector('.walk-room');
  const start = host.querySelector('.walk-start');
  host.querySelector('[data-begin]').addEventListener('click', () => { start.classList.add('is-hidden'); canvas.focus(); });
  host.querySelector('[data-exit]').addEventListener('click', close);
  const unitName = new Map((design.units || []).map((u) => [u.id, u.name]));

  // For automated checks: put the camera somewhere and point it.
  host.__walk = {
    pose(x, y, z, yawDeg = 0, pitchDeg = 0) { travel = null; camera.position.set(x, y, z); yaw = (yawDeg * Math.PI) / 180; pitch = (pitchDeg * Math.PI) / 180; },
  };

  let raf = 0;
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
      camera.position.lerpVectors(travel.path[i - 1], travel.path[i], (d - travel.lengths[i - 1]) / seg);
      if (t >= 1) travel = null;
    }
    camera.rotation.set(pitch, yaw, 0);
    const li = levelAtHeight(design, camera.position.y);
    const lvl = design.levels[li];
    const x = camera.position.x, z = camera.position.z;
    const r = roomAt(lvl, x, z);
    const onStairs = stairs.some((s) => (s.level === li || s.toLevel === li) && pointInPolygon(x, z, s.rect) && Math.abs(camera.position.y - EYE - lvl.elevationM) > 0.2);
    const balcony = (lvl.balconies || []).find((b) => pointInPolygon(x, z, b.polygon));
    const where = onStairs ? 'Stairs' : balcony ? 'Balcony' : r ? r.name : 'Outside';
    const home = (balcony?.unitId ?? r?.unitId) && design.units?.length > 1 ? unitName.get(balcony?.unitId ?? r?.unitId) : null;
    const label = [where, home, lvl.name].filter(Boolean).join(' · ');
    if (roomLabel.textContent !== label) roomLabel.textContent = label;
    const cab = !travel && (design.elevators || []).find((e) => e.levels.includes(li) && pointInPolygon(x, z, rectPoly(e)));
    showLift(cab, li);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  function close() {
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey);
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
