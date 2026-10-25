import { checkDesign } from './design.js';

export function savedDocument({ design, estimate = null, site = null, placement = null }) {
  assertDesign(design);
  return { schema: 'terrasim.saved-building/1', design, estimate, site, placement };
}

export function readSavedBuilding(record) {
  const data = record?.data;
  const design = data?.design ?? (data?.schema === 'terrasim.design/2' || data?.schema === 'terrasim.design/3' ? data : null);
  assertDesign(design);
  const pair = (point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  if (data.site && (!Array.isArray(data.site.ring) || data.site.ring.length < 3 || !data.site.ring.every(pair))) {
    throw new Error('This saved building has an invalid site outline.');
  }
  const placement = data.placement;
  if (placement && (!pair(placement.origin) || !Number.isFinite(placement.xAxisBearingDeg) || !Array.isArray(placement.footprint) || placement.footprint.length !== 4 || !placement.footprint.every(pair))) {
    throw new Error('This saved building has an invalid placement.');
  }
  const site = data.site ? { ...data.site, ...(record.project_id ? { projectId: record.project_id } : {}) } : null;
  return { design, estimate: data.estimate ?? null, site, placement: data.placement ?? design.placement };
}

function assertDesign(design) {
  let result;
  try { result = checkDesign(design); } catch { throw new Error('This saved building has an incomplete design file.'); }
  if (!result.ok) throw new Error('This saved building cannot be drawn: ' + result.errors.map((e) => e.message).join(' '));
}
