// Draws one level of a terrasim.design/1 house as a blueprint floor plan (SVG). Works for any
// rooms given as polygons in house metres; y = 0 is the house's front (sun) side, drawn at the
// bottom of the sheet.

import { fmt } from '../format.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

const centroid = (poly) => {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
};
const bounds = (poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

export function levelBounds(design) {
  const pts = [];
  for (const l of design.levels) for (const r of l.rooms) pts.push(...r.polygon);
  if (design.garage) pts.push(...design.garage.polygon);
  if (design.porch) pts.push(...design.porch.polygon);
  return bounds(pts);
}

// options: { level, labels, dims, pad, highlight, interactive }
export function renderPlan(design, { level = 0, labels = true, dims = true, pad = 2.2, className = 'plan', title } = {}) {
  const lvl = design.levels[level] ?? design.levels[0];
  const b = levelBounds(design);
  const D = b.maxY;
  const flip = ([x, y]) => [x, D - y + b.minY];
  const vb = [b.minX - pad, b.minY - pad - (dims ? 1.2 : 0), b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2 + (dims ? 1.6 : 0)];
  const svg = el('svg', { viewBox: vb.join(' '), class: className, role: 'img', 'aria-label': title ?? `${lvl.name} plan of ${design.title}` });
  const g = el('g', { class: 'plan-level' }, svg);
  const toPath = (poly) => 'M' + poly.map((p) => flip(p).map((v) => v.toFixed(3)).join(' ')).join(' L') + ' Z';

  // Garage and porch outlines on the ground floor.
  if (level === 0 && design.garage) {
    el('path', { d: toPath(design.garage.polygon), class: 'plan-garage' }, g);
    const [cx, cy] = flip(centroid(design.garage.polygon));
    if (labels) el('text', { x: cx, y: cy, class: 'plan-label plan-label-quiet', 'text-anchor': 'middle' }, g).textContent = `Garage · ${design.garage.cars} car`;
  }
  if (level === 0 && design.porch) el('path', { d: toPath(design.porch.polygon), class: 'plan-porch' }, g);

  // Room fills, then walls.
  for (const r of lvl.rooms) {
    el('path', { d: toPath(r.polygon), class: `plan-room plan-room-${r.type}`, 'data-room': r.id }, g);
  }
  const walls = el('g', { class: 'plan-walls' }, g);
  for (const r of lvl.rooms) el('path', { d: toPath(r.polygon), class: 'plan-wall' }, walls);
  // Exterior wall drawn heavier.
  const fp = [[0, 0], [design.size.widthM, 0], [design.size.widthM, design.size.depthM], [0, design.size.depthM]];
  el('path', { d: toPath(fp), class: 'plan-exterior' }, walls);

  // Stairs: a rectangle with treads.
  for (const s of lvl.stairs || []) {
    el('path', { d: toPath(s.polygon), class: 'plan-stair' }, g);
    const sb = bounds(s.polygon);
    const treads = Math.max(6, Math.round((sb.maxY - sb.minY) / 0.28));
    for (let t = 1; t < treads; t++) {
      const y = sb.minY + ((sb.maxY - sb.minY) * t) / treads;
      const [x1, y1] = flip([sb.minX, y]);
      const [x2] = flip([sb.maxX, y]);
      el('line', { x1, y1, x2, y2: y1, class: 'plan-tread' }, g);
    }
    const [ax, ay] = flip([(sb.minX + sb.maxX) / 2, sb.minY + 0.4]);
    const [, by] = flip([0, sb.maxY - 0.5]);
    el('line', { x1: ax, y1: ay, x2: ax, y2: by, class: 'plan-stair-arrow', 'marker-end': 'url(#arrow)' }, g);
  }

  // Openings: a gap in the wall, then the symbol.
  for (const o of lvl.openings || []) {
    const [x1, y1] = flip([o.x1, o.y1]);
    const [x2, y2] = flip([o.x2, o.y2]);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.2) continue;
    el('line', { x1, y1, x2, y2, class: 'plan-gap' }, g);
    if (o.kind === 'window') {
      const nx = -(y2 - y1) / len * 0.09, ny = (x2 - x1) / len * 0.09;
      el('line', { x1: x1 + nx, y1: y1 + ny, x2: x2 + nx, y2: y2 + ny, class: 'plan-window' }, g);
      el('line', { x1: x1 - nx, y1: y1 - ny, x2: x2 - nx, y2: y2 - ny, class: 'plan-window' }, g);
    } else {
      // Door leaf and its swing arc, opening into the room on the +y side of the wall.
      const dir = o.kind === 'interior' ? 1 : -1;
      const px = x1 + (-(y2 - y1) / len) * len * dir * -1, py = y1 + ((x2 - x1) / len) * len * dir * -1;
      el('line', { x1, y1, x2: px, y2: py, class: `plan-door plan-door-${o.kind}` }, g);
      el('path', { d: `M ${x2} ${y2} A ${len} ${len} 0 0 ${dir > 0 ? 0 : 1} ${px} ${py}`, class: 'plan-swing' }, g);
    }
  }

  // Labels: name and area, only where they fit.
  if (labels) {
    for (const r of lvl.rooms) {
      const rb = bounds(r.polygon);
      const w = rb.maxX - rb.minX, h = rb.maxY - rb.minY;
      if (w < 1.6 || h < 1.4) continue;
      const [cx, cy] = flip(centroid(r.polygon));
      const t = el('text', { x: cx, y: cy - 0.05, class: 'plan-label', 'text-anchor': 'middle' }, g);
      t.textContent = w < 2.6 && r.name.length > 9 ? r.name.split(' ')[0] : r.name;
      if (h > 2.2 && w > 2.2) {
        const a = el('text', { x: cx, y: cy + 0.55, class: 'plan-area', 'text-anchor': 'middle' }, g);
        a.textContent = fmt.area(r.areaM2);
      }
    }
  }

  // Overall dimensions along the bottom (front) and left side.
  if (dims) {
    const W = design.size.widthM, Dp = design.size.depthM;
    const [fx1, fy] = flip([0, -0.9]);
    const [fx2] = flip([W, -0.9]);
    el('line', { x1: fx1, y1: fy, x2: fx2, y2: fy, class: 'plan-dim' }, g);
    el('line', { x1: fx1, y1: fy - 0.25, x2: fx1, y2: fy + 0.25, class: 'plan-dim' }, g);
    el('line', { x1: fx2, y1: fy - 0.25, x2: fx2, y2: fy + 0.25, class: 'plan-dim' }, g);
    el('text', { x: (fx1 + fx2) / 2, y: fy + 0.75, class: 'plan-dim-text', 'text-anchor': 'middle' }, g).textContent = fmt.len(W, { precise: true });
    const [lx, ly1] = flip([-0.9, 0]);
    const [, ly2] = flip([-0.9, Dp]);
    el('line', { x1: lx, y1: ly1, x2: lx, y2: ly2, class: 'plan-dim' }, g);
    const tx = el('text', { x: lx - 0.45, y: (ly1 + ly2) / 2, class: 'plan-dim-text', 'text-anchor': 'middle', transform: `rotate(-90 ${lx - 0.45} ${(ly1 + ly2) / 2})` }, g);
    tx.textContent = fmt.len(Dp, { precise: true });
  }

  const defs = el('defs', {}, svg);
  const m = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M0 0 L10 5 L0 10 z', class: 'plan-arrowhead' }, m);
  return svg;
}
