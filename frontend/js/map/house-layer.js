// The building on the map: a three.js model built from a terrasim.design/2 record and placed at its
// real position and bearing. It rises out of a grid of tiles when it appears.

import * as THREE from 'three';
import { maplibregl } from './map.js';
import { openingSegment, pointInPolygon, bounds } from '../lib/design.js';

const DEFAULTS = { walls: '#e9e4da', roof: '#4a4f55', trim: '#2b2f33', glass: '#5d7c99', accent: '#8a6a4a' };

function paletteColors(design) {
  const out = { ...DEFAULTS };
  for (const p of design.exterior?.materials?.palette ?? []) {
    const use = (p.use || '').toLowerCase();
    if (use.includes('interior')) continue;
    if (use.includes('wall')) out.walls = p.hex;
    else if (use.includes('roof')) out.roof = p.hex;
    else if (use.includes('window') || use.includes('trim')) out.trim = p.hex;
    else if (use.includes('accent') || use.includes('door')) out.accent = p.hex;
  }
  return out;
}

// The outside of the building, in building metres: x along the width, y along the depth (0 = front),
// z up. Each level is its outline raised to its height; windows and doors come from the exterior
// walls' openings; balconies, garage, porch, parking and roof from the file.
export function buildHouseModel(design) {
  const group = new THREE.Group();
  const colors = paletteColors(design);
  const levels = design.levels;
  const PLINTH = 0.3;
  const mat = (hex, extra = {}) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide, ...extra });
  const wallMat = mat(colors.walls);
  const roofMat = mat(colors.roof, { roughness: 0.7 });
  const trimMat = mat(colors.trim);
  const accentMat = mat(colors.accent);
  const glassMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.glass), roughness: 0.15, metalness: 0.4, emissive: new THREE.Color('#ffb15c'), emissiveIntensity: 0 });
  const railGlass = new THREE.MeshStandardMaterial({ color: new THREE.Color('#bcd3e6'), roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const slabMat = mat('#bfb8ab');
  const asphaltMat = mat('#4a4d52', { roughness: 1 });

  const box = (w, d, h, x, y, z, m) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m);
    mesh.position.set(x + w / 2, y + d / 2, z + h / 2);
    group.add(mesh);
    return mesh;
  };
  // A polygon raised from z0 to z1.
  const prism = (poly, z0, z1, m) => {
    const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.z = z0;
    group.add(mesh);
    return mesh;
  };
  // A thin box lying along a segment, pushed `out` metres along its outward normal.
  const along = (a, b, z0, z1, depth, out, m) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.02 || z1 - z0 < 0.01) return null;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, depth, z1 - z0), m);
    mesh.position.set((a[0] + b[0]) / 2 + uy * out, (a[1] + b[1]) / 2 - ux * out, (z0 + z1) / 2);
    mesh.rotation.z = Math.atan2(uy, ux);
    group.add(mesh);
    return mesh;
  };
  // Signed distance direction: +1 when the right-hand normal of a→b points out of the outline.
  const outward = (a, b, outline) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
    return pointInPolygon(mx + nx * 0.25, my + ny * 0.25, outline) ? -1 : 1;
  };

  const glassPanes = [];
  let wallTop = 0;
  levels.forEach((l, li) => {
    const isTop = li === levels.length - 1;
    const z0 = l.elevationM + PLINTH;
    const z1 = isTop ? l.elevationM + (l.ceilingHeightM ?? l.heightM - 0.3) + PLINTH + 0.35 : l.elevationM + l.heightM + PLINTH;
    wallTop = Math.max(wallTop, z1);
    if (li === 0 || l.elevationM < 0) prism(l.outline, l.elevationM < 0 ? -0.05 : -0.05, z0, slabMat);
    prism(l.outline, z0, z1, wallMat);
    // A band at each floor line.
    if (li > 0) {
      for (let i = 0; i < l.outline.length; i++) {
        const a = l.outline[i], b = l.outline[(i + 1) % l.outline.length];
        along(a, b, z0 - 0.1, z0 + 0.08, 0.08, 0.03 * outward(a, b, l.outline), trimMat);
      }
    }
    // Windows and doors on the outside walls.
    const walls = new Map((l.walls || []).map((w) => [w.id, w]));
    for (const o of l.openings || []) {
      const w = walls.get(o.wallId);
      if (!w || w.kind !== 'exterior') continue;
      const seg = openingSegment(w, o);
      const a = [seg.x1, seg.y1], b = [seg.x2, seg.y2];
      const dir = outward(a, b, l.outline);
      const isWindow = o.kind === 'window';
      const glassy = isWindow || o.kind === 'patio';
      const oz0 = z0 + (isWindow ? (o.sillM ?? 0.8) : 0.02);
      const oz1 = z0 + (o.headM ?? (isWindow ? 2.2 : 2.1));
      if (o.kind === 'passage' || o.kind === 'cased') {
        along(a, b, z0 + 0.02, oz1, 0.08, 0.02 * dir, mat('#1b1f24'));
        continue;
      }
      const pane = along(a, b, oz0, oz1, 0.08, 0.02 * dir, glassy ? glassMat : o.kind === 'garage' ? wallMat : accentMat);
      if (pane && glassy) glassPanes.push(pane);
      // A frame round windows and glass doors.
      const f = 0.07;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
      const a2 = [a[0] - ux * f, a[1] - uy * f], b2 = [b[0] + ux * f, b[1] + uy * f];
      if (isWindow) along(a2, b2, oz0 - f, oz0, 0.1, 0.05 * dir, trimMat);
      along(a2, b2, oz1, oz1 + f, 0.1, 0.05 * dir, trimMat);
      along(a2, a, oz0, oz1, 0.1, 0.05 * dir, trimMat);
      along(b, b2, oz0, oz1, 0.1, 0.05 * dir, trimMat);
    }
    // Balconies: a slab and a railing on the edges away from the building.
    for (const bal of l.balconies || []) {
      prism(bal.polygon, z0 - 0.15, z0 + 0.02, slabMat);
      const rail = bal.railing === 'glass' ? railGlass : bal.railing === 'solid' ? wallMat : trimMat;
      for (let i = 0; i < bal.polygon.length; i++) {
        const a = bal.polygon[i], b = bal.polygon[(i + 1) % bal.polygon.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = (b[1] - a[1]) / len * 0.25, ny = -(b[0] - a[0]) / len * 0.25;
        if (pointInPolygon(mx + nx, my + ny, l.outline) || pointInPolygon(mx - nx, my - ny, l.outline)) continue;
        along(a, b, z0 + 0.02, z0 + 1.05, 0.04, 0, rail);
        along(a, b, z0 + 1.05, z0 + 1.1, 0.06, 0, trimMat);
      }
    }
  });

  // Roof over the top level.
  const topLevel = levels[levels.length - 1];
  const roof = design.exterior?.roof ?? { type: 'flat' };
  const eave = roof.eaveM ?? 0.4;
  const tb = bounds(topLevel.outline);
  if (roof.type === 'flat' || !roof.type) {
    prism(topLevel.outline, wallTop, wallTop + 0.25, roofMat);
    // A parapet round the edge.
    for (let i = 0; i < topLevel.outline.length; i++) {
      const a = topLevel.outline[i], b = topLevel.outline[(i + 1) % topLevel.outline.length];
      along(a, b, wallTop, wallTop + 0.6, 0.2, -0.1 * outward(a, b, topLevel.outline), wallMat);
    }
  } else {
    // Gable or hip over the top level's rectangle, ridge along x or y.
    const alongY = roof.ridgeAxis === 'y';
    const L = alongY ? tb.y1 - tb.y0 : tb.x1 - tb.x0;   // length along the ridge
    const S = alongY ? tb.x1 - tb.x0 : tb.y1 - tb.y0;   // span across it
    const pitch = roof.pitch ?? 0.6;
    const rise = Math.max(0.6, pitch * (S / 2 + eave));
    const zE = wallTop - eave * pitch, zR = wallTop + rise - eave * pitch;
    // Built with the ridge along local u, then mapped to x/y.
    const P = (u, v, z) => (alongY ? [tb.x0 + v, tb.y0 + u, z] : [tb.x0 + u, tb.y0 + v, z]);
    const u0 = -eave, u1 = L + eave, v0 = -eave, v1 = S + eave, vm = S / 2;
    let verts;
    if (roof.type === 'hip') {
      const inset = Math.min((u1 - u0) / 2 - 0.1, (v1 - v0) / 2);
      const r0 = P(u0 + inset, vm, zR), r1 = P(u1 - inset, vm, zR);
      const a = P(u0, v0, zE), b = P(u1, v0, zE), c = P(u1, v1, zE), d = P(u0, v1, zE);
      verts = [...a, ...b, ...r1, ...a, ...r1, ...r0, ...c, ...d, ...r0, ...c, ...r0, ...r1, ...b, ...c, ...r1, ...d, ...a, ...r0];
    } else {
      const a = P(u0, v0, zE), b = P(u1, v0, zE), c = P(u1, v1, zE), d = P(u0, v1, zE);
      const r0 = P(u0, vm, zR), r1 = P(u1, vm, zR);
      verts = [...a, ...b, ...r1, ...a, ...r1, ...r0, ...c, ...d, ...r0, ...c, ...r0, ...r1];
      const ge = new THREE.BufferGeometry();
      ge.setAttribute('position', new THREE.Float32BufferAttribute([...P(0, 0, wallTop), ...P(0, S, wallTop), ...P(0, vm, zR - 0.15), ...P(L, 0, wallTop), ...P(L, S, wallTop), ...P(L, vm, zR - 0.15)], 3));
      ge.computeVertexNormals();
      group.add(new THREE.Mesh(ge, wallMat));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, roofMat));
  }

  // Garage, porch and parking.
  const ext = design.exterior || {};
  if (ext.garage?.polygon) {
    const gb = bounds(ext.garage.polygon);
    const gh = ext.garage.heightM ?? 3;
    prism(ext.garage.polygon, 0, gh, wallMat);
    box(gb.x1 - gb.x0 + 0.4, gb.y1 - gb.y0 + 0.4, 0.35, gb.x0 - 0.2, gb.y0 - 0.2, gh, roofMat);
    box((gb.x1 - gb.x0) * 0.8, 0.06, 2.3, gb.x0 + (gb.x1 - gb.x0) * 0.1, gb.y0 - 0.04, 0.05, trimMat);
  }
  if (ext.porch?.polygon) {
    const pb = bounds(ext.porch.polygon);
    const pw = pb.x1 - pb.x0, pd = pb.y1 - pb.y0;
    prism(ext.porch.polygon, 0, 0.25, slabMat);
    box(pw, pd, 0.2, pb.x0, pb.y0, 2.7, roofMat);
    for (const t of [0, 1]) box(0.18, 0.18, 2.5, pb.x0 + t * (pw - 0.18), pb.y0, 0.2, accentMat);
  }
  for (const p of ext.parking || []) {
    prism(p.polygon, 0, 0.04, asphaltMat);
    if (p.covered) {
      const pb = bounds(p.polygon);
      box(pb.x1 - pb.x0, pb.y1 - pb.y0, 0.2, pb.x0, pb.y0, 2.6, roofMat);
    }
  }

  group.userData = { glassMat, glassPanes, W: design.size.widthM, D: design.size.depthM, height: zTop(group) };
  return group;
}

function zTop(group) {
  const b = new THREE.Box3().setFromObject(group);
  return b.max.z;
}

// Matrix from house metres to Mercator world units.
function placementMatrix(placement) {
  const mc = maplibregl.MercatorCoordinate.fromLngLat(placement.origin, 0);
  const s = mc.meterInMercatorCoordinateUnits();
  const b = (placement.xAxisBearingDeg * Math.PI) / 180;
  // House x axis points along bearing b; y axis is x turned 90° counter-clockwise (towards the back).
  const ex = new THREE.Vector3(Math.sin(b) * s, -Math.cos(b) * s, 0);
  const ey = new THREE.Vector3(-Math.cos(b) * s, -Math.sin(b) * s, 0);
  const ez = new THREE.Vector3(0, 0, s);
  const m = new THREE.Matrix4().makeBasis(ex, ey, ez);
  m.setPosition(mc.x, mc.y, mc.z);
  return m;
}

// Bright tile colours for the building's rise.
const GLOW = ['#ff8a2a', '#ffb15c', '#ffd27a', '#ff9d4c'];

export function createHouseLayer(map) {
  const empty = () => ({ id: null, design: null, model: null, placement: null, rise: 1 });
  let state = empty();
  let selection = null;
  const orange = new THREE.Color('#ff8a2a');
  let night = false;
  const saved = new Map();
  let renderer, camera, renderMatrix;
  const entries = () => [...saved.values(), ...(state.model && !saved.has(state.id) ? [state] : [])];

  function dispose(entry) {
    const geometries = new Set(), materials = new Set();
    entry.scene?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material) materials.add(material);
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    entry.scene?.clear();
  }

  function light(entry) {
    for (const [material, original] of entry.materials) {
      material.color.copy(original.color);
      material.emissive.copy(original.emissive);
      material.emissiveIntensity = material === entry.model.userData.glassMat ? (night ? 1.1 : 0) : original.intensity;
      if (entry === selection) {
        material.color.lerp(orange, 0.5);
        material.emissive.copy(orange);
        material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.22);
      }
    }
    entry.sun.intensity = night ? 0.5 : 2.2;
    entry.sky.intensity = night ? 0.5 : 1.6;
  }

  function select(entry) {
    if (selection === entry) return;
    const previous = selection;
    selection = entry;
    if (previous) light(previous);
    if (entry) light(entry);
    map.triggerRepaint();
  }

  function makeEntry(id, design, placement, anim = false) {
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-0.4, -0.7, 1).normalize();
    const sky = new THREE.HemisphereLight(0xeef3fa, 0x5a4e3e, 1.6);
    const model = buildHouseModel(design);
    const materials = new Map();
    model.traverse((object) => {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material?.color && material.emissive && !materials.has(material)) materials.set(material, {
          color: material.color.clone(), emissive: material.emissive.clone(), intensity: material.emissiveIntensity,
        });
      }
    });
    scene.add(sun, sky, model);
    const tiles = anim ? makeTiles(design) : null;
    if (tiles) scene.add(tiles);
    const entry = { id, design, placement, scene, sun, sky, model, tiles, materials,
      rise: anim && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1, riseStart: performance.now() };
    if (entry.rise >= 1 && tiles) tiles.visible = false;
    light(entry);
    return entry;
  }

  const layer = {
    id: 'house-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      camera = new THREE.Camera();
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(a, b) {
      if (!state.model && !saved.size && !gen.mesh) return;
      const args = b ?? a;
      // Mercator-space matrix (the globe has flattened to mercator by street zoom).
      const matrix = args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix;
      if (!matrix || map.getZoom() < 13) return;
      renderMatrix = new THREE.Matrix4().fromArray(matrix);
      renderer.resetState();
      const visible = entries();
      for (const entry of visible) {
        animate(entry);
        camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(placementMatrix(entry.placement));
        renderer.render(entry.scene, camera);
      }
      if (gen.mesh) {
        animateGen();
        camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(placementMatrix(gen.placement));
        renderer.render(genScene, camera);
      }
      if (visible.some((entry) => entry.rise < 1) || gen.mesh) map.triggerRepaint();
    },
  };

  function animate(entry) {
    if (entry.rise >= 1) return;
    const t = Math.min(1, (performance.now() - entry.riseStart) / 2600);
    entry.rise = t;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const model = entry.model;
    const tiles = entry.tiles;
    // First the grid rises under the footprint, then the house grows out of it and the tiles sink.
    const tGrid = Math.min(1, t / 0.45);
    const tHouse = Math.max(0, (t - 0.35) / 0.65);
    if (tiles) {
      const dummy = new THREE.Object3D();
      tiles.userData.cells.forEach((c, i) => {
        const local = Math.max(0, Math.min(1, tGrid * 1.6 - c.delay));
        const sink = Math.max(0, Math.min(1, tHouse * 1.4 - c.delay * 0.5));
        const h = Math.max(0.02, (ease(local) * c.h) * (1 - ease(sink)));
        dummy.position.set(c.x, c.y, h / 2);
        dummy.scale.set(1, 1, h);
        dummy.updateMatrix();
        tiles.setMatrixAt(i, dummy.matrix);
      });
      tiles.instanceMatrix.needsUpdate = true;
      tiles.visible = t < 1;
    }
    model.scale.set(1, 1, Math.max(0.001, ease(tHouse)));
    model.visible = tHouse > 0;
  }

  function makeTiles(design) {
    const W = design.size.widthM, D = design.size.depthM, cell = 1.2;
    const cells = [];
    for (let x = -1; x < W + 1; x += cell) {
      for (let y = -1; y < D + 1; y += cell) {
        const inside = x >= 0 && x < W && y >= 0 && y < D;
        const d = Math.hypot(x - W / 2, y - D / 2) / Math.hypot(W / 2, D / 2);
        cells.push({ x: x + cell / 2, y: y + cell / 2, h: inside ? 1.5 + (1 - d) * 3.5 : 0.4, delay: d * 0.6 });
      }
    }
    const geo = new THREE.BoxGeometry(cell * 0.86, cell * 0.86, 1);
    const tileMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#ffb15c'), emissive: new THREE.Color('#ff8a2a'), emissiveIntensity: 0.9, roughness: 0.5, transparent: true, opacity: 0.9 });
    const mesh = new THREE.InstancedMesh(geo, tileMat, cells.length);
    const c = new THREE.Color();
    cells.forEach((cell, i) => mesh.setColorAt(i, c.set(GLOW[i % GLOW.length])));
    mesh.userData.cells = cells;
    return mesh;
  }

  // ---- the generation grid: the whole lot lights up while the design service works --------------
  const gen = { mesh: null, placement: null, start: 0, end: 0, cells: null };
  let genScene = null;
  function ensureGenScene() {
    if (genScene) return;
    genScene = new THREE.Scene();
    genScene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const d = new THREE.DirectionalLight(0xffffff, 1.4);
    d.position.set(-0.3, -0.6, 1).normalize();
    genScene.add(d);
  }
  // Lays a grid of tiles over the outlined land ([lng, lat] ring), in metres east (x) and north (y).
  function makeGenGrid(ring) {
    const lng0 = Math.min(...ring.map((p) => p[0])), lat0 = Math.min(...ring.map((p) => p[1]));
    const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const local = ring.map(([lng, lat]) => [(lng - lng0) * mLng, (lat - lat0) * mLat]);
    const W = Math.max(...local.map((p) => p[0])), D = Math.max(...local.map((p) => p[1]));
    const cell = Math.max(1.4, Math.sqrt((W * D) / 900)); // about 900 tiles at most
    const inside = (x, y) => {
      let k = false;
      for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
        if ((local[i][1] > y) !== (local[j][1] > y) && x < ((local[j][0] - local[i][0]) * (y - local[i][1])) / (local[j][1] - local[i][1]) + local[i][0]) k = !k;
      }
      return k;
    };
    const cx = W / 2, cy = D / 2, R = Math.hypot(cx, cy) || 1;
    const cells = [];
    for (let x = cell / 2; x < W; x += cell) {
      for (let y = cell / 2; y < D; y += cell) {
        if (!inside(x, y)) continue;
        const d = Math.hypot(x - cx, y - cy) / R;
        cells.push({ x, y, d, phase: Math.random() * Math.PI * 2, h: 0.6 + Math.random() * 1.4 });
      }
    }
    const geo = new THREE.BoxGeometry(cell * 0.82, cell * 0.82, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color('#ff8a2a'), emissiveIntensity: 0.65, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.88 });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
    mesh.count = cells.length;
    gen.cells = cells;
    gen.cell = cell;
    gen.placement = { origin: [lng0, lat0], xAxisBearingDeg: 90 };
    return mesh;
  }
  // Rise from the ground in a ring from the middle; then waves of light and height roll across the
  // lot; when the design arrives (or fails) the tiles sink back into the ground.
  const GEN_COLORS = ['#ff8a2a', '#ffb15c', '#ffd27a', '#ff6a1a', '#fff1d0'].map((h) => new THREE.Color(h));
  const FAIL = new THREE.Color('#ff5a4f'), FAIL_DIM = new THREE.Color('#5a2a2a');
  const FAIL_MS = 3400;
  function animateGen() {
    if (gen.failed) { animateFail(); return; }
    const now = performance.now();
    const t = (now - gen.start) / 1000;
    const ending = gen.end ? Math.min(1, (now - gen.end) / 1400) : 0;
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    gen.cells.forEach((c, i) => {
      const rise = Math.max(0, Math.min(1, t * 0.9 - c.d * 0.8));
      const ease = 1 - Math.pow(1 - rise, 3);
      const wave = 0.5 + 0.5 * Math.sin(t * 2.2 - c.d * 9 + c.phase * 0.25);
      const sweep = Math.max(0, 1 - Math.abs(((t * 0.35) % 1.4) - 0.2 - (c.x / (gen.cells.at(-1)?.x || 1)))) ** 6;
      const h = Math.max(0.03, ease * (0.25 + c.h * (0.35 + 0.65 * wave) + sweep * 2.2) * (1 - ending));
      dummy.position.set(c.x, c.y, h / 2);
      dummy.scale.set(1, 1, h);
      dummy.updateMatrix();
      gen.mesh.setMatrixAt(i, dummy.matrix);
      const k = Math.min(GEN_COLORS.length - 1, Math.floor((wave * 0.7 + sweep) * GEN_COLORS.length));
      gen.mesh.setColorAt(i, col.copy(GEN_COLORS[Math.max(0, k)]).lerp(GEN_COLORS[4], sweep * 0.6));
    });
    gen.mesh.instanceMatrix.needsUpdate = true;
    if (gen.mesh.instanceColor) gen.mesh.instanceColor.needsUpdate = true;
    gen.mesh.material.emissiveIntensity = 0.55 + 0.25 * Math.sin(t * 3);
    if (ending >= 1) {
      genScene.remove(gen.mesh);
      gen.mesh.geometry.dispose();
      gen.mesh = null;
    }
  }
  // When the design fails: the tiles flash red together, shudder, then crumble down one by one
  // from the middle outward, darkening as they go, and are gone.
  function animateFail() {
    const now = performance.now();
    const k = Math.min(1, (now - gen.failed) / FAIL_MS);
    const s = (now - gen.failed) / 1000;
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const flash = Math.max(0, 1 - s / 0.5);
    gen.cells.forEach((c, i) => {
      const h0 = c.failH ?? 0.4;
      // Shudder in the first 0.9 s, then each tile drops in turn by its distance from the middle.
      const shake = s < 0.9 ? Math.sin(s * 60 + c.phase * 6) * 0.08 * (1 - s / 0.9) : 0;
      const drop = Math.max(0, Math.min(1, (k - 0.25 - c.d * 0.45) / 0.3));
      const ease = drop * drop;
      const h = Math.max(0.02, h0 * (1 - ease) + 0.02);
      dummy.position.set(c.x + shake, c.y - shake * 0.6, h / 2 - ease * 0.6);
      dummy.rotation.set(ease * (c.phase - Math.PI) * 0.35, ease * (Math.PI - c.phase) * 0.25, 0);
      dummy.scale.set(1 - ease * 0.4, 1 - ease * 0.4, h);
      dummy.updateMatrix();
      gen.mesh.setMatrixAt(i, dummy.matrix);
      gen.mesh.setColorAt(i, col.copy(FAIL).lerp(FAIL_DIM, Math.min(1, drop * 1.2)).lerp(GEN_COLORS[4], flash * 0.6));
    });
    gen.mesh.instanceMatrix.needsUpdate = true;
    if (gen.mesh.instanceColor) gen.mesh.instanceColor.needsUpdate = true;
    gen.mesh.material.emissive.copy(FAIL);
    gen.mesh.material.emissiveIntensity = 0.35 + flash * 0.9;
    gen.mesh.material.opacity = 0.88 * (1 - Math.max(0, (k - 0.8) / 0.2));
    if (k >= 1) {
      genScene.remove(gen.mesh);
      gen.mesh.geometry.dispose();
      gen.mesh.material.dispose();
      gen.mesh = null;
      gen.failed = 0;
    }
  }

  return {
    layer,
    // Saved entries remain in the scene when another building is selected.
    add(id, design, placement) {
      if (saved.get(id)?.design === design) return;
      const old = saved.get(id);
      const selected = old === selection;
      if (selected) select(null);
      const entry = makeEntry(id, design, placement);
      saved.set(id, entry);
      if (old === state) state = entry;
      if (selected) select(entry);
      if (old) dispose(old);
      map.triggerRepaint();
    },
    show(design, placement, { animate: anim = true, id = null, selected = false } = {}) {
      select(null);
      if (state.model && !saved.has(state.id)) dispose(state);
      let entry = id && saved.get(id);
      if (!entry || entry.design !== design) {
        if (entry) dispose(entry);
        entry = makeEntry(id, design, placement, anim);
        if (id) saved.set(id, entry);
      } else entry.placement = placement;
      state = entry;
      if (selected) select(entry);
      map.triggerRepaint();
    },
    select() { if (state.model) select(state); },
    deselect() { select(null); },
    isSelected(entry) { return !!entry && entry === selection; },
    // Promote a newly saved preview without rebuilding it or reverting a newer drag.
    remember(id) {
      if (!state.model) return;
      const old = saved.get(id);
      if (old && old !== state) dispose(old);
      state.id = id;
      saved.set(id, state);
    },
    remove(id) {
      const entry = saved.get(id);
      if (!entry) return;
      if (selection === entry) select(null);
      if (state === entry) state = empty();
      saved.delete(id); dispose(entry);
      map.triggerRepaint();
    },
    at(point) {
      return [state, ...saved.values()].find((entry) => entry.model &&
        pointInPolygon(point[0], point[1], entry.placement.footprint)) ?? null;
    },
    // Pick actual roof/wall geometry. A tilted camera projects elevated surfaces
    // outside the ground footprint, so map.unproject alone cannot identify them.
    pick(point) {
      if (!point || !renderMatrix || map.getZoom() < 13) return null;
      const canvas = map.getCanvas();
      const x = point.x / canvas.clientWidth * 2 - 1, y = 1 - point.y / canvas.clientHeight * 2;
      const ray = new THREE.Raycaster();
      let closest = null, depth = Infinity;
      for (const entry of entries()) {
        if (!entry.model.visible) continue;
        const projection = renderMatrix.clone().multiply(placementMatrix(entry.placement));
        const inverse = projection.clone().invert();
        const near = new THREE.Vector3(x, y, -1).applyMatrix4(inverse);
        const far = new THREE.Vector3(x, y, 1).applyMatrix4(inverse);
        ray.set(near, far.sub(near).normalize());
        entry.model.updateMatrixWorld(true);
        const hit = ray.intersectObject(entry.model, true)[0];
        if (!hit) continue;
        const z = hit.point.clone().applyMatrix4(projection).z;
        if (z >= -1 && z <= 1 && z < depth) { closest = entry; depth = z; }
      }
      return closest;
    },
    // Where a point on the shown building (house metres: x along the width, y along the depth, z up)
    // is on screen, in CSS pixels, or null when it's off screen or not drawn yet.
    screenPoint([x, y, z]) {
      if (!state.model || !renderMatrix || map.getZoom() < 13) return null;
      const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(renderMatrix.clone().multiply(placementMatrix(state.placement)));
      if (v.w <= 0) return null;
      const canvas = map.getCanvas();
      return { x: (v.x / v.w + 1) / 2 * canvas.clientWidth, y: (1 - v.y / v.w) / 2 * canvas.clientHeight };
    },
    // The shown building's size in metres: width, depth and the height of its highest point.
    get size() { return state.model ? { W: state.model.userData.W, D: state.model.userData.D, height: state.model.userData.height } : null; },
    clear() {
      select(null);
      for (const entry of entries()) dispose(entry);
      saved.clear(); state = empty();
      if (gen.mesh) { genScene.remove(gen.mesh); gen.mesh.geometry.dispose(); gen.mesh.material.dispose(); gen.mesh = null; }
      map.triggerRepaint();
    },
    // While a design is being made: a glowing grid rises over the outlined land ([lng, lat] ring).
    generating(ring) {
      ensureGenScene();
      if (gen.mesh) { genScene.remove(gen.mesh); gen.mesh.geometry.dispose(); }
      gen.mesh = makeGenGrid(ring);
      gen.start = performance.now();
      gen.end = 0;
      gen.failed = 0;
      genScene.add(gen.mesh);
      map.triggerRepaint();
    },
    // The design arrived: the grid sinks back into the ground.
    stopGenerating() {
      if (gen.mesh && !gen.end && !gen.failed) gen.end = performance.now();
      map.triggerRepaint();
    },
    // The design failed: the grid flashes red and crumbles away (animateFail).
    failGenerating() {
      if (!gen.mesh || gen.failed) return;
      // Each tile falls from the height it had when the failure came.
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      gen.cells.forEach((c, i) => { gen.mesh.getMatrixAt(i, m); m.decompose(p, q, sc); c.failH = Math.max(0.1, sc.z); });
      gen.failed = performance.now();
      gen.end = 0;
      map.triggerRepaint();
    },
    // Moves the building to a new placement without replaying its rise.
    move(placement) {
      state.placement = placement;
      map.triggerRepaint();
    },
    hide() {
      select(null);
      if (state.model && !saved.has(state.id)) dispose(state);
      state = empty();
      map.triggerRepaint();
    },
    setNight(on) {
      night = on;
      entries().forEach(light);
      map.triggerRepaint();
    },
    get entries() { return entries().map((entry) => ({ id: entry.id, design: entry.design, placement: entry.placement, selected: entry === selection })); },
    get selected() { return !!state.model && state === selection; },
    get design() { return state.design; },
    get placement() { return state.placement; },
  };
}
