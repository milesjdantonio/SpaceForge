// Draws one level of a terrasim.design/2 building as a floor plan (SVG), straight from its rooms,
// walls, openings, stairs, elevators and balconies. y = 0 is the building's front, drawn at the
// bottom of the sheet.

import { fmt } from '../format.js';
import { openingSegment, bounds, centroid, rectPoly } from '../lib/design.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

export function levelBounds(design) {
  const pts = [];
  for (const l of design.levels) {
    pts.push(...l.outline);
    for (const b of l.balconies || []) pts.push(...b.polygon);
  }
  if (design.exterior?.garage?.polygon) pts.push(...design.exterior.garage.polygon);
  if (design.exterior?.porch?.polygon) pts.push(...design.exterior.porch.polygon);
  const b = bounds(pts);
  return { minX: b.x0, maxX: b.x1, minY: b.y0, maxY: b.y1 };
}

// Rooms of one home share a tint, so homes read apart on a floor of apartments.
const TINTS = ['rgba(255,177,92,0.07)', 'rgba(120,180,255,0.07)', 'rgba(140,220,170,0.07)', 'rgba(230,150,220,0.07)'];

export function renderPlan(design, { level = 0, labels = true, dims = true, pad = 2.2, className = 'plan', title } = {}) {
  const lvl = design.levels[level] ?? design.levels[0];
  const b = levelBounds(design);
  const flip = ([x, y]) => [x, b.maxY - y + b.minY];
  const vb = [b.minX - pad, b.minY - pad - (dims ? 1.2 : 0), b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2 + (dims ? 1.6 : 0)];
  const svg = el('svg', { viewBox: vb.join(' '), class: className, role: 'img', 'aria-label': title ?? `${lvl.name} plan of ${design.overview?.title ?? 'the design'}` });
  const g = el('g', { class: 'plan-level' }, svg);
  const toPath = (poly) => 'M' + poly.map((p) => flip(p).map((v) => v.toFixed(3)).join(' ')).join(' L') + ' Z';
  const multi = (design.units || []).length > 1;
  const unitIdx = new Map((design.units || []).map((u, i) => [u.id, i]));

  // Garage, porch and parking on the ground floor; balconies on their level.
  const ext = design.exterior || {};
  if (lvl.elevationM === 0) {
    for (const p of ext.parking || []) el('path', { d: toPath(p.polygon), class: 'plan-porch' }, g);
    if (ext.garage?.polygon) {
      el('path', { d: toPath(ext.garage.polygon), class: 'plan-garage' }, g);
      const [cx, cy] = flip(centroid(ext.garage.polygon));
      if (labels) el('text', { x: cx, y: cy, class: 'plan-label plan-label-quiet', 'text-anchor': 'middle' }, g).textContent = `Garage · ${ext.garage.cars} car`;
    }
    if (ext.porch?.polygon) el('path', { d: toPath(ext.porch.polygon), class: 'plan-porch' }, g);
  }
  for (const bal of lvl.balconies || []) el('path', { d: toPath(bal.polygon), class: 'plan-porch' }, g);

  // Room fills.
  for (const r of lvl.rooms) {
    const fill = multi && r.unitId != null ? TINTS[unitIdx.get(r.unitId) % TINTS.length] : null;
    el('path', { d: toPath(r.polygon), class: `plan-room plan-room-${r.type}`, style: fill ? `fill:${fill}` : null, 'data-room': r.id }, g);
  }

  // Walls, as drawn lines at their thickness.
  const walls = el('g', { class: 'plan-walls' }, g);
  for (const w of lvl.walls || []) {
    const [x1, y1] = flip([w.x1, w.y1]), [x2, y2] = flip([w.x2, w.y2]);
    el('line', { x1, y1, x2, y2, class: `plan-wall plan-wall-${w.kind}`, 'stroke-width': w.thicknessM ?? 0.12 }, walls);
  }

  // Stairs: a rectangle with treads and an arrow pointing up from the access side.
  const here = (design.stairs || []).filter((s) => s.fromLevel === level || s.toLevel === level);
  const drawn = new Set();
  for (const s of here) {
    const k = `${s.x},${s.y},${s.widthM},${s.depthM}`;
    if (drawn.has(k)) continue;
    drawn.add(k);
    el('path', { d: toPath(rectPoly(s)), class: 'plan-stair' }, g);
    const across = s.accessSide === 'left' || s.accessSide === 'right';
    const n = Math.max(6, Math.round((across ? s.widthM : s.depthM) / 0.28));
    for (let t = 1; t < n; t++) {
      const f = t / n;
      const a = across ? [s.x + s.widthM * f, s.y] : [s.x, s.y + s.depthM * f];
      const c = across ? [s.x + s.widthM * f, s.y + s.depthM] : [s.x + s.widthM, s.y + s.depthM * f];
      const [ax, ay] = flip(a), [cx, cy] = flip(c);
      el('line', { x1: ax, y1: ay, x2: cx, y2: cy, class: 'plan-tread' }, g);
    }
    const mid = [s.x + s.widthM / 2, s.y + s.depthM / 2];
    const from = { front: [mid[0], s.y + 0.4], back: [mid[0], s.y + s.depthM - 0.4], left: [s.x + 0.4, mid[1]], right: [s.x + s.widthM - 0.4, mid[1]] }[s.accessSide] ?? mid;
    const to = { front: [mid[0], s.y + s.depthM - 0.5], back: [mid[0], s.y + 0.5], left: [s.x + s.widthM - 0.5, mid[1]], right: [s.x + 0.5, mid[1]] }[s.accessSide] ?? mid;
    const [ax, ay] = flip(from), [bx, by] = flip(to);
    el('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'plan-stair-arrow', 'marker-end': 'url(#arrow)' }, g);
  }
  // Elevators: a box with a cross.
  for (const e of design.elevators || []) {
    if (!e.levels.includes(level)) continue;
    const p = rectPoly(e).map(flip);
    el('path', { d: toPath(rectPoly(e)), class: 'plan-stair' }, g);
    el('line', { x1: p[0][0], y1: p[0][1], x2: p[2][0], y2: p[2][1], class: 'plan-tread' }, g);
    el('line', { x1: p[1][0], y1: p[1][1], x2: p[3][0], y2: p[3][1], class: 'plan-tread' }, g);
  }

  // Openings: a gap in the wall, then the symbol.
  const wallById = new Map((lvl.walls || []).map((w) => [w.id, w]));
  for (const o of lvl.openings || []) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const s = openingSegment(w, o);
    const [x1, y1] = flip([s.x1, s.y1]);
    const [x2, y2] = flip([s.x2, s.y2]);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.2) continue;
    el('line', { x1, y1, x2, y2, class: 'plan-gap', 'stroke-width': (w.thicknessM ?? 0.12) + 0.08 }, g);
    if (o.kind === 'window') {
      const nx = -(y2 - y1) / len * 0.09, ny = (x2 - x1) / len * 0.09;
      el('line', { x1: x1 + nx, y1: y1 + ny, x2: x2 + nx, y2: y2 + ny, class: 'plan-window' }, g);
      el('line', { x1: x1 - nx, y1: y1 - ny, x2: x2 - nx, y2: y2 - ny, class: 'plan-window' }, g);
    } else if (o.kind === 'door' || o.kind === 'entry' || o.kind === 'patio') {
      // Leaf and swing, opening into the first room it connects.
      const into = (o.connects || [])[0];
      const room = lvl.rooms.find((r) => r.id === into) ?? lvl.rooms.find((r) => r.id === (o.connects || [])[1]);
      const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
      let dir = 1;
      if (room) {
        const [rcx, rcy] = flip(centroid(room.polygon));
        dir = (rcx - (x1 + x2) / 2) * nx + (rcy - (y1 + y2) / 2) * ny > 0 ? 1 : -1;
      }
      const px = x1 + nx * len * dir, py = y1 + ny * len * dir;
      el('line', { x1, y1, x2: px, y2: py, class: `plan-door plan-door-${o.kind}` }, g);
      const sweep = ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) > 0 ? 1 : 0;
      el('path', { d: `M ${x2} ${y2} A ${len} ${len} 0 0 ${sweep} ${px} ${py}`, class: 'plan-swing' }, g);
    } else if (o.kind === 'garage') {
      el('line', { x1, y1, x2, y2, class: 'plan-door', 'stroke-dasharray': '0.2 0.12' }, g);
    }
  }

  // Labels: name and area, only where they fit.
  if (labels) {
    for (const r of lvl.rooms) {
      const rb = bounds(r.polygon);
      const w = rb.x1 - rb.x0, h = rb.y1 - rb.y0;
      if (w < 1.6 || h < 1.4) continue;
      const [cx, cy] = flip(centroid(r.polygon));
      const t = el('text', { x: cx, y: cy - 0.05, class: 'plan-label', 'text-anchor': 'middle' }, g);
      t.textContent = w < 2.6 && r.name.length > 9 ? r.name.split(' ')[0] : r.name;
      if (h > 2.2 && w > 2.2) {
        const a = el('text', { x: cx, y: cy + 0.55, class: 'plan-area', 'text-anchor': 'middle' }, g);
        a.textContent = fmt.area(r.areaM2);
      }
    }
    if (multi) {
      // Each home's name at its biggest room, above the room name.
      for (const u of design.units) {
        const rooms = lvl.rooms.filter((r) => r.unitId === u.id);
        if (!rooms.length) continue;
        const big = rooms.reduce((a, c) => (c.areaM2 > a.areaM2 ? c : a));
        const [cx, cy] = flip(centroid(big.polygon));
        el('text', { x: cx, y: cy - 0.75, class: 'plan-unit', 'text-anchor': 'middle' }, g).textContent = u.name.replace(/^Apartment /, '');
      }
    }
  }

  if (dims) {
    const W = design.size.widthM, Dp = design.size.depthM;
    const [fx1, fy] = flip([0, -0.9 + Math.min(0, b.minY)]);
    const [fx2] = flip([W, 0]);
    el('line', { x1: fx1, y1: fy, x2: fx2, y2: fy, class: 'plan-dim' }, g);
    el('line', { x1: fx1, y1: fy - 0.25, x2: fx1, y2: fy + 0.25, class: 'plan-dim' }, g);
    el('line', { x1: fx2, y1: fy - 0.25, x2: fx2, y2: fy + 0.25, class: 'plan-dim' }, g);
    el('text', { x: (fx1 + fx2) / 2, y: fy + 0.75, class: 'plan-dim-text', 'text-anchor': 'middle' }, g).textContent = fmt.len(W, { precise: true });
    const lx = flip([-0.9 + Math.min(0, b.minX), 0])[0];
    const [, ly1] = flip([0, 0]);
    const [, ly2] = flip([0, Dp]);
    el('line', { x1: lx, y1: ly1, x2: lx, y2: ly2, class: 'plan-dim' }, g);
    const tx = el('text', { x: lx - 0.45, y: (ly1 + ly2) / 2, class: 'plan-dim-text', 'text-anchor': 'middle', transform: `rotate(-90 ${lx - 0.45} ${(ly1 + ly2) / 2})` }, g);
    tx.textContent = fmt.len(Dp, { precise: true });
  }

  const defs = el('defs', {}, svg);
  const m = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M0 0 L10 5 L0 10 z', class: 'plan-arrowhead' }, m);
  return svg;
}
