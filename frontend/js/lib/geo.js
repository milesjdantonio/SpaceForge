// Site geometry. Sites arrive as GeoJSON-style rings of [lng, lat]; the engine works in local metres
// (x east, y north) around the site's centroid.

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQ = 111320;

export function ringCentroidLngLat(ring) {
  let lng = 0, lat = 0;
  for (const [x, y] of ring) { lng += x; lat += y; }
  return [lng / ring.length, lat / ring.length];
}

export function projection(origin) {
  const [lng0, lat0] = origin;
  const k = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LNG_EQ;
  return {
    origin,
    toLocal: ([lng, lat]) => [(lng - lng0) * k, (lat - lat0) * M_PER_DEG_LAT],
    toGeo: ([x, y]) => [lng0 + x / k, lat0 + y / M_PER_DEG_LAT],
  };
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export const area = (pts) => Math.abs(signedArea(pts));

export function perimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) p += dist(pts[i], pts[(i + 1) % pts.length]);
  return p;
}

export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function centroid(pts) {
  // Area centroid; falls back to the vertex mean for degenerate rings.
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function rotate([x, y], angle, [cx, cy] = [0, 0]) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function edgeDistance(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, segmentDistance(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}

// Compass bearing (0 = north, clockwise) of the direction a -> b, in degrees.
export function bearing(a, b) {
  const deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function edges(pts) {
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return { a, b, index: i, length: dist(a, b), bearing: bearing(a, b), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  });
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// True when two non-adjacent edges cross (a bow-tie outline).
export function selfIntersects(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Inward offset of a simple polygon by d metres (miter joins). Good for setback lines on the
// convex-ish outlines people draw for lots; very concave shapes may self-overlap, which callers clip.
export function offsetPolygon(pts, d) {
  const ccw = signedArea(pts) > 0;
  const n = pts.length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // inward normal
    const nx = ccw ? -dy / len : dy / len;
    const ny = ccw ? dx / len : -dx / len;
    lines.push({ p: [a[0] + nx * d, a[1] + ny * d], v: [dx, dy] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n], l2 = lines[i];
    const cross = l1.v[0] * l2.v[1] - l1.v[1] * l2.v[0];
    if (Math.abs(cross) < 1e-9) { out.push(l2.p); continue; }
    const t = ((l2.p[0] - l1.p[0]) * l2.v[1] - (l2.p[1] - l1.p[1]) * l2.v[0]) / cross;
    out.push([l1.p[0] + l1.v[0] * t, l1.p[1] + l1.v[1] * t]);
  }
  return out;
}

export function rectCorners({ cx, cy, w, d, angle }) {
  // angle: radians, rotation of the rectangle's width axis from east, counter-clockwise
  const hw = w / 2, hd = d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map((p) => rotate(p, angle).map((v, i) => v + (i ? cy : cx)));
}

// Geodesic-ish area of a lng/lat ring in square metres (local projection; accurate for lots).
export function ringAreaM2(ring) {
  const proj = projection(ringCentroidLngLat(ring));
  return area(ring.map(proj.toLocal));
}
