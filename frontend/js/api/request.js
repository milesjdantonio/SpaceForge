// Builds the terrasim.design-request/2 the website sends to Gemma (contracts/FIELDS.md, Part 1).

import { measure } from '../lib/place.js';
import { briefFor, advancedFor, aiDecides } from '../lib/housing.js';
import { settings } from '../store.js';

export function buildRequest(site) {
  const m = measure(site.ring);
  const ring = site.ring.map((p) => [+p[0].toFixed(7), +p[1].toFixed(7)]);
  const form = site.form;
  const type = form.housingType;
  return {
    schema: 'terrasim.design-request/2',
    id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    housingType: type,
    site: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
      properties: {
        areaM2: Math.round(m.areaM2),
        perimeterM: Math.round(m.perimeterM),
        centroid: m.centroid.map((v) => +v.toFixed(6)),
        setbackM: 3,
      },
    },
    brief: briefFor(type, form.answers),
    advanced: advancedFor(type, form.advanced),
    aiDecides: [...(form.answers.areaByAI && type !== 'dorm' ? ['areaM2'] : []), ...aiDecides(type, form.advanced)],
    mode: site.mode,
    builder: site.mode === 'build' ? { ...site.builder, permission: !!site.builder?.permission } : null,
    client: { displayUnits: settings.units, createdAt: new Date().toISOString() },
  };
}
