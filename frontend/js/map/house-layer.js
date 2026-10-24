// The house on the map: a three.js model built from a terrasim.design/1 record and placed at its
// real position and bearing. It rises out of a grid of tiles when it appears.

import * as THREE from 'three';
import { maplibregl } from './map.js';

const DEFAULTS = { walls: '#e9e4da', roof: '#4a4f55', trim: '#2b2f33', glass: '#5d7c99' };

function paletteColors(design) {
  const out = { ...DEFAULTS };
  for (const p of design.materials?.palette ?? []) {
    const use = (p.use || '').toLowerCase();
    if (use.includes('wall')) out.walls = p.hex;
    else if (use.includes('roof')) out.roof = p.hex;
    else if (use.includes('window') || use.includes('trim')) out.trim = p.hex;
  }
  return out;
}

// Builds the model in house metres: x along the width, y along the depth (0 = front), z up.
export function buildHouseModel(design) {
  const group = new THREE.Group();
  const colors = paletteColors(design);
  const W = design.size.widthM, D = design.size.depthM;
  const levels = design.levels;
  const wallTop = levels.reduce((m, l) => Math.max(m, l.elevationM + l.heightM), 0);
  const mat = (hex, extra = {}) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide, ...extra });
  const wallMat = mat(colors.walls);
  const roofMat = mat(colors.roof, { roughness: 0.7 });
  const trimMat = mat(colors.trim);
  const glassMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.glass), roughness: 0.15, metalness: 0.4, emissive: new THREE.Color('#ffb15c'), emissiveIntensity: 0 });
  const slabMat = mat('#bfb8ab');

  const box = (w, d, h, x, y, z, m) => {
    const g = new THREE.BoxGeometry(w, d, h);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x + w / 2, y + d / 2, z + h / 2);
    group.add(mesh);
    return mesh;
  };

  // Plinth and walls.
  box(W + 0.3, D + 0.3, 0.35, -0.15, -0.15, -0.05, slabMat);
  box(W, D, wallTop, 0, 0, 0.3, wallMat);
  // Floor bands between storeys.
  for (const l of levels.slice(1)) box(W + 0.06, D + 0.06, 0.16, -0.03, -0.03, l.elevationM + 0.22, trimMat);

  // Windows and doors on the outside walls.
  const onEdge = (o) => {
    const eps = 0.05;
    if (Math.abs(o.y1) < eps && Math.abs(o.y2) < eps) return 'front';
    if (Math.abs(o.y1 - D) < eps && Math.abs(o.y2 - D) < eps) return 'back';
    if (Math.abs(o.x1) < eps && Math.abs(o.x2) < eps) return 'left';
    if (Math.abs(o.x1 - W) < eps && Math.abs(o.x2 - W) < eps) return 'right';
    return null;
  };
  const glassPanes = [];
  for (const l of levels) {
    for (const o of l.openings || []) {
      const side = onEdge(o);
      if (!side) continue;
      const isWindow = o.kind === 'window';
      const z0 = l.elevationM + 0.3 + (isWindow ? (o.sillM ?? 0.8) : 0.02);
      const z1 = l.elevationM + 0.3 + (isWindow ? (o.headM ?? 2.2) : 2.15);
      const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      const depth = 0.08;
      const m = isWindow || o.kind === 'patio' ? glassMat : trimMat;
      let pane;
      if (side === 'front') pane = box(len, depth, z1 - z0, Math.min(o.x1, o.x2), -depth / 2 - 0.02, z0, m);
      if (side === 'back') pane = box(len, depth, z1 - z0, Math.min(o.x1, o.x2), D - depth / 2 + 0.02, z0, m);
      if (side === 'left') pane = box(depth, len, z1 - z0, -depth / 2 - 0.02, Math.min(o.y1, o.y2), z0, m);
      if (side === 'right') pane = box(depth, len, z1 - z0, W - depth / 2 + 0.02, Math.min(o.y1, o.y2), z0, m);
      if (pane && m === glassMat) glassPanes.push(pane);
      // A frame around each window.
      if (pane && isWindow) {
        const f = 0.07;
        const horizontal = side === 'front' || side === 'back';
        const yFace = side === 'front' ? -0.07 : side === 'back' ? D - 0.01 : null;
        const xFace = side === 'left' ? -0.07 : side === 'right' ? W - 0.01 : null;
        if (horizontal) {
          box(len + 2 * f, 0.08, f, Math.min(o.x1, o.x2) - f, yFace, z0 - f, trimMat);
          box(len + 2 * f, 0.08, f, Math.min(o.x1, o.x2) - f, yFace, z1, trimMat);
        } else {
          box(0.08, len + 2 * f, f, xFace, Math.min(o.y1, o.y2) - f, z0 - f, trimMat);
          box(0.08, len + 2 * f, f, xFace, Math.min(o.y1, o.y2) - f, z1, trimMat);
        }
      }
    }
  }

  // Roof.
  const roof = design.roof ?? { type: 'gable', pitch: 0.6, eaveM: 0.5 };
  const eave = roof.eaveM ?? 0.5;
  const top = wallTop + 0.3;
  if (roof.type === 'flat') {
    box(W + 0.2, D + 0.2, 0.5, -0.1, -0.1, top, roofMat);
  } else {
    const rise = Math.max(0.6, (roof.pitch ?? 0.6) * (D / 2 + eave));
    const x0 = -eave, x1 = W + eave, y0 = -eave, y1 = D + eave, ym = D / 2;
    const zE = top - eave * (roof.pitch ?? 0.6), zR = top + rise - eave * (roof.pitch ?? 0.6);
    const g = new THREE.BufferGeometry();
    let verts;
    if (roof.type === 'hip') {
      const inset = Math.min((x1 - x0) / 2 - 0.1, (y1 - y0) / 2);
      const r0 = [x0 + inset, ym, zR], r1 = [x1 - inset, ym, zR];
      const a = [x0, y0, zE], b = [x1, y0, zE], c = [x1, y1, zE], d = [x0, y1, zE];
      verts = [...a, ...b, ...r1, ...a, ...r1, ...r0, ...c, ...d, ...r0, ...c, ...r0, ...r1, ...b, ...c, ...r1, ...d, ...a, ...r0];
    } else {
      const a = [x0, y0, zE], b = [x1, y0, zE], c = [x1, y1, zE], d = [x0, y1, zE];
      const r0 = [x0, ym, zR], r1 = [x1, ym, zR];
      verts = [...a, ...b, ...r1, ...a, ...r1, ...r0, ...c, ...d, ...r0, ...c, ...r0, ...r1];
      // Gable ends (walls up to the ridge).
      const ge = new THREE.BufferGeometry();
      ge.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, top, 0, D, top, 0, ym, zR - 0.15, W, 0, top, W, D, top, W, ym, zR - 0.15], 3));
      ge.computeVertexNormals();
      group.add(new THREE.Mesh(ge, wallMat));
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, roofMat));
  }

  // Garage and porch.
  if (design.garage) {
    const gp = design.garage.polygon;
    const gx = Math.min(...gp.map((p) => p[0])), gy = Math.min(...gp.map((p) => p[1]));
    const gw = Math.max(...gp.map((p) => p[0])) - gx, gd = Math.max(...gp.map((p) => p[1])) - gy;
    box(gw, gd, 3.0, gx, gy, 0, wallMat);
    box(gw + 0.4, gd + 0.4, 0.35, gx - 0.2, gy - 0.2, 3.0, roofMat);
    box(gw * 0.8, 0.06, 2.3, gx + gw * 0.1, gy - 0.04, 0.05, trimMat);
  }
  if (design.porch) {
    const pp = design.porch.polygon;
    const px = Math.min(...pp.map((p) => p[0])), py = Math.min(...pp.map((p) => p[1]));
    const pw = Math.max(...pp.map((p) => p[0])) - px, pd = Math.max(...pp.map((p) => p[1])) - py;
    box(pw, pd, 0.25, px, py, 0, slabMat);
    box(pw, pd, 0.2, px, py, 2.7, roofMat);
    for (const t of [0, 1]) box(0.18, 0.18, 2.5, px + t * (pw - 0.18), py + pd - 0.18, 0.2, trimMat);
  }

  group.userData = { glassMat, glassPanes, W, D, height: zTop(group) };
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
