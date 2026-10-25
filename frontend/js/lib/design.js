// Reading a terrasim.design/2 file (contracts/FIELDS.md, Part 2): the checks the website runs before
// drawing it, and small helpers the renderers share. Nothing here invents or repairs a design; a file
// that breaks a rule is reported, not fixed.

export const SCHEMA = 'terrasim.design/2';

// ---- curves --------------------------------------------------------------------------------------
// An outline or room edge, or a wall, may follow an ellipse { cx, cy, rx, ry } (axes along x and y)
// from one end to the other, the short way round (FIELDS.md, "Curved walls"). A curved polygon edge
// is a third item on the vertex it starts from: [x, y, { cx, cy, rx, ry }].

const ARC_STEP = 0.25; // longest straight piece when a curve is drawn or measured

// Points along the curve from a to b, both ends included.
export function arcPoints(a, b, arc) {
  const t0 = Math.atan2((a[1] - arc.cy) / arc.ry, (a[0] - arc.cx) / arc.rx);
  let d = Math.atan2((b[1] - arc.cy) / arc.ry, (b[0] - arc.cx) / arc.rx) - t0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((Math.abs(d) * Math.max(arc.rx, arc.ry)) / ARC_STEP));
  const out = [[a[0], a[1]]];
  for (let i = 1; i < n; i++) { const t = t0 + (d * i) / n; out.push([arc.cx + arc.rx * Math.cos(t), arc.cy + arc.ry * Math.sin(t)]); }
  out.push([b[0], b[1]]);
  return out;
}

const isArc = (a) => a && typeof a === 'object' && !Array.isArray(a) && [a.cx, a.cy, a.rx, a.ry].every((v) => typeof v === 'number') && a.rx > 0 && a.ry > 0;

// A polygon with every curved edge sampled into short straight pieces (the same array when none).
export function flatPoly(poly) {
  if (!Array.isArray(poly) || !poly.some((q) => isArc(q?.[2]))) return poly;
  const out = [];
  poly.forEach((q, i) => {
    out.push([q[0], q[1]]);
    if (isArc(q[2])) out.push(...arcPoints(q, poly[(i + 1) % poly.length], q[2]).slice(1, -1));
  });
  return out;
}

// A wall's centre line as points: its two ends, or its curve sampled.
export const wallPath = (w) => (isArc(w.arc) ? arcPoints([w.x1, w.y1], [w.x2, w.y2], w.arc) : [[w.x1, w.y1], [w.x2, w.y2]]);

const lengths = new WeakMap();
export function wallLength(w) {
  if (!isArc(w.arc)) return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  if (!lengths.has(w)) {
    const p = wallPath(w);
    let s = 0;
    for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    lengths.set(w, s);
  }
  return lengths.get(w);
}

// The point s metres along a wall from its (x1, y1) end.
export function wallPointAt(w, s) {
  const p = wallPath(w);
  for (let i = 1; i < p.length; i++) {
    const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (s <= l || i === p.length - 1) {
      const t = l ? Math.max(0, Math.min(1, s / l)) : 0;
      return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
    }
    s -= l;
  }
  return p[p.length - 1];
}

// The design with every curved polygon sampled, for drawing and checking. Walls keep their curves
// (openings are measured along them). The file itself is never changed, so saving and sharing keep
// the exact curves. Designs without curves come back as they are.
const views = new WeakMap();
export function renderable(design) {
  if (!design?.levels) return design;
  if (views.has(design)) return views.get(design);
  const curved = design.levels.some((l) => flatPoly(l.outline) !== l.outline || (l.rooms || []).some((r) => flatPoly(r.polygon) !== r.polygon));
  const view = !curved ? design : {
    ...design,
    levels: design.levels.map((l) => ({
      ...l,
      outline: flatPoly(l.outline),
      rooms: (l.rooms || []).map((r) => ({ ...r, polygon: flatPoly(r.polygon) })),
      balconies: (l.balconies || []).map((b) => ({ ...b, polygon: flatPoly(b.polygon) })),
    })),
  };
  views.set(design, view);
  if (view !== design) views.set(view, view);
  return view;
}

// ---- geometry helpers ---------------------------------------------------------------------------

// The segment an opening occupies, worked out from its wall, offset and width. On a curved wall it
// is the straight line between its two ends along the curve.
export function openingSegment(wall, o) {
  const len = wallLength(wall) || 1;
  const a = o.offsetM, b = o.offsetM + o.widthM;
  if (isArc(wall.arc)) {
    const p = wallPointAt(wall, a), q = wallPointAt(wall, b);
    return { x1: p[0], y1: p[1], x2: q[0], y2: q[1], t0: a / len, t1: b / len };
  }
  const ux = (wall.x2 - wall.x1) / len, uy = (wall.y2 - wall.y1) / len;
  return { x1: wall.x1 + ux * a, y1: wall.y1 + uy * a, x2: wall.x1 + ux * b, y2: wall.y1 + uy * b, t0: a / len, t1: b / len };
}

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function pointInPolygon(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
  }
  return inside;
}

export function bounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

export function centroid(poly) {
  // Area centroid, so L-shaped rooms label in their body rather than their corner.
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [cx / (3 * a), cy / (3 * a)];
}

export const roomAt = (level, x, y) => level.rooms.find((r) => pointInPolygon(x, y, r.polygon)) ?? null;

// Stair and elevator rectangles as polygons.
export const rectPoly = (s) => [[s.x, s.y], [s.x + s.widthM, s.y], [s.x + s.widthM, s.y + s.depthM], [s.x, s.y + s.depthM]];

// Stair-shaped holes in a level's floor: every stair arriving from below.
export const stairsArriving = (design, li) => (design.stairs || []).filter((s) => s.toLevel === li);
export const stairsLeaving = (design, li) => (design.stairs || []).filter((s) => s.fromLevel === li);

// Lookups built once per design.
export function index(design) {
  const ids = new Map();
  const add = (id, what) => { if (id != null) ids.set(id, what); };
  for (const u of design.units || []) add(u.id, { kind: 'unit', item: u });
  design.levels.forEach((l, li) => {
    for (const r of l.rooms || []) add(r.id, { kind: 'room', item: r, level: li });
    for (const w of l.walls || []) add(w.id, { kind: 'wall', item: w, level: li });
    for (const o of l.openings || []) add(o.id, { kind: 'opening', item: o, level: li });
    for (const b of l.balconies || []) add(b.id, { kind: 'balcony', item: b, level: li });
  });
  for (const s of design.stairs || []) add(s.id, { kind: 'stair', item: s });
  for (const e of design.elevators || []) add(e.id, { kind: 'elevator', item: e });
  return ids;
}

// ---- checks -------------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoly = (p) => Array.isArray(p) && p.length >= 3 && p.every((q) => Array.isArray(q) && isNum(q[0]) && isNum(q[1]));

// Returns { ok, errors: [{ rule, message }], warnings: [...] }. Messages are written for the person
// looking at the result, and say where the problem is.
export function checkDesign(d) {
  const errors = [], warnings = [];
  const err = (rule, message) => errors.push({ rule, message });
  const warn = (rule, message) => warnings.push({ rule, message });
  if (!d || typeof d !== 'object') return { ok: false, errors: [{ rule: 0, message: 'The design file is empty.' }], warnings };
  if (d.schema !== SCHEMA) err(0, `The design file is “${d.schema ?? 'unknown'}”; this website draws “${SCHEMA}”.`);

  // Required structure.
  const need = [['overview.title', d.overview?.title], ['size.widthM', d.size?.widthM], ['size.depthM', d.size?.depthM], ['placement.origin', d.placement?.origin], ['placement.xAxisBearingDeg', d.placement?.xAxisBearingDeg]];
  for (const [path, v] of need) if (v == null) err(0, `The design is missing ${path}.`);
  if (!Array.isArray(d.levels) || !d.levels.length) err(0, 'The design has no levels.');
  if (!isPoly(d.placement?.footprint)) err(0, 'placement.footprint needs the building’s [lng, lat] outline (at least three points).');
  if (errors.length) return { ok: false, errors, warnings };
  // Curved edges are checked as the short straight pieces they're drawn with.
  d = renderable(d);

  // Rule 1: ids are unique and references resolve.
  const seen = new Map();
  const note = (id, where) => {
    if (id == null) { err(1, `Something in ${where} has no id.`); return; }
    if (seen.has(id)) err(1, `The id “${id}” is used twice (${seen.get(id)} and ${where}).`);
    else seen.set(id, where);
  };
  for (const u of d.units || []) note(u.id, 'units');
  d.levels.forEach((l, li) => {
    for (const r of l.rooms || []) note(r.id, `level ${li} rooms`);
    for (const w of l.walls || []) note(w.id, `level ${li} walls`);
    for (const o of l.openings || []) note(o.id, `level ${li} openings`);
    for (const b of l.balconies || []) note(b.id, `level ${li} balconies`);
  });
  for (const s of d.stairs || []) note(s.id, 'stairs');
  for (const e of d.elevators || []) note(e.id, 'elevators');
  const ids = index(d);
  const isUnit = (id) => ids.get(id)?.kind === 'unit';

  const W = d.size.widthM, D = d.size.depthM;
  const maxLevel = d.levels.length - 1;
  d.levels.forEach((l, li) => {
    const name = l.name || `level ${li}`;
    if (l.index !== li) warn(0, `${name} has index ${l.index} but is item ${li} in the list.`);
    if (!isNum(l.elevationM) || !isNum(l.heightM)) err(0, `${name} needs elevationM and heightM.`);
    // Rule 2: the outline fits in size; rooms fill it without overlapping.
    if (!isPoly(l.outline)) { err(2, `${name} has no outline.`); return; }
    const ob = bounds(l.outline);
    if (ob.x0 < -0.05 || ob.y0 < -0.05 || ob.x1 > W + 0.05 || ob.y1 > D + 0.05) err(2, `${name}’s outline goes outside the building’s ${W} × ${D} m size.`);
    const outlineArea = polygonArea(l.outline);
    let roomsArea = 0;
    for (const r of l.rooms || []) {
      if (!isPoly(r.polygon)) { err(2, `Room ${r.id} on ${name} has no polygon.`); continue; }
      roomsArea += polygonArea(r.polygon);
      if (r.unitId != null && !isUnit(r.unitId)) err(1, `Room ${r.id} belongs to “${r.unitId}”, which isn’t in units.`);
      const [cx, cy] = centroid(r.polygon);
      if (!pointInPolygon(cx, cy, l.outline)) err(2, `Room ${r.id} (${r.name}) is outside ${name}’s outline.`);
    }
    if (Math.abs(roomsArea - outlineArea) > Math.max(1.5, outlineArea * 0.03)) {
      (roomsArea > outlineArea ? err : warn)(2, `${name}: rooms cover ${roomsArea.toFixed(1)} m² of a ${outlineArea.toFixed(1)} m² floor${roomsArea > outlineArea ? ', so some overlap' : ', leaving gaps'}.`);
    }
    // Rule 3: openings fit their walls; their rooms exist.
    const walls = new Map((l.walls || []).map((w) => [w.id, w]));
    for (const w of l.walls || []) {
      if (![w.x1, w.y1, w.x2, w.y2].every(isNum)) err(3, `Wall ${w.id} on ${name} is missing an end.`);
      else if (wallLength(w) < 0.05) warn(3, `Wall ${w.id} on ${name} has no length.`);
    }
    for (const o of l.openings || []) {
      const w = walls.get(o.wallId);
      if (!w) { err(1, `Opening ${o.id} on ${name} sits in wall “${o.wallId}”, which isn’t on that level.`); continue; }
      if (!isNum(o.offsetM) || !isNum(o.widthM) || o.widthM <= 0) { err(3, `Opening ${o.id} needs offsetM and widthM.`); continue; }
      if (o.offsetM < -0.01 || o.offsetM + o.widthM > wallLength(w) + 0.02) err(3, `Opening ${o.id} (${o.widthM} m at ${o.offsetM} m) doesn’t fit wall ${w.id}, which is ${wallLength(w).toFixed(2)} m long.`);
      for (const c of o.connects || []) {
        if (c !== 'outside' && ids.get(c)?.kind !== 'room') err(1, `Opening ${o.id} connects to “${c}”, which isn’t a room.`);
      }
    }
    for (const b of l.balconies || []) if (b.unitId != null && !isUnit(b.unitId)) err(1, `Balcony ${b.id} belongs to “${b.unitId}”, which isn’t in units.`);
    for (const f of l.furnishings || []) if (f.roomId != null && ids.get(f.roomId)?.kind !== 'room') warn(1, `A ${f.type} sits in room “${f.roomId}”, which isn’t on the plan.`);
  });

  // Rule 5: each home has one entry opening.
  for (const u of d.units || []) {
    const o = ids.get(u.entryOpeningId);
    if (!o || o.kind !== 'opening') err(5, `${u.name || u.id} has no entry opening (“${u.entryOpeningId}” not found).`);
    else if (o.item.kind !== 'entry') warn(5, `${u.name || u.id}’s front door ${u.entryOpeningId} is a “${o.item.kind}”, not an entry.`);
  }

  // Rule 6: stairs connect neighbouring levels; elevators serve real levels.
  for (const s of d.stairs || []) {
    if (!(s.fromLevel >= 0 && s.toLevel === s.fromLevel + 1 && s.toLevel <= maxLevel)) err(6, `Stair ${s.id} runs from level ${s.fromLevel} to ${s.toLevel}; stairs go to the next level up.`);
    if (![s.x, s.y, s.widthM, s.depthM].every(isNum)) err(6, `Stair ${s.id} needs x, y, widthM and depthM.`);
    if (!['switchback', 'straight'].includes(s.shape)) err(6, `Stair ${s.id} has shape “${s.shape}”; use switchback or straight.`);
    if (!['front', 'back', 'left', 'right'].includes(s.accessSide)) err(6, `Stair ${s.id} needs an accessSide: front, back, left or right.`);
  }
  for (const e of d.elevators || []) {
    if (!Array.isArray(e.levels) || e.levels.some((x) => x < 0 || x > maxLevel)) err(6, `Elevator ${e.id} stops at a level that doesn’t exist.`);
  }

  // Rule 8: the building stands inside the land that was outlined.
  const outsideCorners = footprintOutside(d.placement.footprint, d.site?.outline);
  if (outsideCorners) err(8, `The building goes outside the outlined land (${outsideCorners} of its corners are past the boundary).`);

  // Rule 4: every room can be reached from a building entry.
  const unreachable = reachability(d);
  if (unreachable.length) {
    const list = unreachable.slice(0, 4).map((r) => `${r.name} (${r.id})`).join(', ');
    err(4, `${unreachable.length === 1 ? 'A room can’t' : `${unreachable.length} rooms can’t`} be reached from an entry: ${list}${unreachable.length > 4 ? ', …' : ''}.`);
  }

  // Rule 7: totals add up (a mismatch is shown, not blocked).
  const t = d.totals || {};
  const rooms = d.levels.flatMap((l) => l.rooms || []);
  const beds = rooms.filter((r) => r.type === 'bedroom').length;
  const baths = rooms.filter((r) => r.type === 'bath' || r.type === 'shared-bath').length + rooms.filter((r) => r.type === 'powder').length * 0.5;
  if (t.bedrooms != null && d.housingType !== 'dorm' && d.housingType !== 'hotel' && t.bedrooms !== beds) warn(7, `totals.bedrooms says ${t.bedrooms}; the plans have ${beds} bedrooms.`);
  if (t.bathrooms != null && t.bathrooms !== baths) warn(7, `totals.bathrooms says ${t.bathrooms}; the plans have ${baths}.`);
  if (t.unitCount != null && t.unitCount !== (d.units || []).length) warn(7, `totals.unitCount says ${t.unitCount}; units lists ${(d.units || []).length}.`);

  return { ok: errors.length === 0, errors, warnings };
}

// Rooms not reachable from any opening to the outside. Rooms join through openings, through walls
// that aren't there (an edge shared by two rooms with no wall along it), and through stairs and
// elevators (their rooms on each level they serve).
function reachability(d) {
  const key = (li, id) => `${li}:${id}`;
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  const start = [];
  d.levels.forEach((l, li) => {
    for (const r of l.rooms || []) if (!adj.has(key(li, r.id))) adj.set(key(li, r.id), new Set());
    for (const o of l.openings || []) {
      const [a, b] = o.connects || [];
      if (o.kind === 'window') continue;
      if (a === 'outside' && b && b !== 'outside') start.push(key(li, b));
      else if (b === 'outside' && a && a !== 'outside') start.push(key(li, a));
      else if (a && b) link(key(li, a), key(li, b));
    }
    // Open edges: two rooms sharing an edge with no wall drawn along it.
    const rooms = l.rooms || [];
    const walls = l.walls || [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        for (const e of sharedEdges(rooms[i].polygon, rooms[j].polygon)) {
          if (wallCoverage(walls, e) < 0.6) link(key(li, rooms[i].id), key(li, rooms[j].id));
        }
      }
    }
    // Stair and elevator rooms on neighbouring levels.
    for (const s of d.stairs || []) {
      if (s.fromLevel !== li) continue;
      const cx = s.x + s.widthM / 2, cy = s.y + s.depthM / 2;
      const lo = roomAt(l, cx, cy), hi = d.levels[s.toLevel] && roomAt(d.levels[s.toLevel], cx, cy);
      if (lo && hi) link(key(li, lo.id), key(s.toLevel, hi.id));
    }
  });
  for (const e of d.elevators || []) {
    const cx = e.x + e.widthM / 2, cy = e.y + e.depthM / 2;
    const stops = (e.levels || []).map((li) => d.levels[li] && roomAt(d.levels[li], cx, cy) && key(li, roomAt(d.levels[li], cx, cy).id)).filter(Boolean);
    for (let i = 1; i < stops.length; i++) link(stops[0], stops[i]);
  }
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) for (const n of adj.get(queue.shift()) || []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const out = [];
  d.levels.forEach((l, li) => { for (const r of l.rooms || []) if (!seen.has(key(li, r.id))) out.push(r); });
  return out;
}

// Edges (as segments) two polygons share, at least 0.3 m long.
function sharedEdges(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const r = b[j], s = b[(j + 1) % b.length];
      const seg = overlap(p, q, r, s);
      if (seg) out.push(seg);
    }
  }
  return out;
}

// The overlapping part of two collinear segments, or null.
function overlap(p, q, r, s) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len, uy = dy / len;
  const off = (pt) => Math.abs((pt[0] - p[0]) * uy - (pt[1] - p[1]) * ux);
  if (off(r) > 0.03 || off(s) > 0.03) return null;
  const t = (pt) => (pt[0] - p[0]) * ux + (pt[1] - p[1]) * uy;
  const lo = Math.max(0, Math.min(t(r), t(s))), hi = Math.min(len, Math.max(t(r), t(s)));
  if (hi - lo < 0.3) return null;
  return { a: [p[0] + ux * lo, p[1] + uy * lo], b: [p[0] + ux * hi, p[1] + uy * hi] };
}

// The share of an edge that walls run along (walls may be split into several pieces).
function wallCoverage(walls, e) {
  const el = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
  let sum = 0;
  for (const w of walls) {
    const seg = overlapAny([w.x1, w.y1], [w.x2, w.y2], e.a, e.b);
    if (seg) sum += Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
  }
  return sum / el;
}

// Like overlap(), but any length counts.
function overlapAny(p, q, r, s) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len, uy = dy / len;
  const off = (pt) => Math.abs((pt[0] - p[0]) * uy - (pt[1] - p[1]) * ux);
  if (off(r) > 0.03 || off(s) > 0.03) return null;
  const t = (pt) => (pt[0] - p[0]) * ux + (pt[1] - p[1]) * uy;
  const lo = Math.max(0, Math.min(t(r), t(s))), hi = Math.min(len, Math.max(t(r), t(s)));
  if (hi - lo < 0.01) return null;
  return { a: [p[0] + ux * lo, p[1] + uy * lo], b: [p[0] + ux * hi, p[1] + uy * hi] };
}

// How many footprint corners lie outside the site outline (both [lng, lat]); 0 when inside or when
// there's no outline to compare with. Lng/lat is treated as flat, which is exact enough for a lot.
export function footprintOutside(footprint, outline) {
  if (!Array.isArray(footprint) || !Array.isArray(outline) || outline.length < 3) return 0;
  return footprint.filter(([x, y]) => !pointInPolygon(x, y, outline)).length;
}
