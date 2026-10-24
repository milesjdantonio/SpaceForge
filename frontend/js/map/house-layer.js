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

export function createHouseLayer(map) {
  const state = { design: null, model: null, placement: null, rise: 1, riseStart: 0, night: false, tiles: null };
  let renderer, scene, camera;

  const layer = {
    id: 'house-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(-0.4, -0.7, 1).normalize();
      scene.add(sun);
      const sky = new THREE.HemisphereLight(0xeef3fa, 0x5a4e3e, 1.6);
      scene.add(sky);
      state.lights = { sun, sky };
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(a, b) {
      if (!state.model) return;
      const args = b ?? a;
      // Mercator-space matrix (the globe has flattened to mercator by street zoom).
      const matrix = args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix;
      if (!matrix || map.getZoom() < 13) return;
      animate();
      const world = new THREE.Matrix4().fromArray(matrix);
      camera.projectionMatrix = world.multiply(placementMatrix(state.placement));
      renderer.resetState();
      renderer.render(scene, camera);
      if (state.rise < 1) map.triggerRepaint();
    },
  };

  function animate() {
    if (state.rise >= 1) return;
    const t = Math.min(1, (performance.now() - state.riseStart) / 2600);
    state.rise = t;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const model = state.model;
    const tiles = state.tiles;
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
    const tileMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#ffb15c'), roughness: 0.6, transparent: true, opacity: 0.85 });
    const mesh = new THREE.InstancedMesh(geo, tileMat, cells.length);
    mesh.userData.cells = cells;
    return mesh;
  }

  return {
    layer,
    show(design, placement, { animate: anim = true } = {}) {
      if (state.model) scene.remove(state.model);
      if (state.tiles) scene.remove(state.tiles);
      state.design = design;
      state.placement = placement;
      state.model = buildHouseModel(design);
      scene.add(state.model);
      state.tiles = anim ? makeTiles(design) : null;
      if (state.tiles) scene.add(state.tiles);
      state.rise = anim && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
      state.riseStart = performance.now();
      if (state.rise >= 1) { state.model.scale.set(1, 1, 1); if (state.tiles) state.tiles.visible = false; }
      this.setNight(state.night);
      map.triggerRepaint();
    },
    hide() {
      if (state.model) scene.remove(state.model);
      if (state.tiles) scene.remove(state.tiles);
      state.model = null;
      state.design = null;
      map.triggerRepaint();
    },
    setNight(on) {
      state.night = on;
      if (state.model) state.model.userData.glassMat.emissiveIntensity = on ? 1.1 : 0;
      if (state.lights) {
        state.lights.sun.intensity = on ? 0.5 : 2.2;
        state.lights.sky.intensity = on ? 0.5 : 1.6;
      }
      map.triggerRepaint();
    },
    get design() { return state.design; },
    get placement() { return state.placement; },
  };
}
