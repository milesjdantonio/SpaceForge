// Sites: a neighborhood or trailer park as one terrasim.design/3 file (contracts/FIELDS.md, "Sites").
// A site carries the same top-level fields a building does (overview, totals, site, placement, size,
// cost), plus its streets, lots, shared spaces, home variants (whole terrasim.design/2 buildings)
// and homes (a variant placed on a lot). Everything inside is in site metres: x along the site's
// x axis (placement.xAxisBearingDeg), y turned 90° counter-clockwise from it, as in a building.

import { projection, pointInPolygon } from './geo.js';

export const SITE_SCHEMA = 'terrasim.design/3';
export const isSite = (d) => d?.schema === SITE_SCHEMA;

// Converters between [lng, lat] and site (or building) metres.
export function frameOf(placement) {
  const proj = projection(placement.origin);
  const b = (placement.xAxisBearingDeg * Math.PI) / 180;
  const ux = [Math.sin(b), Math.cos(b)], uy = [-Math.cos(b), Math.sin(b)];
  return {
    toLocal(ll) { const [e, n] = proj.toLocal(ll); return [e * ux[0] + n * ux[1], e * uy[0] + n * uy[1]]; },
    toGeo([x, y]) { return proj.toGeo([x * ux[0] + y * uy[0], x * ux[1] + y * uy[1]]); },
  };
}

export const variantOf = (site, home) => site.variants?.find((v) => v.id === home.variant) ?? null;

// A point of a home's building frame in site metres.
export function homeToSite(home, [x, y]) {
  const a = (home.rotationDeg * Math.PI) / 180;
  return [home.x + x * Math.cos(a) - y * Math.sin(a), home.y + x * Math.sin(a) + y * Math.cos(a)];
}

// Where a home stands, as a building placement ([lng, lat] origin, bearing, footprint), from where
// the site stands (which may have been moved since it was made).
export function homePlacement(site, home, placement = site.placement) {
  const v = variantOf(site, home);
  const frame = frameOf(placement);
  const W = v?.design.size.widthM ?? 0, D = v?.design.size.depthM ?? 0;
  const toGeo = (p) => frame.toGeo(homeToSite(home, p));
  return {
    origin: toGeo([0, 0]),
    xAxisBearingDeg: ((((placement.xAxisBearingDeg - home.rotationDeg) % 360) + 360) % 360),
    footprint: [[0, 0], [W, 0], [W, D], [0, D]].map(toGeo),
  };
}

// The home whose footprint holds [lng, lat], or null.
export function homeAt(site, ll, placement = site.placement) {
  const p = frameOf(placement).toLocal(ll);
  for (const h of site.homes || []) {
    const v = variantOf(site, h);
    if (!v) continue;
    const corners = [[0, 0], [v.design.size.widthM, 0], [v.design.size.widthM, v.design.size.depthM], [0, v.design.size.depthM]].map((c) => homeToSite(h, c));
    if (pointInPolygon(p, corners)) return h;
  }
  return null;
}

// The site's land in site metres.
export function siteOutline(site, placement = site.placement) {
  const frame = frameOf(placement);
  return (site.site?.outline || []).map((ll) => frame.toLocal(ll));
}

// The checks for a site: its own structure, then every home variant with the building checks
// (checkDesign is passed in, so this file doesn't import it).
export function checkSite(d, checkDesign) {
  const errors = [], warnings = [];
  const err = (message, rule = 0) => errors.push({ rule, message });
  const need = [['overview.title', d.overview?.title], ['size.widthM', d.size?.widthM], ['size.depthM', d.size?.depthM],
    ['placement.origin', d.placement?.origin], ['placement.xAxisBearingDeg', d.placement?.xAxisBearingDeg]];
  for (const [path, v] of need) if (v == null) err(`The site is missing ${path}.`);
  if (!Array.isArray(d.variants) || !d.variants.length) err('The site has no home designs (variants).');
  if (!Array.isArray(d.homes) || !d.homes.length) err('The site has no homes.');
  if (errors.length) return { ok: false, errors, warnings };
  const lots = new Map((d.lots || []).map((l) => [l.id, l]));
  for (const v of d.variants) {
    const r = checkDesign(v.design);
    for (const e of r.errors) errors.push({ rule: e.rule, message: `Home ${v.id}: ${e.message}` });
    for (const w of r.warnings) warnings.push({ rule: w.rule, message: `Home ${v.id}: ${w.message}` });
  }
  for (const h of d.homes) {
    const v = variantOf(d, h);
    if (!v) { err(`Home ${h.id} uses a home design (${h.variant}) the site doesn't have.`, 1); continue; }
    const lot = lots.get(h.lotId);
    if (!lot) { err(`Home ${h.id} stands on a lot (${h.lotId}) the site doesn't have.`, 1); continue; }
    const W = v.design.size.widthM, D = v.design.size.depthM;
    const out = [[0, 0], [W, 0], [W, D], [0, D]].map((c) => homeToSite(h, c)).filter((p) => !pointInPolygon(p, lot.polygon) && !nearEdge(p, lot.polygon));
    if (out.length) err(`Home ${h.id} reaches past its lot ${lot.id}.`, 8);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function nearEdge([x, y], poly) {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    if (Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) < 0.05) return true;
  }
  return false;
}
