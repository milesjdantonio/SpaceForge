// Furniture for the walkthrough, built from the design's `furnishings` (contracts/FIELDS.md). Each item is
// made in its own frame: width along X, depth along Z, standing on y = 0, its front facing -Z.

import * as THREE from 'three';

const mat = (color, roughness = 0.8, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
const M = {
  fabric: mat(0x8c939b, 0.95),
  fabricWarm: mat(0xb9ab98, 0.95),
  cushion: mat(0xd8d0c4, 0.95),
  oak: mat(0xb08657, 0.6),
  walnut: mat(0x6b4a33, 0.55),
  white: mat(0xf2f0ec, 0.5),
  cabinet: mat(0x6f8072, 0.55),
  stone: mat(0xe6e2dc, 0.3),
  steel: mat(0xc9ccd0, 0.25, { metalness: 0.7 }),
  black: mat(0x1f2225, 0.4),
  screen: mat(0x0d0f12, 0.15, { metalness: 0.3 }),
  porcelain: mat(0xfbfbfa, 0.15),
  glass: new THREE.MeshStandardMaterial({ color: 0xdfeef5, roughness: 0.05, transparent: true, opacity: 0.25 }),
  mirror: mat(0xcfd8de, 0.05, { metalness: 0.9 }),
  linen: mat(0xf4f1ea, 0.9),
  duvet: mat(0xcfd6dc, 0.9),
  duvetWarm: mat(0xd9c7b0, 0.9),
  leaf: mat(0x4f7a46, 0.8),
  pot: mat(0xb9764f, 0.7),
  rugA: mat(0xb3a189, 1),
  rugB: mat(0x7e8c99, 1),
  rugC: mat(0xa66f5b, 1),
  lamp: new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffd9a0, emissiveIntensity: 0.9, roughness: 0.9 }),
  books: [mat(0x8a3b35), mat(0x2f4a6b), mat(0xc8a24b), mat(0x4d6b4a), mat(0xe8e1d4)],
};

function box(g, w, h, d, x, y, z, m) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  g.add(mesh);
  return mesh;
}
function cyl(g, rTop, rBot, h, x, y, z, m, seg = 20) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), m);
  mesh.position.set(x, y + h / 2, z);
  g.add(mesh);
  return mesh;
}
function legs(g, w, d, h, inset = 0.05, r = 0.025, m = M.walnut) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, r, r, h, sx * (w / 2 - inset), 0, sz * (d / 2 - inset), m, 10);
}

const BUILD = {
  sofa(g, w, d) {
    box(g, w, 0.18, d, 0, 0.08, 0, M.fabric);
    legs(g, w, d, 0.08, 0.06, 0.02, M.black);
    box(g, w, 0.55, 0.2, 0, 0.26, d / 2 - 0.1, M.fabric);
    for (const sx of [-1, 1]) box(g, 0.16, 0.36, d, sx * (w / 2 - 0.08), 0.26, 0, M.fabric);
    const n = Math.max(2, Math.round((w - 0.32) / 0.8));
    const cw = (w - 0.34) / n;
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + 0.17 + cw * (i + 0.5);
      box(g, cw - 0.02, 0.14, d - 0.26, x, 0.26, -0.08, M.cushion);
      box(g, cw - 0.06, 0.4, 0.14, x, 0.4, d / 2 - 0.26, M.fabricWarm);
    }
  },
  armchair(g, w, d) {
    box(g, w, 0.2, d, 0, 0.12, 0, M.fabricWarm);
    legs(g, w, d, 0.12, 0.06, 0.02, M.walnut);
    box(g, w, 0.5, 0.16, 0, 0.32, d / 2 - 0.08, M.fabricWarm);
    for (const sx of [-1, 1]) box(g, 0.13, 0.3, d, sx * (w / 2 - 0.065), 0.32, 0, M.fabricWarm);
    box(g, w - 0.3, 0.12, d - 0.24, 0, 0.32, -0.06, M.cushion);
  },
  'coffee-table'(g, w, d) { box(g, w, 0.04, d, 0, 0.38, 0, M.oak); legs(g, w, d, 0.38, 0.06, 0.02); box(g, w - 0.1, 0.02, d - 0.1, 0, 0.12, 0, M.oak); },
  'side-table'(g, w) { cyl(g, w / 2, w / 2, 0.03, 0, 0.52, 0, M.oak); cyl(g, 0.025, 0.025, 0.52, 0, 0, 0, M.black, 10); cyl(g, w / 3, w / 3, 0.02, 0, 0, 0, M.black); },
  rug(g, w, d, it) {
    const m = { 0: M.rugA, 1: M.rugB, 2: M.rugC }[Math.abs(Math.round(it.x * 7 + it.y * 3)) % 3];
    box(g, w, 0.012, d, 0, 0.004, 0, m);
  },
  'media-unit'(g, w, d) {
    box(g, w, 0.45, d, 0, 0.12, 0, M.walnut);
    legs(g, w, d, 0.12, 0.08, 0.02, M.black);
    box(g, Math.min(1.45, w - 0.2), 0.82, 0.04, 0, 0.95, d / 2 - 0.08, M.screen);
  },
  'dining-table'(g, w, d) { box(g, w, 0.04, d, 0, 0.72, 0, M.oak); legs(g, w, d, 0.72, 0.1, 0.03); },
  chair(g, w, d) {
    box(g, w, 0.04, d, 0, 0.44, 0, M.oak);
    legs(g, w, d, 0.44, 0.04, 0.016);
    box(g, w, 0.42, 0.03, 0, 0.48, d / 2 - 0.02, M.oak);
  },
  stool(g, w) { cyl(g, w / 2, w / 2, 0.05, 0, 0.7, 0, M.walnut); for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; cyl(g, 0.015, 0.015, 0.7, Math.cos(a) * w * 0.32, 0, Math.sin(a) * w * 0.32, M.black, 8); } },
  counter(g, w, d, it) {
    box(g, w, 0.86, d - 0.04, 0, 0.04, 0.02, M.cabinet);
    box(g, w, 0.04, d, 0, 0.9, 0, M.stone);
    for (let x = -w / 2 + 0.3; x < w / 2; x += 0.6) box(g, 0.012, 0.6, 0.01, x, 0.2, -d / 2 + 0.005, M.black);
    if (it.sink) { box(g, 0.6, 0.02, 0.4, 0, 0.93, 0.02, M.steel); cyl(g, 0.015, 0.015, 0.3, 0, 0.94, 0.22, M.steel, 8); }
    if (it.cooktop) { box(g, 0.7, 0.01, 0.5, 0, 0.94, 0, M.black); }
  },
  'upper-cabinets'(g, w, d) { box(g, w, 0.75, d, 0, 1.45, 0, M.white); },
  island(g, w, d) {
    box(g, w - 0.3, 0.88, d - 0.1, 0, 0.02, 0.0, M.cabinet);
    box(g, w, 0.04, d, 0, 0.9, 0, M.stone);
  },
  fridge(g, w, d) { box(g, w, 1.85, d, 0, 0, 0, M.steel); box(g, 0.02, 0.6, 0.03, w / 2 - 0.08, 0.95, -d / 2 - 0.01, M.black); box(g, w - 0.02, 0.01, 0.01, 0, 1.2, -d / 2 - 0.005, M.black); },
  bed(g, w, d, it) {
    box(g, w, 0.28, d, 0, 0.06, 0, M.walnut);
    legs(g, w, d, 0.06, 0.06, 0.03, M.walnut);
    box(g, w - 0.04, 0.22, d - 0.06, 0, 0.34, -0.02, M.linen);
    box(g, w + 0.02, 0.06, d * 0.62, 0, 0.56, -d * 0.17, it.size === 'twin' ? M.duvetWarm : M.duvet);
    const pillows = it.size === 'twin' ? 1 : 2;
    for (let i = 0; i < pillows; i++) box(g, (w - 0.2) / pillows - 0.06, 0.14, 0.36, -w / 2 + 0.1 + ((w - 0.2) / pillows) * (i + 0.5), 0.56, d / 2 - 0.3, M.white);
    box(g, w + 0.1, 1.0, 0.08, 0, 0.06, d / 2 + 0.02, M.fabric);
  },
  nightstand(g, w, d) { box(g, w, 0.5, d, 0, 0.05, 0, M.oak); legs(g, w, d, 0.05, 0.04, 0.015); cyl(g, 0.06, 0.08, 0.04, 0, 0.55, 0, M.black); cyl(g, 0.01, 0.01, 0.28, 0, 0.59, 0, M.black, 6); cyl(g, 0.08, 0.13, 0.18, 0, 0.82, 0, M.lamp); },
  dresser(g, w, d) {
    box(g, w, 0.8, d, 0, 0.08, 0, M.walnut);
    legs(g, w, d, 0.08, 0.06, 0.02, M.black);
    for (let i = 1; i < 3; i++) box(g, w - 0.04, 0.008, 0.01, 0, 0.08 + (0.8 * i) / 3, -d / 2 - 0.004, M.black);
    box(g, 0.7, 0.85, 0.03, 0, 1.2, d / 2 - 0.05, M.mirror);
  },
  wardrobe(g, w, d) { box(g, w, 2.1, d, 0, 0, 0, M.white); box(g, 0.01, 2.0, 0.01, 0, 0.05, -d / 2 - 0.005, M.black); for (const sx of [-1, 1]) box(g, 0.02, 0.35, 0.02, sx * 0.06, 1.0, -d / 2 - 0.015, M.steel); },
  desk(g, w, d) { box(g, w, 0.035, d, 0, 0.73, 0, M.oak); for (const sx of [-1, 1]) box(g, 0.04, 0.73, d - 0.06, sx * (w / 2 - 0.04), 0, 0, M.black); box(g, 0.5, 0.32, 0.03, 0, 0.8, d / 2 - 0.12, M.screen); },
  'office-chair'(g, w) { cyl(g, w / 2.4, w / 2.4, 0.07, 0, 0.45, 0, M.black); cyl(g, 0.03, 0.03, 0.4, 0, 0.05, 0, M.steel, 8); cyl(g, w / 2.2, w / 2.2, 0.04, 0, 0.02, 0, M.black, 5); box(g, w * 0.7, 0.45, 0.05, 0, 0.55, w / 2.6, M.black); },
  bookshelf(g, w, d, it) {
    const h = it.h ?? 1.9;
    for (const sx of [-1, 1]) box(g, 0.025, h, d, sx * (w / 2 - 0.0125), 0, 0, M.oak);
    const shelves = Math.max(3, Math.round(h / 0.38));
    for (let i = 0; i <= shelves; i++) box(g, w, 0.025, d, 0, (h - 0.025) * (i / shelves), 0, M.oak);
    // A few rows of books.
    let seed = Math.abs(Math.round(it.x * 13 + it.y * 7));
    for (let i = 0; i < shelves; i++) {
      let x = -w / 2 + 0.05;
      while (x < w / 2 - 0.1) {
        seed = (seed * 9301 + 49297) % 233280;
        const bw = 0.025 + (seed % 30) / 1000, bh = 0.2 + (seed % 9) / 100;
        if (seed % 7 !== 0) box(g, bw, bh, d * 0.75, x + bw / 2, (h - 0.025) * (i / shelves) + 0.025, 0, M.books[seed % 5]);
        x += bw + 0.004;
      }
    }
  },
  bench(g, w, d) { box(g, w, 0.05, d, 0, 0.42, 0, M.oak); legs(g, w, d, 0.42, 0.06, 0.02); box(g, w - 0.08, 0.06, d - 0.06, 0, 0.47, 0, M.cushion); },
  cabinet(g, w, d, it) { const h = it.h ?? 0.9; box(g, w, h, d, 0, 0, 0, M.white); box(g, w, 0.03, d + 0.02, 0, h, 0, M.oak); },
  console(g, w, d) { box(g, w, 0.04, d, 0, 0.78, 0, M.walnut); legs(g, w, d, 0.78, 0.04, 0.015, M.black); cyl(g, 0.08, 0.1, 0.25, w / 3, 0.82, 0, M.pot); },
  shelves(g, w, d) { for (let i = 0; i < 5; i++) box(g, w, 0.025, d, 0, i * 0.45 + 0.2, 0, M.white); for (let i = 0; i < 4; i++) box(g, w - 0.1, 0.12, d - 0.06, 0, i * 0.45 + 0.225, 0, M.linen); },
  toilet(g, w, d) { box(g, w, 0.4, d * 0.55, 0, 0, -d * 0.1, M.porcelain); box(g, w, 0.4, 0.18, 0, 0.38, d / 2 - 0.09, M.porcelain); box(g, w + 0.02, 0.03, d * 0.6, 0, 0.4, -d * 0.12, M.porcelain); },
  vanity(g, w, d, it) {
    box(g, w, 0.8, d, 0, 0.05, 0, M.walnut);
    box(g, w, 0.04, d + 0.02, 0, 0.85, 0, M.stone);
    const sinks = it.double ? 2 : 1;
    for (let i = 0; i < sinks; i++) {
      const x = -w / 2 + (w / sinks) * (i + 0.5);
      box(g, 0.4, 0.02, 0.3, x, 0.885, -0.02, M.porcelain);
      cyl(g, 0.012, 0.012, 0.22, x, 0.89, d / 2 - 0.08, M.steel, 8);
    }
    box(g, w * 0.85, 0.8, 0.03, 0, 1.2, d / 2 + 0.01, M.mirror);
  },
  bathtub(g, w, d) { box(g, w, 0.55, d, 0, 0, 0, M.porcelain); box(g, w - 0.14, 0.02, d - 0.14, 0, 0.54, 0, mat(0xdbe9ef, 0.1)); },
  shower(g, w, d) {
    box(g, w, 0.06, d, 0, 0, 0, M.porcelain);
    box(g, 0.02, 2.0, d, -w / 2, 0.06, 0, M.glass);
    box(g, w, 2.0, 0.02, 0, 0.06, -d / 2, M.glass);
    cyl(g, 0.12, 0.12, 0.02, 0, 2.05, d / 2 - 0.2, M.steel);
  },
  washer(g, w, d) { box(g, w, 0.85, d, 0, 0, 0, M.white); const door = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 28), M.steel); door.rotation.x = Math.PI / 2; door.position.set(0, 0.45, -d / 2 - 0.01); g.add(door); const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 28), M.screen); glass.rotation.x = Math.PI / 2; glass.position.set(0, 0.45, -d / 2 - 0.02); g.add(glass); },
  dryer(g, w, d) { BUILD.washer(g, w, d); },
  plant(g, w) {
    cyl(g, w * 0.32, w * 0.24, 0.38, 0, 0, 0, M.pot);
    const r = w * 0.42;
    for (const [x, y, z, s] of [[0, 0.72, 0, 1], [0.12, 0.6, 0.08, 0.7], [-0.1, 0.62, -0.06, 0.75], [0.04, 0.9, -0.05, 0.6]]) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1), M.leaf);
      m.position.set(x * w * 2, y, z * w * 2);
      g.add(m);
    }
  },
  'floor-lamp'(g, w) { cyl(g, w / 2.5, w / 2.5, 0.03, 0, 0, 0, M.black); cyl(g, 0.012, 0.012, 1.45, 0, 0.03, 0, M.black, 8); cyl(g, 0.14, 0.2, 0.26, 0, 1.4, 0, M.lamp); },
  pendant(g, w, d, it, ceiling) {
    const drop = it.wide ? 0.75 : 0.85;
    cyl(g, 0.004, 0.004, drop, 0, ceiling - drop, 0, M.black, 4);
    cyl(g, w * 0.15, w / 2, it.wide ? 0.14 : 0.22, 0, ceiling - drop - (it.wide ? 0.14 : 0.22), 0, M.lamp);
  },
};

// Builds one level's furnishings into a group, placed and turned in house metres.
export function buildFurnishings(level, { ceiling = 2.75 } = {}) {
  const group = new THREE.Group();
  for (const it of level.furnishings || []) {
    const make = BUILD[it.type];
    if (!make) continue;
    const g = new THREE.Group();
    make(g, it.w, it.d, it, ceiling);
    g.position.set(it.x, level.elevationM, it.y);
    // rotationDeg 0 faces the house front (-Z here); 90 faces +x.
    g.rotation.y = -((it.rotationDeg || 0) * Math.PI) / 180;
    g.userData = { furnishing: it.type };
    group.add(g);
  }
  return group;
}

export const FURNISHING_TYPES = Object.keys(BUILD);
