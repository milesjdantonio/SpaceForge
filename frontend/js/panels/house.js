// The side panel for a house on the map: what it is, its plans, and its numbers.

import { fmt } from '../format.js';
import { renderPlan } from '../render/plan.js';
import { renderOverTime } from '../render/chart.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

const TABS = [['overview', 'Overview'], ['plans', 'Plans'], ['cost', 'Cost'], ['materials', 'Materials'], ['time', 'Over time']];

export function renderHousePanel(el, { design, estimate, preview, onWalk }) {
  let tab = 'overview';
  let level = 0;
  const cost = estimate.buildCost;
  const faces = fmt.bearing((design.placement.xAxisBearingDeg + 90) % 360);

  el.innerHTML = `
    <header class="panel-head">
      <div>
        <h2 class="panel-title">${design.title}</h2>
        <p class="panel-sub">${design.sample ? (preview ? 'Sample house placed on your land' : 'Sample listing') : 'Designed for this land'}</p>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    ${design.sample ? `<p class="sample-note">${preview
      ? 'This is TerraSim’s one sample house, placed and turned to fit your outline. A real design will be drawn for your land once the design service is connected.'
      : 'Sample data: this house shows what the design service returns.'}</p>` : ''}
    <dl class="facts num">
      <div><dt>Build estimate</dt><dd>${fmt.money(cost.low, { short: true })}–${fmt.money(cost.high, { short: true })}</dd></div>
      <div><dt>Living space</dt><dd>${fmt.area(design.finishedAreaM2)}</dd></div>
      <div><dt>Rooms</dt><dd>${design.bedrooms} bed · ${design.bathrooms} bath</dd></div>
      <div><dt>Front faces</dt><dd>${faces}</dd></div>
    </dl>
    <div class="panel-actions">
      <button type="button" class="btn btn-primary" data-walk>${icon('walk')}<span>Walk through</span></button>
      <button type="button" class="btn" data-share>${icon('share')}<span>Share</span></button>
      ${design.sample && !preview ? `<button type="button" class="btn" data-contact>${icon('mail')}<span>Contact builder</span></button>` : ''}
    </div>
    <div class="tabs" role="tablist" aria-label="Details">
      ${TABS.map(([id, name]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="tabpanel" aria-selected="${id === tab}" data-tab="${id}">${name}</button>`).join('')}
    </div>
    <div class="tabpanel" id="tabpanel" role="tabpanel"></div>`;

  const body = el.querySelector('.tabpanel');

  const draw = () => {
    el.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    body.setAttribute('aria-labelledby', `tab-${tab}`);
    if (tab === 'overview') {
      body.innerHTML = `
        <p class="lead-text">${design.summary}</p>
        ${design.description.map((p) => `<p>${p}</p>`).join('')}
        <h3 class="group-title">How it answers the land</h3>
        <ul class="ticks">${design.siteResponse.map((s) => `<li>${s}</li>`).join('')}</ul>
        <h3 class="group-title">Materials</h3>
        <ul class="swatches">${design.materials.palette.map((p) => `<li><span class="swatch" style="background:${p.hex}"></span><span>${p.name}</span><span class="swatch-use">${p.use}</span></li>`).join('')}</ul>
        <h3 class="group-title">Check before building</h3>
        <ul class="ticks ticks-warn">${design.cautions.map((s) => `<li>${s}</li>`).join('')}</ul>`;
    }
    if (tab === 'plans') {
      body.innerHTML = `
        <div class="seg level-seg" role="group" aria-label="Floor">
          ${design.levels.map((l, i) => `<button type="button" data-level="${i}" aria-pressed="${i === level}">${l.name}</button>`).join('')}
        </div>
        <div class="plan-box"></div>
        <table class="rooms num">
          <thead><tr><th>Room</th><th class="r">Size</th><th class="r">Area</th></tr></thead>
          <tbody>${design.levels[level].rooms.map((r) => {
            const xs = r.polygon.map((p) => p[0]), ys = r.polygon.map((p) => p[1]);
            const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
            return `<tr><td>${r.name}</td><td class="r">${fmt.len(w, { precise: true })} × ${fmt.len(d, { precise: true })}</td><td class="r">${fmt.area(r.areaM2)}</td></tr>`;
          }).join('')}</tbody>
        </table>`;
      body.querySelector('.plan-box').append(renderPlan(design, { level, className: 'plan plan-panel' }));
    }
    if (tab === 'cost') {
      const max = Math.max(...cost.lines.map((l) => l.amount));
      body.innerHTML = `
        <div class="range">
          <div class="range-figures num"><span>${fmt.money(cost.low)}</span><strong>${fmt.money(cost.expected)}</strong><span>${fmt.money(cost.high)}</span></div>
          <div class="range-bar" aria-hidden="true"><span style="left:${((cost.expected - cost.low) / (cost.high - cost.low) * 100).toFixed(1)}%"></span></div>
          <p class="note">Low, expected and high. ${fmt.perArea(cost.expected / design.finishedAreaM2)} · ${cost.confidence} confidence.</p>
        </div>
        <table class="lines num">
          <tbody>${cost.lines.map((l) => `<tr><td>${l.name}</td><td class="r">${fmt.money(l.amount)}</td><td class="bar-cell"><span style="width:${(l.amount / max * 100).toFixed(1)}%"></span></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Expected total</td><td class="r">${fmt.money(cost.expected)}</td><td></td></tr></tfoot>
        </table>
        <ul class="ticks">${cost.assumptions.map((a) => `<li>${a}</li>`).join('')}</ul>`;
    }
    if (tab === 'materials') {
      const total = estimate.materials.reduce((s, m) => s + m.cost, 0);
      body.innerHTML = `
        <table class="materials num">
          <thead><tr><th>Material</th><th class="r">Quantity</th><th class="r">Cost</th></tr></thead>
          <tbody>${estimate.materials.map((m) => `<tr><td>${m.name}</td><td class="r">${fmt.int(m.quantity)} <span class="unit">${m.unit}</span></td><td class="r">${fmt.money(m.cost)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Materials total</td><td></td><td class="r">${fmt.money(total)}</td></tr></tfoot>
        </table>
        <p class="note">Material costs are part of the build estimate, not on top of it.</p>`;
    }
    if (tab === 'time') {
      const rows = estimate.overTime.rows;
      const last = rows[rows.length - 1];
      const own = rows.reduce((s, r) => s + r.maintenance + r.energy + r.replacements, 0);
      body.innerHTML = `
        <dl class="facts num">
          <div><dt>${estimate.overTime.years}-year cost to own</dt><dd>${fmt.money(own, { short: true })}</dd></div>
          <div><dt>Per month, on average</dt><dd>${fmt.money(own / (estimate.overTime.years * 12))}</dd></div>
          <div><dt>House value in year ${last.year}</dt><dd>${fmt.money(last.value, { short: true })}</dd></div>
        </dl>
        <div class="chart-box">${renderOverTime(estimate.overTime)}</div>
        <p class="note">Yearly maintenance, energy and replacements. Amber years carry a big replacement.</p>
        <h3 class="group-title">Big expenses ahead</h3>
        <table class="lines num"><tbody>${estimate.overTime.events.map((e) => `<tr><td>Year ${e.year}</td><td>${e.name}</td><td class="r">${fmt.money(e.amount)}</td></tr>`).join('')}</tbody></table>
        <p class="note">Assumes ${(estimate.overTime.assumptions.inflation * 100).toFixed(1)}% inflation and ${(estimate.overTime.assumptions.appreciation * 100).toFixed(1)}% yearly appreciation. Excludes land, taxes and insurance.</p>`;
    }
  };

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; draw(); return; }
    const l = e.target.closest('[data-level]');
    if (l) { level = Number(l.dataset.level); draw(); return; }
    if (e.target.closest('[data-walk]')) onWalk();
    if (e.target.closest('[data-share]')) {
      try { await navigator.clipboard.writeText(location.href); toast('Link copied.'); } catch { toast('Couldn’t copy the link.'); }
    }
    if (e.target.closest('[data-contact]')) toast('Messages to builders arrive once the TerraSim API is connected.');
  });
  el.addEventListener('keydown', (e) => {
    if (!e.target.matches('[role="tab"]') || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const ids = TABS.map((x) => x[0]);
    tab = ids[(ids.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    draw();
    el.querySelector(`[data-tab="${tab}"]`).focus();
  });
  draw();
}
