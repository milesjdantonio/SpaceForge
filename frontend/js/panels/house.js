// The side panel for a house on the map: what it is, its plans, and its numbers.

import { fmt } from '../format.js';
import { renderPlan } from '../render/plan.js';
import { renderOverTime } from '../render/chart.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { typeName } from '../lib/housing.js';
import { explainSaveError } from '../lib/errors.js';
import { openPlanViewer } from '../ui/plan-viewer.js';
import { flatPoly } from '../lib/design.js';

// One line saying what the building holds.
export function holdsLine(design) {
  const t = design.totals || {};
  if (design.housingType === 'dorm') return `${t.residents} beds · ${t.floors} floors`;
  if (design.housingType === 'hotel') return `${t.bedrooms} guest rooms · ${t.floors} floors`;
  if ((t.unitCount ?? 1) > 1) return `${t.unitCount} homes · ${t.floors} floors`;
  return `${t.bedrooms} bed · ${t.bathrooms} bath`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TABS = [['overview', 'Overview'], ['plans', 'Plans'], ['cost', 'Cost'], ['materials', 'Materials'], ['time', 'Over time']];

// `name` is the person's own name for the building (onRename changes it); `placement` is where it
// stands now; `onShare` shares it (a building link, or the land for the sample).
export function renderHousePanel(el, { design, estimate, preview, onWalk, onPreview, onChangeDesign, onShare, onSave, saved = false, name = null, onRename = null, placement = design.placement, shared = false }) {
  let tab = 'overview';
  let level = 0;
  // The panel element is shared; drop the listeners an earlier house left on it.
  el.__houseListeners?.abort();
  const listeners = new AbortController();
  el.__houseListeners = listeners;
  const signal = listeners.signal;
  const cost = estimate?.buildCost ?? null;
  const faces = fmt.bearing((placement.xAxisBearingDeg + 90) % 360);
  let title = name || design.overview.title;
  const sub = design.sample ? (preview ? 'Sample house placed on your land' : 'Sample listing')
    : shared ? `${typeName(design.housingType)} shared with you` : `${typeName(design.housingType)} designed for this land`;

  el.innerHTML = `
    <header class="panel-head">
      <div class="panel-title-row" data-title-row>
        <h2 class="panel-title" data-title>${esc(title)}</h2>
        ${onRename ? `<button type="button" class="btn btn-quiet btn-icon btn-rename" data-rename aria-label="Rename this building" title="Rename">${icon('edit')}</button>` : ''}
        <p class="panel-sub">${esc(sub)}${name && name !== design.overview.title ? ` · ${esc(design.overview.title)}` : ''}</p>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    ${design.site?.estimated ? `<p class="estimate-note">${icon('alert')}<span><strong>Estimated site data.</strong> This land is outside the US, so elevation and soil come from worldwide maps and flood, earthquake and price figures are typical assumptions. They’re listed under Overview, Cautions.</span></p>` : ''}
    ${design.sample ? `<p class="sample-note">${preview
      ? 'This is TerraSim’s one sample house, placed and turned to fit your outline. A real design will be drawn for your land once the design service is connected.'
      : 'Sample data: this house shows what the design service returns.'}</p>` : ''}
    <dl class="facts num">
      <div><dt>Build estimate</dt><dd>${cost ? `${fmt.money(cost.low, { short: true })}–${fmt.money(cost.high, { short: true })}` : 'Not included'}</dd></div>
      <div><dt>Finished space</dt><dd>${fmt.area(design.totals.finishedAreaM2)}</dd></div>
      <div><dt>Holds</dt><dd>${esc(holdsLine(design))}</dd></div>
      <div><dt>Front faces</dt><dd>${faces}</dd></div>
    </dl>
    <div class="panel-actions">
      <button type="button" class="btn btn-primary" data-walk>${icon('walk')}<span>Walk through</span></button>
      ${onPreview ? `<button type="button" class="btn btn-primary" data-preview>${icon('orbit')}<span>Preview</span></button>` : ''}
    </div>
    <div class="panel-actions panel-actions-quiet">
      ${onSave ? `<button type="button" class="btn" data-save>${saved ? 'Save changes' : 'Save building'}</button>` : ''}
      <button type="button" class="btn" data-share>${icon('share')}<span>${design.sample ? 'Share site' : 'Share'}</span></button>
    </div>
    <p class="note">To move or turn it, choose Move beside the building on the map.</p>
    ${onChangeDesign ? `<details class="change-design">
      <summary>${icon('edit')}<span>Change this design</span></summary>
      <form data-change novalidate>
        <label class="change-label" for="change-text">What should change?</label>
        <textarea id="change-text" name="change" rows="3" maxlength="600" placeholder="For example: add a fourth bedroom, make it round, brick instead of siding"></textarea>
        <p class="change-error" role="alert" hidden></p>
        <p class="note">Gemma rewrites the brief with your change and designs the building again on this land, in about a minute. The new design replaces this one${saved ? ' in My Builds' : ''}.</p>
        <button type="submit" class="btn btn-primary">${icon('retry')}<span>Redesign</span></button>
      </form>
    </details>` : ''}
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
        <p class="lead-text">${esc(design.overview.summary)}</p>
        ${design.overview.description.map((p) => `<p>${esc(p)}</p>`).join('')}
        ${design.overview.features?.length ? `<h3 class="group-title">Features</h3><ul class="ticks">${design.overview.features.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        ${soilBlock(design.site?.soil)}
        <h3 class="group-title">How it answers the land</h3>
        <ul class="ticks">${design.overview.siteResponse.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
        <h3 class="group-title">Materials</h3>
        <ul class="swatches">${design.exterior.materials.palette.map((p) => `<li><span class="swatch" style="background:${esc(p.hex)}"></span><span>${esc(p.name)}</span><span class="swatch-use">${esc(p.use)}</span></li>`).join('')}</ul>
        <h3 class="group-title">Check before building</h3>
        <ul class="ticks ticks-warn">${design.overview.cautions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
    }
    if (tab === 'plans') {
      body.innerHTML = `
        <div class="seg level-seg" role="group" aria-label="Floor">
          ${design.levels.map((l, i) => `<button type="button" data-level="${i}" aria-pressed="${i === level}">${l.name}</button>`).join('')}
        </div>
        <div class="plan-box">
          <button type="button" class="btn btn-small plan-expand" data-expand aria-label="Expand the plan for a close look">${icon('expand')}<span>Expand</span></button>
        </div>
        ${homesOn(design, level) ?? roomsTable(design.levels[level])}`;
      const plan = renderPlan(design, { level, className: 'plan plan-panel' });
      plan.addEventListener('click', () => expandPlan());
      body.querySelector('.plan-box').prepend(plan);
    }
    if (!estimate && ['cost', 'materials', 'time'].includes(tab)) {
      body.innerHTML = '<p class="empty">No cost came with this design. The design service puts it in the design file as “cost”.</p>';
      return;
    }
    if (tab === 'cost') {
      const max = Math.max(...cost.lines.map((l) => l.amount));
      body.innerHTML = `
        <div class="range">
          <div class="range-figures num"><span>${fmt.money(cost.low)}</span><strong>${fmt.money(cost.expected)}</strong><span>${fmt.money(cost.high)}</span></div>
          <div class="range-bar" aria-hidden="true"><span style="left:${((cost.expected - cost.low) / (cost.high - cost.low) * 100).toFixed(1)}%"></span></div>
          <p class="note">Low, expected and high. ${fmt.perArea(cost.expected / design.totals.finishedAreaM2)} · ${esc(cost.confidence)} confidence.</p>
        </div>
        <table class="lines num">
          <tbody>${cost.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${fmt.money(l.amount)}</td><td class="bar-cell"><span style="width:${(l.amount / max * 100).toFixed(1)}%"></span></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Expected total</td><td class="r">${fmt.money(cost.expected)}</td><td></td></tr></tfoot>
        </table>
        ${breakdownBlock(estimate.breakdown)}
        <ul class="ticks">${cost.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        ${suppliersBlock(estimate.suppliers)}`;
    }
    if (tab === 'materials') {
      const total = estimate.materials.reduce((s, m) => s + m.cost, 0);
      body.innerHTML = `
        <table class="materials num">
          <thead><tr><th>Material</th><th class="r">Quantity</th><th class="r">Cost</th></tr></thead>
          <tbody>${estimate.materials.map((m) => `<tr><td>${esc(m.name)}</td><td class="r">${fmt.int(m.quantity)} <span class="unit">${esc(m.unit)}</span></td><td class="r">${fmt.money(m.cost)}</td></tr>`).join('')}</tbody>
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
        <table class="lines num"><tbody>${estimate.overTime.events.map((e) => `<tr><td>Year ${esc(e.year)}</td><td>${esc(e.name)}</td><td class="r">${fmt.money(e.amount)}</td></tr>`).join('')}</tbody></table>
        <p class="note">Assumes ${(estimate.overTime.assumptions.inflation * 100).toFixed(1)}% inflation and ${(estimate.overTime.assumptions.appreciation * 100).toFixed(1)}% yearly appreciation. Excludes land, taxes and insurance.</p>`;
    }
  };

  el.addEventListener('click', async (e) => {
    const save = e.target.closest('[data-save]');
    if (save) {
      if (save.disabled) return;
      const before = save.textContent;
      save.disabled = true; save.textContent = 'Saving…';
      try {
        const result = await onSave();
        save.textContent = result ? 'Save changes' : before;
        if (result) toast('Building saved to your account.');
      } catch (err) {
        save.textContent = before;
        const why = explainSaveError(err);
        toast(`This building wasn’t saved. ${why.text}`, { kind: 'error', action: why.action && { label: why.action, run: () => save.click() } });
      }
      finally { save.disabled = false; }
      return;
    }
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; draw(); return; }
    const l = e.target.closest('[data-level]');
    if (l) { level = Number(l.dataset.level); draw(); return; }
    if (e.target.closest('[data-walk]')) onWalk();
    if (e.target.closest('[data-preview]')) onPreview?.();
    if (e.target.closest('[data-expand]')) expandPlan();
    if (e.target.closest('[data-share]')) onShare?.();
    if (e.target.closest('[data-rename]')) startRename();
  }, { signal });
  // Change this design: the written change goes to Gemma, which redesigns the building from it.
  el.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-change]');
    if (!form) return;
    e.preventDefault();
    const text = form.elements.change.value.trim();
    const error = form.querySelector('.change-error');
    if (text.length < 3) {
      error.hidden = false;
      error.textContent = 'Write what should change, for example “add a fourth bedroom”.';
      form.elements.change.focus();
      return;
    }
    error.hidden = true;
    onChangeDesign?.(text);
  }, { signal });
  // The plan full screen; picking a floor there shows the same floor here afterwards.
  function expandPlan() {
    openPlanViewer({ design, level, title, onLevel: (i) => { if (i !== level) { level = i; if (tab === 'plans') draw(); } } });
  }

  // Renaming in place: the title becomes a box; Enter or Save keeps it, Escape or Cancel doesn't.
  function startRename() {
    const row = el.querySelector('[data-title-row]');
    const h = row.querySelector('[data-title]');
    if (row.querySelector('[data-rename-form]')) return;
    const form = document.createElement('form');
    form.className = 'rename';
    form.dataset.renameForm = '';
    form.innerHTML = `<label class="sr-only" for="rename-input">Building name</label>
      <input class="input" id="rename-input" maxlength="120" autocomplete="off">
      <button type="submit" class="btn btn-small btn-primary">Save</button>
      <button type="button" class="btn btn-small btn-quiet" data-cancel>Cancel</button>
      <p class="qerror" role="alert"></p>`;
    const input = form.querySelector('input');
    input.value = title;
    h.hidden = true;
    row.querySelector('[data-rename]').hidden = true;
    h.after(form);
    input.focus(); input.select();
    const end = () => { form.remove(); h.hidden = false; row.querySelector('[data-rename]').hidden = false; };
    form.querySelector('[data-cancel]').onclick = end;
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); end(); } });
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const next = input.value.trim();
      const err = form.querySelector('.qerror');
      if (!next) { err.innerHTML = `${icon('alert')}<span>Give it a name, or press Cancel.</span>`; return; }
      if (next === title) { end(); return; }
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await onRename(next);
        title = next;
        h.textContent = next;
        end();
      } catch (e2) {
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        err.innerHTML = `${icon('alert')}<span>${esc(`The name wasn’t saved. ${explainSaveError(e2).text}`)}</span>`;
      }
    };
  }

  el.addEventListener('keydown', (e) => {
    if (!e.target.matches('[role="tab"]') || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const ids = TABS.map((x) => x[0]);
    tab = ids[(ids.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    draw();
    el.querySelector(`[data-tab="${tab}"]`).focus();
  }, { signal });
  draw();
}

function roomsTable(level) {
  return `<table class="rooms num">
    <thead><tr><th>Room</th><th class="r">Size</th><th class="r">Area</th></tr></thead>
    <tbody>${level.rooms.filter((r) => !['hall', 'stair', 'elevator', 'corridor'].includes(r.type)).map((r) => {
      const poly = flatPoly(r.polygon);
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
      return `<tr><td>${esc(r.name)}</td><td class="r">${fmt.len(w, { precise: true })} × ${fmt.len(d, { precise: true })}</td><td class="r">${fmt.area(r.areaM2)}</td></tr>`;
    }).join('')}</tbody>
  </table>`;
}

// For buildings with several homes: the homes on a floor, then its shared rooms.
function homesOn(design, li) {
  if ((design.units || []).length < 2 && design.housingType !== 'dorm') return null;
  const level = design.levels[li];
  const homes = design.units.filter((u) => level.rooms.some((r) => r.unitId === u.id));
  const shared = level.rooms.filter((r) => r.unitId == null && !['stair', 'elevator', 'corridor', 'hall'].includes(r.type));
  const KIND = { studio: 'Studio', '1-bed': '1 bed', '2-bed': '2 bed', '3-bed': '3 bed', '4-bed': '4 bed', townhome: 'Townhome', house: 'House' };
  return `
    ${homes.length ? `<table class="rooms num">
      <thead><tr><th>Home</th><th>Kind</th><th class="r">Baths</th><th class="r">Area</th></tr></thead>
      <tbody>${homes.map((u) => `<tr><td>${esc(u.name)}</td><td>${KIND[u.kind] ?? esc(u.kind)}</td><td class="r">${u.bathrooms}</td><td class="r">${fmt.area(u.areaM2)}</td></tr>`).join('')}</tbody>
    </table>` : ''}
    ${shared.length ? `<table class="rooms num">
      <thead><tr><th>Shared</th><th class="r">Area</th></tr></thead>
      <tbody>${shared.map((r) => `<tr><td>${esc(r.name)}</td><td class="r">${fmt.area(r.areaM2)}</td></tr>`).join('')}</tbody>
    </table>` : ''}`;
}

// When a design file breaks the contract: what's wrong, so it can be fixed at the source.
// `actions` are the backups offered under it: [{ label, run, primary }].
export function renderDesignProblems(el, { design, result, onClose, actions = [] }) {
  el.innerHTML = `
    <header class="panel-head">
      <div>
        <h2 class="panel-title">This design can’t be drawn</h2>
        <p class="panel-sub">${esc(design?.overview?.title ?? design?.id ?? 'Design file')}</p>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    <p>The design file breaks ${result.errors.length === 1 ? 'a rule' : `${result.errors.length} rules`} the website relies on (contracts/FIELDS.md, “Rules the renderer checks”). Nothing is drawn rather than drawing it wrong.</p>
    <ul class="ticks ticks-warn">${result.errors.slice(0, 12).map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul>
    ${result.errors.length > 12 ? `<p class="note">And ${result.errors.length - 12} more.</p>` : ''}
    ${result.warnings.length ? `<details class="request"><summary>${result.warnings.length} smaller ${result.warnings.length === 1 ? 'issue' : 'issues'}</summary><ul class="ticks">${result.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></details>` : ''}
    <p class="fail-next"><strong>What to try:</strong> ${actions.length ? 'Gemma’s drawings vary from run to run, so generating again usually gives a design that draws.' : 'Open the design file again once it’s been fixed, or choose another.'}</p>
    <div class="fail-actions">${actions.map((a, i) => `<button type="button" class="btn${a.primary ? ' btn-primary' : ''}" data-act="${i}">${esc(a.label)}</button>`).join('')}</div>`;
  el.querySelector('[data-close]').addEventListener('click', () => onClose?.());
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => actions[Number(b.dataset.act)].run()));
}

// The soil under the building and the foundation chosen for it (design.site.soil).
function soilBlock(soil) {
  if (!soil) return '';
  const rows = [
    ['Soil', [soil.name, soil.uscsClass && `class ${soil.uscsClass}`].filter(Boolean).join(', ')],
    ['Bearing', soil.bearingPsf ? `${fmt.int(soil.bearingPsf)} psf` : null],
    ['Shrink-swell', soil.shrinkSwell],
    ['Bedrock', soil.depthToBedrockIn ? `${soil.depthToBedrockIn} in down` : null],
    ['Water table', soil.depthToWaterTableIn ? `${soil.depthToWaterTableIn} in down` : null],
    ['Foundation', soil.foundation],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<h3 class="group-title">The ground</h3>
    <dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${soil.foundationReason ? `<p class="note">${esc(soil.foundationReason)}${soil.source ? ` Soil data: ${esc(soil.source)}.` : ''}</p>` : ''}`;
}

// Where the money goes, and how it sits against the budget (cost.breakdown).
function breakdownBlock(b) {
  if (!b) return '';
  const rows = [['Materials', b.materials], ['Installed work', b.installedWork], ['Labor', b.labor], ['Site work', b.siteWork],
    ['Overhead and profit', b.overheadAndProfit], ['Permits and design', b.permitsAndDesign]].filter(([, v]) => v);
  const budget = b.budgetUSD
    ? (b.overBudgetBy ? `<p class="problem">${fmt.money(b.overBudgetBy)} over the ${fmt.money(b.budgetUSD)} budget.</p>` : `<p class="note">Within the ${fmt.money(b.budgetUSD)} budget.</p>`)
    : '';
  return `<h3 class="group-title">Where the money goes</h3>${budget}
    <table class="lines num"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="r">${fmt.money(v)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="r">${fmt.money(b.total)}</td></tr></tfoot></table>
    ${b.wageFactor ? `<p class="note">Labor is priced at ${Math.round(b.wageFactor * 100)}% of the national average, from local construction wages.</p>` : ''}`;
}

// Building suppliers near the land (cost.suppliers).
function suppliersBlock(list) {
  if (!list?.length) return '';
  return `<h3 class="group-title">Suppliers nearby</h3>
    <table class="lines num"><tbody>${list.map((s) => `<tr><td>${esc(s.Name)}<span class="unit"> · ${esc(String(s.Type || '').replace(/_/g, ' '))}</span></td><td class="r">${s.Miles != null ? `${Number(s.Miles).toFixed(1)} mi` : ''}</td></tr>`).join('')}</tbody></table>`;
}
