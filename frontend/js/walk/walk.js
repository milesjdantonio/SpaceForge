// Walkthrough: the floor plan data turned into rooms you can walk through (three.js).
// House metres map to three.js as x -> X, y -> Z, height -> Y.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/PointerLockControls.js';
import { icon } from '../ui/icons.js';

const EYE = 1.62;
const DOOR_H = 2.1;

function key(p) { return `${p[0].toFixed(2)},${p[1].toFixed(2)}`; }

// Unique wall segments of a level from its room outlines.
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
  // Split collinear overlapping edges at every vertex lying on them, so shared partial walls
  // are drawn once.
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
      const px = a[0] + dx * t, py = a[1] + dy * t;
      if (Math.hypot(px - p[0], py - p[1]) < 0.03) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let i = 0; i < ts.length - 1; i++) {
      const s = [a[0] + dx * ts[i], a[1] + dy * ts[i]], e = [a[0] + dx * ts[i + 1], a[1] + dy * ts[i + 1]];
      const k = [key(s), key(e)].sort().join('|');
      out.set(k, { a: s, b: e });
    }
  }
  return [...out.values()];
}

// Openings lying along a wall, as [t0, t1] ranges with their kind.
function openingsOn(seg, openings) {
  const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dy);
  const list = [];
  for (const o of openings) {
    const d1 = distToLine([o.x1, o.y1], seg), d2 = distToLine([o.x2, o.y2], seg);
    if (d1 > 0.12 || d2 > 0.12) continue;
    const t1 = (((o.x1 - seg.a[0]) * dx + (o.y1 - seg.a[1]) * dy) / (len * len));
    const t2 = (((o.x2 - seg.a[0]) * dx + (o.y2 - seg.a[1]) * dy) / (len * len));
    const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(1, Math.max(t1, t2));
    if (hi - lo > 0.01) list.push({ lo, hi, o });
  }
  return list.sort((x, y) => x.lo - y.lo);
}

function distToLine(p, seg) {
  const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
  const len2 = dx * dx + dy * dy;
  const t = ((p[0] - seg.a[0]) * dx + (p[1] - seg.a[1]) * dy) / len2;
  if (t < -0.02 || t > 1.02) return Infinity;
  return Math.hypot(p[0] - (seg.a[0] + t * dx), p[1] - (seg.a[1] + t * dy));
}

function buildLevel(design, levelIndex) {
  const level = design.levels[levelIndex];
  const H = level.heightM - 0.25;
  const W = design.size.widthM, D = design.size.depthM;
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xefeae2, roughness: 0.92 });
  const extMat = new THREE.MeshStandardMaterial({ color: 0xe5dfd4, roughness: 0.92 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xb08a62, roughness: 0.7 });
  const wetMat = new THREE.MeshStandardMaterial({ color: 0xc9ccce, roughness: 0.5 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xf7f5f1, roughness: 1, side: THREE.DoubleSide });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfd6ea, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.25 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6 });
  const colliders = [];

  for (const r of level.rooms) {
    const shape = new THREE.Shape(r.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const wet = /bath|powder|laundry|mudroom/.test(r.type);
    const floor = new THREE.Mesh(geo, wet ? wetMat : floorMat);
    floor.position.y = 0.001;
    group.add(floor);
    const ceil = new THREE.Mesh(geo.clone(), ceilMat);
    ceil.position.y = H;
    group.add(ceil);
  }
  for (const s of level.stairs || []) {
    const xs = s.polygon.map((p) => p[0]), ys = s.polygon.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const g = new THREE.BoxGeometry(x1 - x0, 0.19 * (i + 1), (y1 - y0) / steps);
      const m = new THREE.Mesh(g, floorMat);
      m.position.set((x0 + x1) / 2, (0.19 * (i + 1)) / 2, y0 + ((i + 0.5) * (y1 - y0)) / steps);
      group.add(m);
    }
  }

  const piece = (seg, t0, t1, y0, y1, mat, thick) => {
    const ax = seg.a[0] + (seg.b[0] - seg.a[0]) * t0, ay = seg.a[1] + (seg.b[1] - seg.a[1]) * t0;
    const bx = seg.a[0] + (seg.b[0] - seg.a[0]) * t1, by = seg.a[1] + (seg.b[1] - seg.a[1]) * t1;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.02 || y1 - y0 < 0.02) return;
    const g = new THREE.BoxGeometry(len, y1 - y0, thick);
    const m = new THREE.Mesh(g, mat);
    m.position.set((ax + bx) / 2, (y0 + y1) / 2, (ay + by) / 2);
    m.rotation.y = -Math.atan2(by - ay, bx - ax);
    group.add(m);
  };

  for (const seg of wallSegments(level)) {
    const exterior = [seg.a, seg.b].every((p) => Math.abs(p[0]) < 0.05 || Math.abs(p[0] - W) < 0.05 || Math.abs(p[1]) < 0.05 || Math.abs(p[1] - D) < 0.05)
      && (Math.abs(seg.a[0] - seg.b[0]) < 0.05 ? (Math.abs(seg.a[0]) < 0.05 || Math.abs(seg.a[0] - W) < 0.05) : (Math.abs(seg.a[1]) < 0.05 || Math.abs(seg.a[1] - D) < 0.05));
    const thick = exterior ? 0.3 : 0.12;
    const mat = exterior ? extMat : wallMat;
    const ops = openingsOn(seg, level.openings || []);
    let t = 0;
    const solid = [];
    for (const { lo, hi, o } of ops) {
      if (lo > t) solid.push([t, lo]);
      const isWindow = o.kind === 'window';
      if (isWindow) {
        const sill = o.sillM ?? 0.8, head = o.headM ?? 2.2;
        piece(seg, lo, hi, 0, sill, mat, thick);
        piece(seg, lo, hi, head, H, mat, thick);
        piece(seg, lo, hi, sill, head, glassMat, 0.03);
        piece(seg, lo, hi, sill - 0.04, sill, frameMat, thick + 0.04);
        solid.push(null);
        colliders.push({ a: point(seg, lo), b: point(seg, hi) });
      } else {
        piece(seg, lo, hi, DOOR_H, H, mat, thick);
        if (o.kind === 'patio') { piece(seg, lo, hi, 0, DOOR_H, glassMat, 0.03); colliders.push({ a: point(seg, lo), b: point(seg, hi) }); }
        if (o.kind === 'entry' || o.kind === 'garage') colliders.push({ a: point(seg, lo), b: point(seg, hi) });
      }
      t = Math.max(t, hi);
    }
    if (t < 1) solid.push([t, 1]);
    for (const s of solid) {
      if (!s) continue;
      piece(seg, s[0], s[1], 0, H, mat, thick);
      colliders.push({ a: point(seg, s[0]), b: point(seg, s[1]) });
    }
  }
  return { group, colliders, H };
}

const point = (seg, t) => [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t];

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function roomAt(level, x, y) {
  for (const r of level.rooms) {
    const p = r.polygon;
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
    }
    if (inside) return r;
  }
  return null;
}

export function openWalkthrough(host, design) {
  host.hidden = false;
  host.innerHTML = `
    <canvas class="walk-canvas" tabindex="0" aria-label="Walkthrough of ${design.title}"></canvas>
    <div class="walk-top">
      <div><h2 class="walk-title">${design.title}</h2><p class="walk-room" aria-live="polite"></p></div>
      <div class="walk-tools">
        <div class="seg" role="group" aria-label="Floor">${design.levels.map((l, i) => `<button type="button" data-level="${i}" aria-pressed="${i === 0}">${l.name}</button>`).join('')}</div>
        <button type="button" class="btn" data-exit>${icon('close')}<span>Back to the map</span></button>
      </div>
    </div>
    <div class="walk-start">
      <p class="walk-start-title">Click to look around</p>
      <p>Move with W A S D or the arrow keys. Hold Shift to walk faster. Press Esc to stop looking.</p>
      <div class="walk-touch"><button type="button" class="btn" data-move="1">Forward</button><button type="button" class="btn" data-move="-1">Back</button></div>
    </div>
    <p class="walk-note">${design.sample ? 'Sample house. ' : ''}Furniture, finishes and lighting are not part of the design data yet.</p>`;

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
  scene.background = new THREE.Color(0xa9c3dc);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));
  const sun = new THREE.DirectionalLight(0xfff3e0, 1.4);
  sun.position.set(-6, 12, -10);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x6f8a55, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 500);
  const controls = new PointerLockControls(camera, canvas);
  let current = null;
  let levelIndex = 0;
  let colliders = [];

  const entry = design.levels[0].openings.find((o) => o.kind === 'entry');
  function setLevel(i, { keepPosition = true } = {}) {
    if (current) scene.remove(current.group);
    levelIndex = i;
    current = buildLevel(design, i);
    scene.add(current.group);
    colliders = current.colliders;
    if (!keepPosition) {
      if (entry && i === 0) camera.position.set((entry.x1 + entry.x2) / 2, EYE, Math.max(entry.y1, entry.y2) - 1.2);
      else {
        const r = design.levels[i].rooms[0];
        const xs = r.polygon.map((p) => p[0]), ys = r.polygon.map((p) => p[1]);
        camera.position.set((Math.min(...xs) + Math.max(...xs)) / 2, EYE, (Math.min(...ys) + Math.max(...ys)) / 2);
      }
      camera.lookAt(camera.position.x, EYE, camera.position.z - 3);
    }
    host.querySelectorAll('[data-level]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.level) === i)));
  }
  setLevel(0, { keepPosition: false });

  const keys = new Set();
  const onKey = (e) => {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
      if (e.type === 'keydown') keys.add(k); else keys.delete(k);
      e.preventDefault();
    }
  };
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKey);

  const start = host.querySelector('.walk-start');
  start.addEventListener('click', (e) => { if (!e.target.closest('[data-move]')) controls.lock(); });
  controls.addEventListener('lock', () => start.classList.add('is-hidden'));
  controls.addEventListener('unlock', () => start.classList.remove('is-hidden'));

  // Touch: drag to look, buttons to move.
  let touchMove = 0;
  let lastTouch = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') lastTouch = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointermove', (e) => {
    if (!lastTouch) return;
    const dx = e.clientX - lastTouch[0];
    camera.rotation.order = 'YXZ';
    camera.rotation.y -= dx * 0.005;
    lastTouch = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointerup', () => { lastTouch = null; });
  host.querySelectorAll('[data-move]').forEach((b) => {
    b.addEventListener('pointerdown', () => { touchMove = Number(b.dataset.move); start.classList.add('is-hidden'); });
    b.addEventListener('pointerup', () => { touchMove = 0; });
    b.addEventListener('pointerleave', () => { touchMove = 0; });
  });

  host.addEventListener('click', (e) => {
    const l = e.target.closest('[data-level]');
    if (l) setLevel(Number(l.dataset.level));
    if (e.target.closest('[data-exit]')) close();
  });

  const roomLabel = host.querySelector('.walk-room');
  const clock = new THREE.Clock();
  let raf = 0;
  const dir = new THREE.Vector3();
  function tick() {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, clock.getDelta());
    const w = host.clientWidth, h = host.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const speed = (keys.has('shift') ? 3.2 : 1.6) * dt;
    let fwd = touchMove, side = 0;
    if (keys.has('w') || keys.has('arrowup')) fwd += 1;
    if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
    if (keys.has('d') || keys.has('arrowright')) side += 1;
    if (keys.has('a') || keys.has('arrowleft')) side -= 1;
    if (fwd || side) {
      camera.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      const nx = camera.position.x + (dir.x * fwd + right.x * side) * speed;
      const nz = camera.position.z + (dir.z * fwd + right.z * side) * speed;
      const blocked = (x, z) => colliders.some((c) => segDist([x, z], c.a, c.b) < 0.28);
      if (!blocked(nx, camera.position.z)) camera.position.x = nx;
      if (!blocked(camera.position.x, nz)) camera.position.z = nz;
    }
    camera.position.y = EYE;
    const r = roomAt(design.levels[levelIndex], camera.position.x, camera.position.z);
    const label = r ? r.name : 'Outside';
    if (roomLabel.textContent !== label) roomLabel.textContent = label;
    renderer.render(scene, camera);
  }
  tick();
  canvas.focus();

  const onEsc = (e) => { if (e.key === 'Escape' && !controls.isLocked) close(); };
  addEventListener('keydown', onEsc);

  function close() {
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKey);
    removeEventListener('keydown', onEsc);
    try { controls.unlock(); controls.dispose(); } catch {}
    renderer?.dispose();
    host.hidden = true;
    host.replaceChildren();
  }
}
