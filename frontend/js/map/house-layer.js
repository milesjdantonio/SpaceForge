// The building on the map: a three.js model built from a terrasim.design/2 record and placed at its
// real position and bearing. It rises out of a grid of tiles when it appears.

import * as THREE from 'three';
import { maplibregl } from './map.js';
import { openingSegment, pointInPolygon, bounds, renderable, centroid } from '../lib/design.js';

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
  design = renderable(design); // curved edges as short straight pieces
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
  } else if (roof.type === 'cone') {
    // A cone (a pyramid over straight sides) from the eaves all round up to one point over the
    // middle of the top level.
    const pts = topLevel.outline;
    const [cx, cy] = centroid(pts);
    const pitch = roof.pitch ?? 0.5;
    const reach = pts.reduce((s, [x, y]) => s + Math.hypot(x - cx, y - cy), 0) / pts.length;
    const zE = wallTop - eave * pitch, zR = wallTop + pitch * reach;
    const out = pts.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      return [cx + ((x - cx) * (d + eave)) / d, cy + ((y - cy) * (d + eave)) / d];
    });
    const verts = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      verts.push(a[0], a[1], zE, b[0], b[1], zE, cx, cy, zR);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, roofMat));
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
    if (ext.garage.polygon.length > 4) {
      // A garage shaped by a curved plan: its roof follows its shape; its door is an opening.
      prism(ext.garage.polygon, gh, gh + 0.35, roofMat);
    } else {
      box(gb.x1 - gb.x0 + 0.4, gb.y1 - gb.y0 + 0.4, 0.35, gb.x0 - 0.2, gb.y0 - 0.2, gh, roofMat);
      box((gb.x1 - gb.x0) * 0.8, 0.06, 2.3, gb.x0 + (gb.x1 - gb.x0) * 0.1, gb.y0 - 0.04, 0.05, trimMat);
    }
  }
  if (ext.porch?.polygon) {
    const pb = bounds(ext.porch.polygon);
    const pw = pb.x1 - pb.x0, pd = pb.y1 - pb.y0;
    prism(ext.porch.polygon, 0, 0.25, slabMat);
    box(pw, pd, 0.2, pb.x0, pb.y0, 2.7, roofMat);
    for (const t of [0, 1]) box(0.18, 0.18, 2.5, pb.x0 + t * (pw - 0.18), pb.y0, 0.2, accentMat);
  }
  for (const p of ext.parking || []) {
    prism(p.polygon, 0, 0.04, asphaltMat).userData.onGround = true;
    if (p.covered) {
      const pb = bounds(p.polygon);
      box(pb.x1 - pb.x0, pb.y1 - pb.y0, 0.2, pb.x0, pb.y0, 2.6, roofMat).userData.onGround = true;
    }
  }

  // On sloping land (exterior.foundation) the map, which is flat, shows the building raised by the
  // ground's fall, standing on what the design stands on: piers, a stepped footing, or its walkout
  // lower level.
  const fnd = design.exterior?.foundation;
  const lift = fnd && ['piers', 'stepped', 'walkout'].includes(fnd.type) && fnd.dropM >= 0.4 ? fnd.dropM : 0;
  if (lift) {
    for (const child of [...group.children]) if (!child.userData.onGround) child.position.z += lift; // parking stays on the ground
    const ground = levels.find((l) => l.elevationM >= 0) ?? levels[0];
    const footMat = mat('#9c968c', { roughness: 0.95 });
    if (fnd.type === 'piers') {
      // Pillars on a grid under the floor, no more than 3 m apart, inside the outline.
      const b = bounds(ground.outline);
      const nx = Math.max(2, Math.ceil((b.x1 - b.x0 - 0.6) / 3) + 1), ny = Math.max(2, Math.ceil((b.y1 - b.y0 - 0.6) / 3) + 1);
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const x = b.x0 + 0.3 + ((b.x1 - b.x0 - 0.6) * i) / (nx - 1), y = b.y0 + 0.3 + ((b.y1 - b.y0 - 0.6) * j) / (ny - 1);
          if (!pointInPolygon(x, y, ground.outline)) continue;
          box(0.32, 0.32, lift, x - 0.16, y - 0.16, 0, footMat);
        }
      }
      // A porch stands on two pillars at its outer corners.
      if (ext.porch?.polygon) {
        const pb = bounds(ext.porch.polygon);
        for (const x of [pb.x0 + 0.2, pb.x1 - 0.2]) box(0.28, 0.28, lift, x - 0.14, pb.y0 + 0.1, 0, footMat);
      }
      // A beam round the edge under the floor.
      for (let i = 0; i < ground.outline.length; i++) {
        const a = ground.outline[i], c = ground.outline[(i + 1) % ground.outline.length];
        along(a, c, lift - 0.35, lift, 0.25, 0, footMat);
      }
    } else {
      // A porch stands on the same footing.
      if (ext.porch?.polygon) prism(ext.porch.polygon, 0, lift, footMat);
      // A solid footing up to the floor (or to the walkout level's floor), with a line at each step.
      const lowest = Math.min(0, ...levels.map((l) => l.elevationM));
      const top = lift + lowest + 0.3;
      if (top > 0.05) {
        prism(ground.outline, 0, top, footMat);
        const lineMat = mat('#7d786f');
        for (let z = 0.6; z < top - 0.1; z += 0.6) {
          for (let i = 0; i < ground.outline.length; i++) {
            const a = ground.outline[i], c = ground.outline[(i + 1) % ground.outline.length];
            along(a, c, z - 0.03, z, 0.04, 0.02 * outward(a, c, ground.outline), lineMat);
          }
        }
      }
    }
  }
  group.userData = { glassMat, glassPanes, W: design.size.widthM, D: design.size.depthM, height: zTop(group), lift };
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
    materials.forEach((material) => { material.map?.dispose(); material.dispose(); });
    entry.scene?.clear();
  }

  function light(entry) {
    for (const [material, original] of entry.materials) {
      material.color.copy(original.color);
      material.emissive.copy(original.emissive);
      material.emissiveIntensity = material === entry.model.userData.glassMat ? (night ? 1.1 : 0) : original.intensity;
    }
    // A selected building keeps its own colours; a thin line round it on the ground shows it's chosen.
    if (entry.ring) entry.ring.visible = entry === selection;
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
    // The selection line: the ground floor's outline, just outside the walls.
    const ground = renderable(design).levels.find((l) => l.elevationM >= 0)?.outline;
    let ring = null;
    if (ground?.length >= 3) {
      const [gx, gy] = centroid(ground);
      const pts = ground.map(([x, y]) => {
        const d = Math.hypot(x - gx, y - gy) || 1;
        return new THREE.Vector3(gx + ((x - gx) * (d + 0.6)) / d, gy + ((y - gy) * (d + 0.6)) / d, 0.06);
      });
      ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
      ring.visible = false;
      scene.add(ring);
    }
    const moving = !!anim && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const entry = { id, design, placement, scene, sun, sky, model, materials, ring, rise: moving ? 0 : 1,
      riseStart: performance.now() + (typeof anim === 'number' ? anim : 0) };
    if (moving) {
      entry.fx = makeRiseFx(design);
      entry.tl = riseTimeline(design, model.userData.height);
      scene.add(entry.fx);
      for (const material of materials.keys()) { material.clippingPlanes = [UP]; material.needsUpdate = true; }
      model.visible = false;
    }
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
      renderer.localClippingEnabled = true; // the building's rise clips what's still below ground
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

  // ---- the building's arrival: it rises out of the land ------------------------------------------
  // Once the camera has arrived: a band of light sweeps across the ground and the tiles under it light
  // up, a ring pulses out, then the building rises out of the ground one floor at a time through a
  // glowing seam (everything below ground is clipped away), and lands with a second, wider ring and
  // a warm glow that fades. About five seconds; skipped for reduced motion.
  const RISE = { sweep: 0.9, build: 0.95, perFloor: 0.95, hold: 0.18, land: 1.1 };
  const AMBER = new THREE.Color('#ff8a2a'), WARM = new THREE.Color('#ffd27a');
  const UP = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // keeps z >= 0: nothing shows below ground

  function riseTimeline(design, height) {
    const levels = design.levels.filter((l) => l.elevationM >= 0);
    // Where each floor line sits as a share of the full height, so the rise pauses at each one.
    const stops = levels.slice(0, -1).map((l) => (l.elevationM + l.heightM + 0.3) / height).filter((x) => x > 0.05 && x < 0.95);
    const floors = stops.length + 1;
    const buildEnd = RISE.build + floors * RISE.perFloor + stops.length * RISE.hold;
    return { stops: [0, ...stops, 1], buildEnd, total: buildEnd + RISE.land };
  }

  // Emergence 0..1 at time s: each floor rises with an ease in and out, then holds for a moment.
  function emergence(tl, s) {
    let t = s - RISE.build;
    if (t <= 0) return { e: 0, step: -1, stepT: 0 };
    for (let i = 0; i < tl.stops.length - 1; i++) {
      const a = tl.stops[i], b = tl.stops[i + 1];
      if (t < RISE.perFloor) {
        const k = t / RISE.perFloor;
        const ease = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        return { e: a + (b - a) * ease, step: i, stepT: k };
      }
      t -= RISE.perFloor;
      if (i < tl.stops.length - 2) {
        if (t < RISE.hold) return { e: b, step: i, stepT: 1, holding: t / RISE.hold };
        t -= RISE.hold;
      }
    }
    return { e: 1, step: tl.stops.length - 2, stepT: 1 };
  }

  function makeRiseFx(design) {
    const W = design.size.widthM, D = design.size.depthM;
    const fx = new THREE.Group();
    const glow = (opacity = 1) => new THREE.MeshBasicMaterial({ color: AMBER.clone(), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

    // Tiles on the ground round the footprint; they light up as the sweep passes and sink as the
    // building comes up through them.
    const cell = Math.max(0.9, Math.min(1.6, Math.sqrt(W * D) / 14));
    const cells = [];
    for (let x = -3; x < W + 3; x += cell) {
      for (let y = -3; y < D + 3; y += cell) {
        const cx = x + cell / 2, cy = y + cell / 2;
        const inside = cx > 0 && cx < W && cy > 0 && cy < D;
        const edge = Math.min(Math.abs(cx), Math.abs(W - cx), Math.abs(cy), Math.abs(D - cy));
        cells.push({ x: cx, y: cy, inside, at: (y + 3) / (D + 6), h: inside ? 0.5 + Math.random() * 0.9 : Math.max(0.05, 0.35 - edge * 0.1), phase: Math.random() });
      }
    }
    const tileMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: AMBER.clone(), emissiveIntensity: 0.9, roughness: 0.5, transparent: true, opacity: 0.92 });
    const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(cell * 0.84, cell * 0.84, 1), tileMat, cells.length);
    const c = new THREE.Color();
    cells.forEach((cl, i) => tiles.setColorAt(i, c.set(GLOW[i % GLOW.length])));
    fx.add(tiles);

    // The sweep: a bright bar with a soft wide glow, front to back.
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(W + 8, 0.35), glow(1));
    const haze = new THREE.Mesh(new THREE.PlaneGeometry(W + 8, 3.2), glow(0.35));
    bar.position.set(W / 2, -4, 0.12);
    haze.position.set(W / 2, -4, 0.1);
    fx.add(bar, haze);

    // Two rings that pulse out from the footprint.
    const R = Math.hypot(W, D) / 2;
    const ring = () => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 128), glow(0));
      m.position.set(W / 2, D / 2, 0.08);
      m.scale.setScalar(R);
      m.visible = false;
      fx.add(m);
      return m;
    };
    const rings = [ring(), ring()];

    // The seam: a glowing band round the ground floor's outline, brightest at the ground, that the
    // building rises through.
    const outline = renderable(design).levels.find((l) => l.elevationM >= 0)?.outline ?? [[0, 0], [W, 0], [W, D], [0, D]];
    const SEAM = 2.4;
    // Pushed a little outside the walls, so the building doesn't hide it as it comes up.
    const ccw = outline.reduce((a, [x1, y1], i) => { const [x2, y2] = outline[(i + 1) % outline.length]; return a + x1 * y2 - x2 * y1; }, 0) > 0;
    const out = outline.map((p, i) => {
      const prev = outline[(i - 1 + outline.length) % outline.length], next = outline[(i + 1) % outline.length];
      const n = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return ccw ? [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] : [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; };
      const [n1x, n1y] = n(prev, p), [n2x, n2y] = n(p, next);
      return [p[0] + (n1x + n2x) * 0.09, p[1] + (n1y + n2y) * 0.09];
    });
    const pos = [], uv = [];
    for (let i = 0; i < out.length; i++) {
      const [ax, ay] = out[i], [bx, by] = out[(i + 1) % out.length];
      pos.push(ax, ay, 0, bx, by, 0, bx, by, SEAM, ax, ay, 0, bx, by, SEAM, ax, ay, SEAM);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    const seamGeo = new THREE.BufferGeometry();
    seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    seamGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const fade = document.createElement('canvas');
    fade.width = 4;
    fade.height = 64;
    const g2 = fade.getContext('2d');
    const grad = g2.createLinearGradient(0, 64, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = grad;
    g2.fillRect(0, 0, 4, 64);
    const seamMat = glow(0);
    seamMat.map = new THREE.CanvasTexture(fade);
    const seam = new THREE.Mesh(seamGeo, seamMat);
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outline.map(([x, y]) => new THREE.Vector3(x, y, 0.06))),
      new THREE.LineBasicMaterial({ color: WARM.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    fx.add(seam, line);

    fx.userData = { tiles, cells, bar, haze, rings, R, seam, line, D };
    fx.visible = false;
    return fx;
  }

  function animate(entry) {
    if (entry.rise >= 1) return;
    const s = (performance.now() - entry.riseStart) / 1000;
    const { model, fx, tl } = entry;
    if (s < 0) { model.visible = false; fx.visible = false; return; }
    fx.visible = true;
    const H = model.userData.height;
    const em = emergence(tl, s);
    const done = s >= tl.total;
    entry.rise = done ? 1 : Math.min(0.999, s / tl.total);
    const u = fx.userData;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const clamp = (x) => Math.max(0, Math.min(1, x));

    // The sweep runs front to back, then is gone.
    const sw = clamp(s / RISE.sweep);
    const swY = -4 + sw * (u.D + 8);
    u.bar.position.y = swY;
    u.haze.position.y = swY;
    u.bar.visible = u.haze.visible = sw < 1;

    // Tiles light up behind the sweep, flicker, and sink as the building passes them.
    const dummy = new THREE.Object3D();
    u.cells.forEach((cl, i) => {
      const lit = clamp((sw - cl.at) * 5);
      const sink = cl.inside ? clamp((em.e - 0.05) * 2.2 - cl.phase * 0.3) : clamp(((s - tl.buildEnd) / RISE.land) * 1.6 - cl.phase * 0.4);
      const h = Math.max(0.02, ease(lit) * cl.h * (0.85 + 0.15 * Math.sin(s * 9 + cl.phase * 6)) * (1 - ease(sink)));
      dummy.position.set(cl.x, cl.y, h / 2);
      dummy.scale.set(1, 1, h);
      dummy.updateMatrix();
      u.tiles.setMatrixAt(i, dummy.matrix);
    });
    u.tiles.instanceMatrix.needsUpdate = true;

    // Rings: one as the sweep ends, a wider one as the building lands.
    const pulse = (m, t0, len, spread) => {
      const k = (s - t0) / len;
      m.visible = k > 0 && k < 1;
      if (!m.visible) return;
      m.scale.setScalar(u.R * (1 + spread * ease(k)));
      m.material.opacity = 0.95 * (1 - k);
    };
    pulse(u.rings[0], RISE.sweep * 0.7, 1.1, 1.4);
    pulse(u.rings[1], tl.buildEnd - 0.1, 1.3, 2.6);

    // The building comes up through the ground.
    model.visible = em.e > 0;
    model.position.z = -(1 - em.e) * H;
    // The seam glows while it rises and flares each time a floor line comes through.
    const flare = em.holding != null ? 1 - em.holding : em.step >= 0 && em.stepT > 0.9 ? (em.stepT - 0.9) * 10 : 0;
    const seamOn = s < RISE.build ? clamp((s - RISE.sweep * 0.6) / 0.3) : s < tl.buildEnd ? 1 : 1 - clamp((s - tl.buildEnd) / RISE.land);
    u.seam.material.opacity = seamOn * (0.7 + 0.3 * flare);
    u.seam.scale.z = 1 + flare * 0.5;
    u.line.material.opacity = seamOn;
    // A warm glow on the building itself, fading as it lands.
    const warm = em.e > 0 ? 0.32 * (1 - clamp((s - tl.buildEnd) / RISE.land)) + flare * 0.15 : 0;
    for (const [material, original] of entry.materials) {
      if (material === model.userData.glassMat) continue;
      material.emissive.copy(original.emissive).lerp(AMBER, Math.min(1, warm * 2));
      material.emissiveIntensity = original.intensity + warm * 0.7;
    }

    if (done) {
      model.position.z = 0;
      model.visible = true;
      fx.visible = false;
      for (const material of entry.materials.keys()) { material.clippingPlanes = null; material.needsUpdate = true; }
      light(entry);
    }
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
    // `animate` is true, false, or a delay in ms before the rise starts (so the camera can arrive).
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
    // Milliseconds until the shown building's rise has finished (0 when it isn't rising).
    get riseRemaining() { return state.model && state.rise < 1 && state.tl ? Math.max(0, state.riseStart + state.tl.total * 1000 - performance.now()) : 0; },
    get design() { return state.design; },
    get placement() { return state.placement; },
  };
}
