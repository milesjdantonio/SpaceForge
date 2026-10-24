// The brief: what the house should be, and whether this is a private dream or a builder's listing.

import { fmt } from '../format.js';
import { problemsFor } from '../lib/place.js';
import { icon } from '../ui/icons.js';

export const STYLES = [
  ['modern', 'Modern', 'Flat roofs, long glass walls'],
  ['farmhouse', 'Farmhouse', 'Steep gables, a deep porch'],
  ['craftsman', 'Craftsman', 'Low gables, deep eaves'],
  ['cabin', 'Cabin', 'Steep roof, timber walls'],
  ['mediterranean', 'Mediterranean', 'Stucco, low tile hips'],
  ['prairie', 'Prairie', 'Long, low, wide eaves'],
];
const PRIORITIES = [['efficiency', 'Energy efficiency'], ['maintenance', 'Low maintenance'], ['light', 'Daylight'], ['privacy', 'Privacy'], ['accessible', 'Step-free living']];
const EXTRAS = [['office', 'Home office'], ['porch', 'Porch'], ['deck', 'Deck or terrace'], ['basement', 'Basement']];

export const DEFAULT_BRIEF = {
  style: 'farmhouse', areaM2: 195, floors: 2, bedrooms: 3, bathrooms: 2, garage: 1,
  extras: [], priorities: ['light'], quality: 'standard', budget: 650000,
  structure: null, cladding: null, roofing: null, notes: '',
};

export function renderBriefPanel(el, { site, measure: m, onEditOutline, onChange, onSend }) {
  const brief = { ...DEFAULT_BRIEF, ...(site.brief || {}) };
  const builder = { name: '', company: '', email: '', landowner: '', permission: false, ...(site.builder || {}) };
  let mode = site.mode || 'dream';
  const problems = problemsFor(m);

  const areaMin = 60, areaMax = 650;
  const toDisp = (m2) => Math.round(fmt.toDisplayArea(m2) / (fmt.unitArea() === 'm²' ? 5 : 50)) * (fmt.unitArea() === 'm²' ? 5 : 50);

  el.innerHTML = `
    <header class="panel-head">
      <div>
        <h2 class="panel-title">Your land</h2>
        <p class="panel-sub">${site.preview ? 'Previewed with the sample house' : 'Outlined on the map'}</p>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>

    <dl class="facts num">
      <div><dt>Area</dt><dd>${fmt.land(m.areaM2)}</dd></div>
      <div><dt>Buildable</dt><dd>${m.buildableM2 ? fmt.land(m.buildableM2) : '–'}</dd></div>
      <div><dt>Around</dt><dd>${fmt.len(m.perimeterM)}</dd></div>
      <div><dt>Longest side</dt><dd>${fmt.len(m.longestEdgeM)}, ${fmt.bearing(m.longestEdgeBearing)}</dd></div>
    </dl>
    <p class="note">Buildable area keeps ${fmt.len(3)} back from every boundary. Local setbacks may differ.</p>
    ${problems.length ? `<p class="problem">${problems[0]}</p>` : ''}
    <button type="button" class="text-link edit-outline" data-edit>Adjust the outline</button>

    <form class="brief" novalidate>
      <h3 class="group-title">The house</h3>

      <fieldset class="styles">
        <legend class="label">Style</legend>
        <div class="style-grid">
          ${STYLES.map(([id, name, blurb]) => `
            <label class="style-option">
              <input type="radio" name="style" value="${id}" ${brief.style === id ? 'checked' : ''}>
              <span class="style-card"><span class="style-name">${name}</span><span class="style-blurb">${blurb}</span></span>
            </label>`).join('')}
        </div>
      </fieldset>

      <div class="field">
        <label for="area">Size <output class="num" id="area-out"></output></label>
        <input type="range" id="area" name="areaM2" min="${areaMin}" max="${areaMax}" step="5" value="${brief.areaM2}">
        <p class="note">Finished living space, not counting the garage.</p>
      </div>

      <div class="row-3">
        ${stepper('floors', 'Floors', brief.floors, 1, 3)}
        ${stepper('bedrooms', 'Bedrooms', brief.bedrooms, 1, 7)}
        ${stepper('bathrooms', 'Bathrooms', brief.bathrooms, 1, 6)}
      </div>

      <div class="field">
        <span class="label">Garage</span>
        <div class="seg" role="radiogroup" aria-label="Garage">
          ${[[0, 'None'], [1, '1 car'], [2, '2 cars'], [3, '3 cars']].map(([v, t]) => `<label><input type="radio" name="garage" value="${v}" ${brief.garage === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
        </div>
      </div>

      <div class="field">
        <span class="label">Finishes</span>
        <div class="seg" role="radiogroup" aria-label="Finishes">
          ${[['essential', 'Essential'], ['standard', 'Standard'], ['premium', 'Premium']].map(([v, t]) => `<label><input type="radio" name="quality" value="${v}" ${brief.quality === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
        </div>
      </div>

      <div class="field">
        <label for="budget">Budget for the build</label>
        <div class="input-money"><span>$</span><input class="input num" id="budget" name="budget" inputmode="numeric" value="${brief.budget ? brief.budget.toLocaleString('en-US') : ''}" placeholder="No limit"></div>
      </div>

      <fieldset class="chips">
        <legend class="label">What matters most</legend>
        ${PRIORITIES.map(([v, t]) => `<label class="chip"><input type="checkbox" name="priorities" value="${v}" ${brief.priorities.includes(v) ? 'checked' : ''}><span>${t}</span></label>`).join('')}
      </fieldset>

      <fieldset class="chips">
        <legend class="label">Extras</legend>
        ${EXTRAS.map(([v, t]) => `<label class="chip"><input type="checkbox" name="extras" value="${v}" ${brief.extras.includes(v) ? 'checked' : ''}><span>${t}</span></label>`).join('')}
      </fieldset>

      <div class="field">
        <label for="notes">Anything else</label>
        <textarea class="input" id="notes" name="notes" maxlength="600" placeholder="A view to keep, a tree to save, a room you need">${brief.notes || ''}</textarea>
      </div>

      <h3 class="group-title">Who it’s for</h3>
      <div class="seg mode-seg" role="radiogroup" aria-label="Who it's for">
        <label><input type="radio" name="mode" value="dream" ${mode === 'dream' ? 'checked' : ''}><span>Just me, privately</span></label>
        <label><input type="radio" name="mode" value="build" ${mode === 'build' ? 'checked' : ''}><span>A listing I’ll build</span></label>
      </div>
      <p class="note mode-note"></p>

      <div class="builder" ${mode === 'build' ? '' : 'hidden'}>
        <div class="row-2">
          <div class="field"><label for="b-name">Your name</label><input class="input" id="b-name" name="b-name" autocomplete="name" value="${esc(builder.name)}"></div>
          <div class="field"><label for="b-company">Company</label><input class="input" id="b-company" name="b-company" autocomplete="organization" value="${esc(builder.company)}"></div>
        </div>
        <div class="field"><label for="b-email">Email for inquiries</label><input class="input" id="b-email" name="b-email" type="email" autocomplete="email" value="${esc(builder.email)}"></div>
        <div class="field"><label for="b-owner">Landowner’s name</label><input class="input" id="b-owner" name="b-owner" value="${esc(builder.landowner)}"></div>
        <label class="check"><input type="checkbox" name="b-permission" ${builder.permission ? 'checked' : ''}><span>I have the landowner’s permission to design for this land and list the design.</span></label>
      </div>

      <div class="send-row">
        <button type="submit" class="btn btn-primary btn-wide" data-send>Send to the design service</button>
        <p class="note send-note" aria-live="polite"></p>
      </div>
    </form>`;

  const form = el.querySelector('form');
  const areaOut = el.querySelector('#area-out');
  const builderBox = el.querySelector('.builder');
  const modeNote = el.querySelector('.mode-note');
  const sendBtn = el.querySelector('[data-send]');
  const sendNote = el.querySelector('.send-note');

  const read = () => {
    const fd = new FormData(form);
    const budget = Number(String(fd.get('budget') || '').replace(/[^0-9]/g, '')) || null;
    return {
      brief: {
        style: fd.get('style'),
        areaM2: Number(fd.get('areaM2')),
        floors: Number(fd.get('floors')),
        bedrooms: Number(fd.get('bedrooms')),
        bathrooms: Number(fd.get('bathrooms')),
        garage: Number(fd.get('garage')),
        quality: fd.get('quality'),
        budget,
        priorities: fd.getAll('priorities'),
        extras: fd.getAll('extras'),
        notes: String(fd.get('notes') || '').trim(),
        structure: null, cladding: null, roofing: null,
      },
      mode: fd.get('mode'),
      builder: {
        name: String(fd.get('b-name') || '').trim(),
        company: String(fd.get('b-company') || '').trim(),
        email: String(fd.get('b-email') || '').trim(),
        landowner: String(fd.get('b-owner') || '').trim(),
        permission: fd.get('b-permission') === 'on',
      },
    };
  };

  const validate = (v) => {
    if (problems.length) return problems[0];
    if (v.mode === 'build') {
      if (!v.builder.name) return 'Add your name so buyers know who they’re writing to.';
      if (!/^\S+@\S+\.\S+$/.test(v.builder.email)) return 'Add an email address for inquiries.';
      if (!v.builder.landowner) return 'Add the landowner’s name.';
      if (!v.builder.permission) return 'Confirm you have the landowner’s permission to list this design.';
    }
    return '';
  };

  const sync = () => {
    const v = read();
    areaOut.textContent = `${fmt.area(v.brief.areaM2)}`;
    mode = v.mode;
    builderBox.hidden = mode !== 'build';
    modeNote.textContent = mode === 'build'
      ? 'Listings appear in the catalog, and inquiries go to you.'
      : 'Only you see it. Share it with a link if you like; it is never listed.';
    const problem = validate(v);
    sendBtn.disabled = !!problem;
    sendNote.textContent = problem;
    onChange({ brief: v.brief, mode: v.mode, builder: v.builder });
  };

  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (!step) return;
    const input = form.elements[step.dataset.name];
    const v = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + Number(step.dataset.step)));
    input.value = v;
    form.querySelector(`[data-show="${step.dataset.name}"]`).textContent = v;
    sync();
  });
  form.elements.budget.addEventListener('blur', (e) => {
    const n = Number(e.target.value.replace(/[^0-9]/g, ''));
    e.target.value = n ? n.toLocaleString('en-US') : '';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = read();
    if (validate(v)) return;
    onChange(v);
    onSend();
  });
  el.querySelector('[data-edit]').addEventListener('click', onEditOutline);
  void toDisp;
  sync();
}

function stepper(name, label, value, min, max) {
  return `<div class="field stepper">
    <span class="label" id="${name}-l">${label}</span>
    <div class="stepper-row" role="group" aria-labelledby="${name}-l">
      <button type="button" class="btn btn-small btn-icon" data-step="-1" data-name="${name}" aria-label="Fewer ${label.toLowerCase()}">−</button>
      <output class="num" data-show="${name}">${value}</output>
      <button type="button" class="btn btn-small btn-icon" data-step="1" data-name="${name}" aria-label="More ${label.toLowerCase()}">+</button>
      <input type="hidden" name="${name}" value="${value}" min="${min}" max="${max}">
    </div>
  </div>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
