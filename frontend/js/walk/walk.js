// Walkthrough: the whole house built from its floor-plan data, every floor at its real height with
// working stairs between them. Look around by dragging; click a spot on the floor (or a step, or a
// floor seen up the stairwell) to glide there, the way Street View moves.
// House metres map to three.js as x -> X, y -> Z, height -> Y.

import * as THREE from 'three';
import { icon } from '../ui/icons.js';

const EYE = 1.6;
const DOOR_H = 2.1;
const SLAB = 0.22;

function key(p) { return `${p[0].toFixed(2)},${p[1].toFixed(2)}`; }

// Unique wall segments of a level from its room outlines, split wherever another room's corner
// lies on them so shared walls are drawn once.
function wallSegments(level) {
  const seen = new Map();
  for (const r of level.rooms) {
    const poly = r.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const k = [key(a), key(b)].sort().join('|');
      if (!seen.has(k)) seen.set(k, { a, b });
    }
  }
  const pts = [...new Set(level.rooms.flatMap((r) => r.polygon.map(key)))].map((s) => s.split(',').map(Number));
  const out = new Map();
  for (const { a, b } of seen.values()) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const ts = [0, 1];
    for (const p of pts) {
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
      if (t <= 0.001 || t >= 0.999) continue;
      if (Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < 0.03) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let i = 0; i < ts.length - 1; i++) {
      const s = [a[0] + dx * ts[i], a[1] + dy * ts[i]], e = [a[0] + dx * ts[i + 1], a[1] + dy * ts[i + 1]];
      out.set([key(s), key(e)].sort().join('|'), { a: s, b: e });
    }
  }
  return [...out.values()];
}

function distToLine(p, seg) {
  const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
  const len2 = dx * dx + dy * dy;
  const t = ((p[0] - seg.a[0]) * dx + (p[1] - seg.a[1]) * dy) / len2;
  if (t < -0.02 || t > 1.02) return Infinity;
  return Math.hypot(p[0] - (seg.a[0] + t * dx), p[1] - (seg.a[1] + t * dy));
}

// Openings lying along a wall, as [lo, hi] ranges of the wall with their opening.
function openingsOn(seg, openings) {
  const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
  const len2 = dx * dx + dy * dy;
  const list = [];
  for (const o of openings) {
    if (distToLine([o.x1, o.y1], seg) > 0.12 || distToLine([o.x2, o.y2], seg) > 0.12) continue;
    const t1 = ((o.x1 - seg.a[0]) * dx + (o.y1 - seg.a[1]) * dy) / len2;
    const t2 = ((o.x2 - seg.a[0]) * dx + (o.y2 - seg.a[1]) * dy) / len2;
    const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(1, Math.max(t1, t2));
    if (hi - lo > 0.01) list.push({ lo, hi, o });
  }
  return list.sort((x, y) => x.lo - y.lo);
}

const bounds = (poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
  }
  return inside;
}

const OPEN = new Set(['living', 'kitchen', 'dining', 'family']);

// The rooms on either side of a wall segment: probes a point just off its midpoint each way.
function sidesOf(seg, rooms) {
  const mx = (seg.a[0] + seg.b[0]) / 2, my = (seg.a[1] + seg.b[1]) / 2;
  const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * 0.2, ny = dx / len * 0.2;
  const at = (x, y) => rooms.find((r) => inPoly(x, y, r.polygon)) ?? null;
  return [at(mx + nx, my + ny), at(mx - nx, my - ny)];
}

function materials() {
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide, ...extra });
  return {
    wall: std(0xf1ece4),
    ext: std(0xe8e2d7),
    floor: std(0xb48c63, { roughness: 0.65 }),
    wet: std(0xd5d8da, { roughness: 0.45 }),
    ceil: std(0xfbf9f5, { roughness: 1 }),
    stair: std(0xa47b55, { roughness: 0.6 }),
    rail: std(0x2c3035, { roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xcfe2f2, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.18, side: THREE.DoubleSide }),
    frame: std(0x2b2f33, { roughness: 0.6 }),
    door: std(0x8a6a4a, { roughness: 0.7 }),
  };
}

// Builds the whole house. Returns the group, the surfaces you can click to move to, and the stairs.
function buildHouse(design) {
  const M = materials();
  const group = new THREE.Group();
  const walkable = [];
  const W = design.size.widthM, D = design.size.depthM;
  const stairs = [];

  const flat = (poly, y, mat, { walk = false, level = 0, holes = [] } = {}) => {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, z)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z))));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.userData = { level, floor: walk };
    group.add(mesh);
    if (walk) walkable.push(mesh);
    return mesh;
  };

  const piece = (seg, t0, t1, y0, y1, mat, thick) => {
    const ax = seg.a[0] + (seg.b[0] - seg.a[0]) * t0, az = seg.a[1] + (seg.b[1] - seg.a[1]) * t0;
    const bx = seg.a[0] + (seg.b[0] - seg.a[0]) * t1, bz = seg.a[1] + (seg.b[1] - seg.a[1]) * t1;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02 || y1 - y0 < 0.02) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, thick), mat);
    m.position.set((ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2);
    m.rotation.y = -Math.atan2(bz - az, bx - ax);
    group.add(m);
  };

  design.levels.forEach((level, li) => {
    const base = level.elevationM;
    const H = level.heightM;
    const top = base + H - (li < design.levels.length - 1 ? SLAB : 0.05);
    const upper = design.levels[li + 1];
    // The floor covers the whole footprint (halls included) except the stairwell coming up from
    // below; the ceiling covers it except the stairwell going up. Wet rooms get their own finish.
    const footprint = [[0, 0], [W, 0], [W, D], [0, D]];
    const below = design.levels[li - 1];
    const wellBelow = (below?.stairs || []).filter((st) => st.direction !== 'down').map((st) => st.polygon);
    const wellAbove = upper ? (level.stairs || []).filter((st) => st.direction !== 'down').map((st) => st.polygon) : [];
    flat(footprint, base + 0.001, M.floor, { walk: true, level: li, holes: wellBelow });
    flat(footprint, top, M.ceil, { level: li, holes: wellAbove });
    for (const r of level.rooms) {
      if (/bath|powder|laundry|mudroom/.test(r.type)) flat(r.polygon, base + 0.004, M.wet, { walk: true, level: li });
    }
    // Walls with doors and windows cut out.
    for (const seg of wallSegments(level)) {
      const onEdge = (p) => Math.abs(p[0]) < 0.05 || Math.abs(p[0] - W) < 0.05 || Math.abs(p[1]) < 0.05 || Math.abs(p[1] - D) < 0.05;
      const sameEdge = Math.abs(seg.a[0] - seg.b[0]) < 0.05
        ? (Math.abs(seg.a[0]) < 0.05 || Math.abs(seg.a[0] - W) < 0.05)
        : (Math.abs(seg.a[1]) < 0.05 || Math.abs(seg.a[1] - D) < 0.05);
      const exterior = onEdge(seg.a) && onEdge(seg.b) && sameEdge;
      const thick = exterior ? 0.3 : 0.12;
      const mat = exterior ? M.ext : M.wall;
      const y0 = base, y1 = top;
      // Open-plan rooms flow into each other (no wall) and into the hall through a wide opening.
      const [sa, sb] = exterior ? [null, null] : sidesOf(seg, level.rooms);
      const openA = sa && OPEN.has(sa.type), openB = sb && OPEN.has(sb.type);
      if (openA && openB) continue;
      const ops = openingsOn(seg, level.openings || []);
      if (!exterior && !ops.length && ((openA && !sb) || (openB && !sa))) {
        const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
        const gap = Math.min(len - 0.4, Math.max(1.2, len * 0.6)) / len;
        const lo = 0.5 - gap / 2, hi = 0.5 + gap / 2;
        piece(seg, 0, lo, y0, y1, mat, thick);
        piece(seg, hi, 1, y0, y1, mat, thick);
        piece(seg, lo, hi, base + 2.3, y1, mat, thick);
        continue;
      }
      let t = 0;
      for (const { lo, hi, o } of ops) {
        if (lo > t) piece(seg, t, lo, y0, y1, mat, thick);
        if (o.kind === 'window') {
          const sill = base + (o.sillM ?? 0.8), head = base + (o.headM ?? 2.2);
          piece(seg, lo, hi, y0, sill, mat, thick);
          piece(seg, lo, hi, head, y1, mat, thick);
          piece(seg, lo, hi, sill, head, M.glass, 0.03);
          piece(seg, lo, hi, sill - 0.04, sill, M.frame, thick + 0.05);
        } else {
          piece(seg, lo, hi, base + DOOR_H, y1, mat, thick);
          if (o.kind === 'patio') piece(seg, lo, hi, base, base + DOOR_H, M.glass, 0.03);
          if (o.kind === 'entry' || o.kind === 'garage') piece(seg, lo, lo + (hi - lo) * 0.92, base, base + DOOR_H, M.door, 0.05);
        }
        t = Math.max(t, hi);
      }
      if (t < 1) piece(seg, t, 1, y0, y1, mat, thick);
    }
    // Stairs rising from this floor to the next: a switchback inside their outline. The first
    // flight climbs from the hall side, a half landing turns, the second flight arrives back on the
    // hall side of the floor above.
    for (const st of level.stairs || []) {
      if (!upper || st.direction === 'down') continue;
      const b = bounds(st.polygon);
      const rise = upper.elevationM - base;
      const half = (b.x1 - b.x0) / 2;
      const landingD = Math.min(1.1, (b.y1 - b.y0) * 0.34);
      const perFlight = Math.max(6, Math.round(rise / 2 / 0.185));
      const run = (b.y1 - b.y0 - landingD) / perFlight;
      const stepH = rise / (perFlight * 2);
      const stair = { level: li, b, base, rise, half, landingD, run };
      const step = (x0, x1, z0, z1, h) => {
        const tread = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.05, z1 - z0), M.stair);
        tread.position.set((x0 + x1) / 2, base + h - 0.025, (z0 + z1) / 2);
        tread.userData = { stair, level: li };
        group.add(tread);
        walkable.push(tread);
        const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, Math.max(0.02, h - 0.05), z1 - z0), M.wall);
        body.position.set((x0 + x1) / 2, base + Math.max(0.02, h - 0.05) / 2, (z0 + z1) / 2);
        body.userData = { stair, level: li };
        group.add(body);
        walkable.push(body);
      };
      for (let i = 0; i < perFlight; i++) {
        // Flight one: left half, climbing toward the landing.
        step(b.x0, b.x0 + half, b.y0 + i * run, b.y0 + (i + 1) * run, stepH * (i + 1));
      }
      step(b.x0, b.x1, b.y1 - landingD, b.y1, rise / 2);
      for (let i = 0; i < perFlight; i++) {
        // Flight two: right half, climbing back toward the hall.
        const z1 = b.y1 - landingD - i * run, z0 = z1 - run;
        step(b.x0 + half, b.x1, z0, z1, rise / 2 + stepH * (i + 1));
      }
      // A divider between the flights and a rail along the top opening.
      const div = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, b.y1 - b.y0 - landingD), M.rail);
      div.userData = { stair, level: li };
      walkable.push(div);
      div.position.set(b.x0 + half, base + rise / 2, b.y0 + (b.y1 - b.y0 - landingD) / 2);
      group.add(div);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(half, 0.05, 0.05), M.rail);
      rail.position.set(b.x0 + half / 2, base + rise + 0.95, b.y0);
      group.add(rail);
      stairs.push(stair);
    }
  });
  return { group, walkable, stairs };
}

function levelAtHeight(design, y) {
  let li = 0;
  design.levels.forEach((l, i) => { if (y - EYE >= l.elevationM - 0.3) li = i; });
  return li;
}

export function openWalkthrough(host, design) {
  host.hidden = false;
  host.innerHTML = `
    <canvas class="walk-canvas" tabindex="0" aria-label="Walkthrough of ${design.title}"></canvas>
    <div class="walk-top">
      <div><h2 class="walk-title">${design.title}</h2><p class="walk-room" aria-live="polite"></p></div>
      <div class="walk-tools">
        <button type="button" class="btn" data-exit>${icon('close')}<span>Back to the map</span></button>
      </div>
    </div>
    <div class="walk-start">
      <p class="walk-start-title">Look around the house</p>
      <p>Drag to look. Click a spot on the floor to move there. Click the stairs, or the floor at the top of them, to go up or down.</p>
      <button type="button" class="btn btn-primary" data-begin>Start</button>
    </div>
    <p class="walk-note">${design.sample ? 'Sample house. ' : ''}Furniture and finishes are not part of the design data yet.</p>`;

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
  scene.fog = new THREE.Fog(0xb7cde3, 40, 140);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfc0, 1.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff3e0, 1.3);
  sun.position.set(-8, 14, -12);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x77925a, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const { group, walkable, stairs } = buildHouse(design);
  scene.add(group);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
  camera.rotation.order = 'YXZ';
  let yaw = 0, pitch = -0.05;

  // Start in the biggest ground-floor room, at its back, looking across it to the front.
  {
    const rooms = design.levels[0].rooms;
    const r = rooms.reduce((a, b) => (b.areaM2 > a.areaM2 ? b : a), rooms[0]);
    const b = bounds(r.polygon);
    camera.position.set((b.x0 + b.x1) / 2, EYE, b.y1 - Math.min(0.9, (b.y1 - b.y0) * 0.25));
    yaw = 0; // the camera looks along -Z, toward the front (y = 0)
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

  // Where a click lands.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // Anything solid blocks the click; only floors and steps can be moved to.
    const hits = ray.intersectObjects(group.children, false);
    const hit = hits.find((h) => h.object.material?.opacity !== 0.18);
    if (!hit || !walkable.includes(hit.object)) return null;
    if (hit.distance > 18) return null;
    return hit;
  };

  // A ring on the floor under the pointer shows where a click will go.
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

  // The way up a switchback: the foot of flight one, the landing, the top of flight two.
  function stairRoute(st) {
    const { b, base, rise, half, landingD } = st;
    const lx = b.x0 + half / 2, rx = b.x0 + half * 1.5;
    return [
      new THREE.Vector3(lx, base + EYE, b.y0 - 0.55),
      new THREE.Vector3(lx, base + rise / 2 + EYE, b.y1 - landingD / 2),
      new THREE.Vector3(rx, base + rise / 2 + EYE, b.y1 - landingD / 2),
      new THREE.Vector3(rx, base + rise + EYE, b.y0 - 0.55),
    ];
  }

  // Gliding to a point. On the stairs the path follows the steps up or down.
  let travel = null;
  function moveTo(e) {
    const hit = pick(e);
    if (!hit) return;
    // Stop a little short of the spot so you don't end up nose to a wall.
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
      const route = stairRoute(stair);
      const way = goingUp ? route : route.slice().reverse();
      path.push(...way.slice(0, -1));
      target = way[way.length - 1];
    } else {
      // Moving between floors by clicking a floor seen up or down the stairwell goes via the stairs.
      const fromLevel = levelAtHeight(design, from.y);
      const toLevel = hit.object.userData.level;
      const s = stairs.find((st) => st.level === Math.min(fromLevel, toLevel));
      if (s && fromLevel !== toLevel) {
        const route = stairRoute(s);
        path.push(...(toLevel > fromLevel ? route : route.slice().reverse()));
      }
    }
    path.push(target);
    const lengths = [0];
    for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + path[i].distanceTo(path[i - 1]));
    travel = { path, lengths, total: lengths[lengths.length - 1], start: performance.now(), duration: Math.min(3200, 450 + lengths[lengths.length - 1] * 260) };
  }

  const roomLabel = host.querySelector('.walk-room');
  const start = host.querySelector('.walk-start');
  host.querySelector('[data-begin]').addEventListener('click', () => { start.classList.add('is-hidden'); canvas.focus(); });
  host.querySelector('[data-exit]').addEventListener('click', close);

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
      let t = reduced ? 1 : Math.min(1, (now - travel.start) / travel.duration);
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
    const r = lvl.rooms.find((x) => inPoly(camera.position.x, camera.position.z, x.polygon));
    const onStairs = stairs.some((s) => camera.position.x > s.b.x0 && camera.position.x < s.b.x1 && camera.position.z > s.b.y0 && camera.position.z < s.b.y1);
    const label = `${onStairs ? 'Stairs' : r ? r.name : 'Hall'} · ${lvl.name}`;
    if (roomLabel.textContent !== label) roomLabel.textContent = label;
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
