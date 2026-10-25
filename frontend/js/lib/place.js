// Placing a house on a lot, and reading measurements off an outline.

import { projection, ringCentroidLngLat, area, perimeter, edges, centroid, pointInPolygon, offsetPolygon, signedArea, selfIntersects } from './geo.js';

// Live measurements for an outline (lng/lat ring).
export function measure(ring, { setbackM = 3 } = {}) {
  if (!ring || ring.length < 2) return null;
  const proj = projection(ringCentroidLngLat(ring));
  let local = ring.map(proj.toLocal);
  const closedEnough = ring.length >= 3;
  const a = closedEnough ? area(local) : 0;
  const per = perimeter(local) - (closedEnough ? 0 : 0);
  const list = closedEnough ? edges(local) : [];
  const longest = list.reduce((m, e) => (!m || e.length > m.length ? e : m), null);
  if (closedEnough && signedArea(local) < 0) local = local.slice().reverse();
  const setback = closedEnough ? offsetPolygon(local, setbackM) : null;
  const buildable = setback && signedArea(setback) > 0 ? area(setback) : 0;
  return {
    areaM2: a,
    perimeterM: per,
    corners: ring.length,
    longestEdgeM: longest?.length ?? 0,
    longestEdgeBearing: longest?.bearing ?? 0,
    buildableM2: buildable,
    crossing: closedEnough && ring.length > 3 ? selfIntersects(local) : false,
    centroid: closedEnough ? proj.toGeo(centroid(local)) : ringCentroidLngLat(ring),
  };
}

export function problemsFor(m) {
  const out = [];
  if (!m || m.corners < 3) out.push('An outline needs at least three corners.');
  else if (m.crossing) out.push('Two edges cross. Drag a corner so the lines don’t overlap.');
  else if (m.areaM2 < 120) out.push('That’s smaller than a small house lot. Outline the whole piece of land.');
  else if (m.areaM2 > 400000) out.push('That’s over 40 hectares. Outline the part the house will stand on.');
  return out;
}

// Places a design's footprint at the middle of a lot, square to the lot's longest edge.
export function placeOnLot(design, ring) {
  const proj = projection(ringCentroidLngLat(ring));
  let local = ring.map(proj.toLocal);
  if (signedArea(local) < 0) local = local.slice().reverse();
  const c = centroid(local);
  const longest = edges(local).reduce((m, e) => (e.length > m.length ? e : m));
  // Of the two directions along the longest edge, pick the one that turns the front (y = 0 side)
  // closest to south, where the living rooms want to face.
  let best = null;
  for (const b of [longest.bearing, (longest.bearing + 180) % 360]) {
    const front = (b + 90) % 360; // the front faces x-axis bearing + 90°
    const score = Math.cos(((front - 180) * Math.PI) / 180);
    if (!best || score > best.score) best = { b, score };
  }
  const b = (best.b * Math.PI) / 180;
  const ux = [Math.sin(b), Math.cos(b)];
  const uy = [-Math.cos(b), Math.sin(b)];
  const W = design.size.widthM, D = design.size.depthM;
  const o = [c[0] - ux[0] * W / 2 - uy[0] * D / 2, c[1] - ux[1] * W / 2 - uy[1] * D / 2];
  const toGeo = ([x, y]) => proj.toGeo([o[0] + ux[0] * x + uy[0] * y, o[1] + ux[1] * x + uy[1] * y]);
  const footprint = [[0, 0], [W, 0], [W, D], [0, D]].map(toGeo);
  const fits = footprint.every((p) => pointInPolygon(proj.toLocal(p), local));
  return { origin: toGeo([0, 0]), xAxisBearingDeg: best.b, footprint, fits };
}

// The middle of a placement's footprint, [lng, lat].
export function placementCenter(placement) {
  return ringCentroidLngLat(placement.footprint);
}

// A placement moved so its middle lands on `center` ([lng, lat]) and turned by `turnDeg` (compass
// degrees, clockwise) about its middle. Every corner and the origin move together, so the building
// keeps its exact shape; other fields on the placement are kept.
export function transformPlacement(placement, { center, turnDeg = 0 }) {
  const from = placementCenter(placement);
  const proj = projection(from);
  const [tx, ty] = proj.toLocal(center ?? from);
  const a = (-turnDeg * Math.PI) / 180; // compass clockwise is maths counter-clockwise negated
  const cos = Math.cos(a), sin = Math.sin(a);
  const move = (p) => {
    const [x, y] = proj.toLocal(p);
    return proj.toGeo([x * cos - y * sin + tx, x * sin + y * cos + ty]);
  };
  return {
    ...placement,
    origin: move(placement.origin),
    footprint: placement.footprint.map(move),
    xAxisBearingDeg: (((placement.xAxisBearingDeg + turnDeg) % 360) + 360) % 360,
  };
}

export function inFootprint(lngLat, footprint) {
  const proj = projection(ringCentroidLngLat(footprint));
  return pointInPolygon(proj.toLocal(lngLat), footprint.map(proj.toLocal));
}
