// Cost over time: yearly ownership cost as bars, with the years that carry big replacements in
// amber, and the estimated value as a line on its own scale. SVG, sized by its container.

import { fmt } from '../format.js';

export function renderOverTime(overTime) {
  const rows = overTime.rows.filter((r) => r.year > 0);
  const W = 400, H = 180, padL = 0, padB = 22, padT = 10;
  const cost = rows.map((r) => r.maintenance + r.energy + r.replacements);
  const maxCost = Math.max(...cost);
  const bw = (W - padL) / rows.length;
  const y = (v) => H - padB - (v / maxCost) * (H - padB - padT);
  const bars = rows.map((r, i) => {
    const big = r.replacements > 0;
    const h = H - padB - y(cost[i]);
    return `<rect x="${(padL + i * bw + 1).toFixed(1)}" y="${y(cost[i]).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" class="${big ? 'bar-hot' : 'bar'}"><title>Year ${r.year}: ${fmt.money(cost[i])}${big ? ' (replacements)' : ''}</title></rect>`;
  }).join('');
  const ticks = [1, 10, 20, 30].map((yr) => `<text x="${(padL + (yr - 0.5) * bw).toFixed(1)}" y="${H - 6}" class="tick" text-anchor="middle">${yr === 1 ? 'Year 1' : yr}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Yearly cost of ownership over ${rows.length} years">${bars}${ticks}</svg>`;
}
