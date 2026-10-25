// The brief: what to build on this land. Each required question is its own box and shows its own
// error when it's empty or out of range; optional questions sit in the Advanced menu at the bottom,
// where anything left blank is decided by the design system. Rules live in lib/housing.js.

import { fmt } from '../format.js';
import { problemsFor } from '../lib/place.js';
import { landFit, fitMessage } from '../lib/fit.js';
import { icon } from '../ui/icons.js';
import { mountRive } from '../rive.js';
import {
  HOUSING_TYPES, BRIEF_RULES, ROOM_TYPES, requiredFields, fieldLabel, fieldHint, briefProblems,
  STYLE_IDEAS, PROMPT_MAX, QUALITY, STRUCTURE, CLADDING, ROOFING, PRIORITIES, EXTRAS, BATHROOM_SHARING, COMMON_SPACES, UNIT_MIX,
  EMPTY_ADVANCED, advancedFields, advancedProblems, aiDecides, typeName,
} from '../lib/housing.js';

export const EMPTY_FORM = {
  housingType: null,
  answers: { designPrompt: '', floors: null, areaM2: null, unitCount: null, bedrooms: null, bathrooms: null, residents: null, roomType: null, budgetUSD: null, noBudgetLimit: false, areaByAI: false },
  advanced: structuredClone(EMPTY_ADVANCED),
};

const STEP = { floors: 1, unitCount: 1, bedrooms: 1, bathrooms: 0.5, residents: 1 };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (s) => {
  const t = String(s ?? '').replace(/[^0-9.]/g, '');
  return t === '' ? null : Number(t);
};

export function renderBriefPanel(el, { site, measure: m, onEditOutline, onChange, onSend, coverage }) {
  const form = structuredClone(EMPTY_FORM);
  if (site.form) {
    form.housingType = site.form.housingType ?? null;
    Object.assign(form.answers, site.form.answers || {});
    Object.assign(form.advanced, structuredClone(site.form.advanced || {}));
  }
  const builder = { name: '', company: '', email: '', landowner: '', permission: false, ...(site.builder || {}) };
  let mode = site.mode || 'dream';
  let tried = false;           // after the first send attempt, every problem shows
  const touched = new Set();   // boxes the user has left, which show their own problem
  const siteProblems = problemsFor(m);

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
    ${siteProblems.length ? `<p class="problem">${siteProblems[0]}</p>` : ''}
    <div class="coverage-alert" data-coverage role="alert" hidden></div>
    <button type="button" class="text-link edit-outline" data-edit>Adjust the outline</button>

    <form class="brief" novalidate>
      <section class="qgroup" aria-labelledby="g-type">
        <h3 class="group-title" id="g-type">What are you building?</h3>
        <div class="qbox qbox-type" data-field="housingType">
          <div class="type-grid" role="radiogroup" aria-label="Housing type" aria-describedby="err-housingType">
            ${HOUSING_TYPES.map((t) => `
              <label class="type-option">
                <input type="radio" name="housingType" value="${t.id}" ${form.housingType === t.id ? 'checked' : ''}>
                <span class="type-card">
                  <span class="type-art" data-type-art="${t.id}">${icon(`type-${t.id}`)}</span>
                  <span class="type-name">${t.name}</span>
                  <span class="type-blurb">${t.blurb}</span>
                </span>
              </label>`).join('')}
          </div>
          <p class="type-said" data-type-said aria-live="polite"></p>
          <p class="qerror" id="err-housingType" role="alert"></p>
        </div>
      </section>

      <section class="qgroup" aria-labelledby="g-prompt">
        <h3 class="group-title" id="g-prompt">Describe the design</h3>
        <div class="qbox qbox-wide qbox-prompt" data-field="designPrompt">
          <label class="qlabel" for="q-designPrompt">The building and its style, in your words</label>
          <textarea id="q-designPrompt" name="designPrompt" class="input qcontrol prompt-input" rows="4" maxlength="${PROMPT_MAX}" placeholder="A bright modern farmhouse that opens to the view, with a big kitchen at its heart and a quiet office away from the bedrooms." aria-describedby="hint-designPrompt err-designPrompt">${esc(form.answers.designPrompt)}</textarea>
          <div class="prompt-ideas" role="group" aria-label="Add a style to your description">
            ${STYLE_IDEAS.map(([name, text]) => `<button type="button" class="idea" data-idea="${esc(text)}">${icon('plus')}<span>${name}</span></button>`).join('')}
          </div>
          <p class="qhint" id="hint-designPrompt">This is what the design system reads first. Say the style, how it should feel, and anything to keep or avoid. <span class="prompt-count num" data-count></span></p>
          <p class="qerror" id="err-designPrompt" role="alert"></p>
        </div>
      </section>

      <section class="qgroup" aria-labelledby="g-basics" data-basics></section>
      <div class="fit-check" data-fit aria-live="polite" hidden></div>

      <section class="qgroup" aria-labelledby="g-mode">
        <h3 class="group-title" id="g-mode">Who it’s for</h3>
        <div class="seg mode-seg" role="radiogroup" aria-label="Who it's for">
          <label><input type="radio" name="mode" value="dream" ${mode === 'dream' ? 'checked' : ''}><span>Just me, privately</span></label>
          <label><input type="radio" name="mode" value="build" ${mode === 'build' ? 'checked' : ''}><span>A listing I’ll build</span></label>
        </div>
        <p class="note mode-note"></p>
        <div class="builder" ${mode === 'build' ? '' : 'hidden'}>
          ${textBox('b-name', 'Your name', builder.name, { autocomplete: 'name' })}
          ${textBox('b-company', 'Company', builder.company, { autocomplete: 'organization', optional: true })}
          ${textBox('b-email', 'Email for inquiries', builder.email, { autocomplete: 'email', type: 'email' })}
          ${textBox('b-owner', 'Landowner’s name', builder.landowner)}
          <div class="qbox qbox-plain" data-field="b-permission">
            <label class="check"><input type="checkbox" name="b-permission" ${builder.permission ? 'checked' : ''} aria-describedby="err-b-permission"><span>I have the landowner’s permission to design for this land and list the design.</span></label>
            <p class="qerror" id="err-b-permission" role="alert"></p>
          </div>
        </div>
      </section>

      <details class="advanced" data-advanced>
        <summary>
          <span class="adv-title">Advanced</span>
          <span class="adv-sub">Optional. Anything you leave blank, the design system decides.</span>
          <span class="adv-count num" data-adv-count></span>
        </summary>
        <div class="adv-body" data-adv-body></div>
      </details>

      <div class="send-row">
        <p class="send-summary" data-summary aria-live="polite"></p>
        <button type="submit" class="btn btn-primary btn-wide" data-send>Send to the design service</button>
      </div>
    </form>`;

  const formEl = el.querySelector('form');
  const basics = el.querySelector('[data-basics]');
  const advBody = el.querySelector('[data-adv-body]');
  const builderBox = el.querySelector('.builder');
  const modeNote = el.querySelector('.mode-note');
  const summary = el.querySelector('[data-summary]');
  const fitBox = el.querySelector('[data-fit]');

  // Housing type pictures: Rive when it loads, the icon otherwise.
  for (const slot of el.querySelectorAll('[data-type-art]')) {
    const id = slot.dataset.typeArt;
    const card = slot.closest('.type-option');
    const h = mountRive(slot, { src: 'assets/rive/types.riv', artboard: typeArtboard(id), stateMachine: 'Type', hoverInput: 'hover', hoverTarget: card });
    if (h) slot.__rive = h;
  }
  const syncTypeArt = () => {
    for (const slot of el.querySelectorAll('[data-type-art]')) slot.__rive?.set('selected', slot.dataset.typeArt === form.housingType);
  };

  // ---- the basics ------------------------------------------------------------------------------
  function renderBasics() {
    const type = form.housingType;
    if (!type) {
      basics.innerHTML = `<h3 class="group-title" id="g-basics">The basics</h3><p class="note">Choose a type above and its questions appear here.</p>`;
      return;
    }
    const fields = requiredFields(type);
    basics.innerHTML = `
      <h3 class="group-title" id="g-basics">${typeName(type)}: the basics</h3>
      <p class="note">Every box here is needed.</p>
      <div class="qgrid">${fields.map((f) => basicBox(f, type)).join('')}</div>`;
  }

  function basicBox(f, type) {
    const a = form.answers;
    const hint = fieldHint(f, type);
    const label = fieldLabel(f, type);
    const err = `<p class="qerror" id="err-${f}" role="alert"></p>`;
    if (f === 'roomType') {
      return `<div class="qbox qbox-wide" data-field="roomType">
        <span class="qlabel" id="l-roomType">${label}</span>
        <div class="seg" role="radiogroup" aria-labelledby="l-roomType" aria-describedby="err-roomType">
          ${ROOM_TYPES.map(([v, t]) => `<label><input type="radio" name="roomType" value="${v}" ${a.roomType === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
        </div>${err}</div>`;
    }
    if (f === 'budgetUSD') {
      return `<div class="qbox qbox-wide" data-field="budgetUSD">
        <label class="qlabel" for="q-budgetUSD">${label}</label>
        <div class="qinput"><span class="qaffix">$</span><input id="q-budgetUSD" name="budgetUSD" class="qcontrol num" inputmode="numeric" autocomplete="off" placeholder="Amount in US dollars" value="${a.budgetUSD ? a.budgetUSD.toLocaleString('en-US') : ''}" ${a.noBudgetLimit ? 'disabled' : ''} aria-describedby="err-budgetUSD"></div>
        <label class="check check-small"><input type="checkbox" name="noBudgetLimit" ${a.noBudgetLimit ? 'checked' : ''}><span>No limit</span></label>
        ${err}</div>`;
    }
    const isArea = f === 'areaM2';
    const shown = a[f] == null ? '' : isArea ? Math.round(fmt.toDisplayArea(a[f])) : a[f];
    const [lo, hi] = BRIEF_RULES[type][f];
    const range = isArea ? `${fmt.area(lo)} to ${fmt.area(hi)}` : `${lo} to ${hi}`;
    const byAI = isArea && a.areaByAI;
    return `<div class="qbox${byAI ? ' is-ai' : ''}" data-field="${f}">
      <label class="qlabel" for="q-${f}">${label}</label>
      <div class="qinput">
        <button type="button" class="qstep" data-step="-1" data-for="${f}" aria-label="Less" ${byAI ? 'disabled' : ''}>${icon('minus')}</button>
        <input id="q-${f}" name="${f}" class="qcontrol num" inputmode="decimal" autocomplete="off" placeholder="${byAI ? 'Gemma decides' : '–'}" value="${byAI ? '' : shown}" ${byAI ? 'disabled' : ''} aria-describedby="hint-${f} err-${f}">
        ${isArea ? `<span class="qaffix">${fmt.unitArea()}</span>` : ''}
        <button type="button" class="qstep" data-step="1" data-for="${f}" aria-label="More" ${byAI ? 'disabled' : ''}>${icon('plus')}</button>
      </div>
      ${isArea ? `<label class="check check-small"><input type="checkbox" name="areaByAI" ${byAI ? 'checked' : ''}><span>Let Gemma choose the size</span></label>` : ''}
      <p class="qhint" id="hint-${f}">${byAI ? 'Gemma sizes it from the bedrooms, budget and land. ' : hint ? `${hint} ` : ''}<span class="num">${range}</span></p>
      ${err}</div>`;
  }

  // ---- advanced --------------------------------------------------------------------------------
  function renderAdvanced() {
    const type = form.housingType;
    const adv = form.advanced;
    if (!type) { advBody.innerHTML = '<p class="note">Choose a type first.</p>'; return; }
    const show = new Set(advancedFields(type));
    const seg = (name, opts, value, label) => `<div class="qbox qbox-wide" data-field="${name}">
      <span class="qlabel" id="l-${name}">${label}</span>
      <div class="seg" role="radiogroup" aria-labelledby="l-${name}">
        <label><input type="radio" name="${name}" value="" ${value == null ? 'checked' : ''}><span>Decide for me</span></label>
        ${opts.map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}" ${String(value) === String(v) ? 'checked' : ''}><span>${t}</span></label>`).join('')}
      </div><p class="qerror" id="err-${name}" role="alert"></p></div>`;
    const select = (name, opts, value, label) => `<div class="qbox" data-field="${name}">
      <label class="qlabel" for="a-${name}">${label}</label>
      <select class="select qcontrol" id="a-${name}" name="${name}">
        <option value="">Decide for me</option>
        ${opts.map(([v, t]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>`;
    const chips = (name, opts, values, label) => `<fieldset class="qbox qbox-wide chips" data-field="${name}">
      <legend class="qlabel">${label}</legend>
      ${opts.map(([v, t]) => `<label class="chip"><input type="checkbox" name="${name}" value="${v}" ${values.includes(v) ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </fieldset>`;

    const parts = [];
    if (show.has('quality')) parts.push(seg('quality', QUALITY, adv.quality, 'Finishes'));
    if (show.has('garage')) parts.push(seg('garage', [[0, 'None'], [1, '1 car'], [2, '2 cars'], [3, '3 cars']], adv.garage, type === 'townhouse' || type === 'duplex' ? 'Garage for each home' : 'Garage'));
    if (show.has('parkingSpaces')) {
      parts.push(`<div class="qbox" data-field="parkingSpaces">
        <label class="qlabel" for="a-parkingSpaces">Parking spaces</label>
        <div class="qinput"><input id="a-parkingSpaces" name="parkingSpaces" class="qcontrol num" inputmode="numeric" placeholder="Decide for me" value="${adv.parkingSpaces ?? ''}"></div>
        <p class="qhint">For the whole site.</p><p class="qerror" id="err-parkingSpaces" role="alert"></p></div>`);
    }
    parts.push(`<div class="qgrid qgrid-3">
      ${select('structure', STRUCTURE, adv.structure, 'Structure')}
      ${select('cladding', CLADDING, adv.cladding, 'Outside walls')}
      ${select('roofing', ROOFING, adv.roofing, 'Roof')}
    </div>`);
    parts.push(chips('priorities', PRIORITIES, adv.priorities, 'What matters most'));
    parts.push(chips('extras', EXTRAS, adv.extras, 'Extras'));
    if (show.has('unitMix')) {
      parts.push(`<fieldset class="qbox qbox-wide" data-field="unitMix">
        <legend class="qlabel">Mix of homes</legend>
        <div class="qgrid qgrid-4">
          ${UNIT_MIX.map(([k, t]) => `<label class="mini"><span>${t}</span><input class="qcontrol num" name="mix-${k}" inputmode="numeric" placeholder="–" value="${adv.unitMix?.[k] ?? ''}"></label>`).join('')}
        </div>
        <p class="qhint">Leave all blank to let the design system choose. If you fill any, they should add up to the number of homes.</p>
        <p class="qerror" id="err-unitMix" role="alert"></p></fieldset>`);
    }
    if (show.has('bathroomSharing')) parts.push(seg('bathroomSharing', BATHROOM_SHARING, adv.bathroomSharing, 'Bathrooms'));
    if (show.has('commonSpaces')) parts.push(chips('commonSpaces', COMMON_SPACES, adv.commonSpaces, 'Shared spaces'));
    advBody.innerHTML = parts.join('');
  }

  // ---- reading and checking --------------------------------------------------------------------
  function read() {
    const fd = new FormData(formEl);
    form.housingType = fd.get('housingType') || null;
    const a = form.answers;
    for (const f of ['floors', 'unitCount', 'bedrooms', 'bathrooms', 'residents']) {
      if (formEl.elements[f]) a[f] = num(fd.get(f));
    }
    if (formEl.elements.areaByAI) a.areaByAI = fd.get('areaByAI') === 'on';
    if (formEl.elements.areaM2 && !a.areaByAI) {
      const v = num(fd.get('areaM2'));
      a.areaM2 = v == null ? null : Math.round(fmt.fromDisplayArea(v) * 10) / 10;
    }
    if (formEl.elements.roomType) a.roomType = fd.get('roomType') || null;
    if (formEl.elements.noBudgetLimit) {
      a.noBudgetLimit = fd.get('noBudgetLimit') === 'on';
      a.budgetUSD = num(fd.get('budgetUSD'));
    }
    const adv = form.advanced;
    if (advBody.querySelector('[name]')) {
      const one = (k) => (formEl.elements[k] ? (fd.get(k) || null) : adv[k]);
      adv.quality = one('quality');
      adv.garage = formEl.elements.garage ? (fd.get('garage') === '' || fd.get('garage') == null ? null : Number(fd.get('garage'))) : adv.garage;
      adv.parkingSpaces = formEl.elements.parkingSpaces ? num(fd.get('parkingSpaces')) : adv.parkingSpaces;
      adv.structure = one('structure');
      adv.cladding = one('cladding');
      adv.roofing = one('roofing');
      adv.priorities = fd.getAll('priorities');
      adv.extras = fd.getAll('extras');
      if (formEl.elements['mix-studio']) for (const [k] of UNIT_MIX) adv.unitMix[k] = num(fd.get(`mix-${k}`));
      adv.bathroomSharing = formEl.elements.bathroomSharing ? one('bathroomSharing') : adv.bathroomSharing;
      if (formEl.elements.commonSpaces || advBody.querySelector('[name="commonSpaces"]')) adv.commonSpaces = fd.getAll('commonSpaces');
    }
    a.designPrompt = String(fd.get('designPrompt') ?? '');
    mode = fd.get('mode');
    Object.assign(builder, {
      name: String(fd.get('b-name') || '').trim(),
      company: String(fd.get('b-company') || '').trim(),
      email: String(fd.get('b-email') || '').trim(),
      landowner: String(fd.get('b-owner') || '').trim(),
      permission: fd.get('b-permission') === 'on',
    });
  }

  function problems() {
    const p = { ...briefProblems(form.housingType, form.answers, fmt.area) };
    if (form.housingType) Object.assign(p, advancedProblems(form.housingType, form.advanced, form.answers.unitCount));
    if (mode === 'build') {
      if (!builder.name) p['b-name'] = 'Add your name so buyers know who they’re writing to.';
      if (!/^\S+@\S+\.\S+$/.test(builder.email)) p['b-email'] = builder.email ? 'That email address doesn’t look complete.' : 'Add an email address for inquiries.';
      if (!builder.landowner) p['b-owner'] = 'Add the landowner’s name.';
      if (!builder.permission) p['b-permission'] = 'Confirm you have the landowner’s permission to list this design.';
    }
    return p;
  }

  function showProblems(p) {
    for (const box of el.querySelectorAll('.qbox[data-field]')) {
      const f = box.dataset.field;
      const msg = p[f] && (tried || touched.has(f)) ? p[f] : '';
      box.classList.toggle('has-error', !!msg);
      const out = box.querySelector('.qerror');
      if (out) out.innerHTML = msg ? `${icon('alert')}<span>${msg}</span>` : '';
      box.querySelector('.qcontrol, input')?.setAttribute('aria-invalid', String(!!msg));
    }
    const n = Object.keys(p).length + (siteProblems.length ? 1 : 0);
    summary.textContent = siteProblems.length ? siteProblems[0]
      : tried && n ? `${n === 1 ? 'One box needs' : `${n} boxes need`} an answer before sending.`
      : '';
    summary.classList.toggle('is-error', !!(siteProblems.length || (tried && n)));
    // Advanced boxes with a problem open the menu so the error is seen.
    if (tried && ['unitMix', 'parkingSpaces'].some((k) => p[k])) el.querySelector('[data-advanced]').open = true;
  }

  function sync() {
    read();
    const type = form.housingType;
    builderBox.hidden = mode !== 'build';
    modeNote.textContent = mode === 'build'
      ? 'Listings appear in the catalog, and inquiries go to you.'
      : 'Only you see it. Share it with a link if you like; it is never listed.';
    const chosen = type ? advancedFields(type).length - aiDecides(type, form.advanced).length : 0;
    el.querySelector('[data-adv-count]').textContent = chosen ? `${chosen} set` : '';
    syncTypeArt();
    el.querySelector('[data-type-said]').textContent = type ? HOUSING_TYPES.find((t) => t.id === type).blurb + '.' : '';
    const n = form.answers.designPrompt.trim().length;
    el.querySelector('[data-count]').textContent = n ? `${n} / ${PROMPT_MAX}` : '';
    showProblems(problems());
    showFit();
    onChange({ form: structuredClone(form), mode, builder: { ...builder } });
  }

  // How the building the brief describes sits on this land, before anything is sent.
  function showFit() {
    const fit = landFit(form.housingType, form.answers, form.advanced, m);
    const msg = fitMessage(fit, fmt);
    fitBox.hidden = !msg;
    if (!msg) { fitBox.replaceChildren(); return; }
    fitBox.dataset.level = fit.level;
    const bar = fit.share != null
      ? `<div class="fit-bar" role="img" aria-label="Uses ${Math.round(fit.share * 100)}% of the buildable land"><span style="width:${Math.min(100, fit.share * 100).toFixed(1)}%"></span></div>`
      : '';
    fitBox.innerHTML = `${icon(fit.level === 'ok' || fit.level === 'ai' ? 'check' : 'alert')}<div><strong>${msg.title}</strong><p>${msg.text}</p>${bar}</div>`;
  }

  // ---- events ----------------------------------------------------------------------------------
  formEl.addEventListener('change', (e) => {
    if (e.target.name === 'housingType') {
      read();
      renderBasics();
      renderAdvanced();
      touched.delete('housingType');
    }
    if (e.target.name === 'areaByAI') {
      read();
      renderBasics();
      touched.delete('areaM2');
    }
    if (e.target.name === 'noBudgetLimit') {
      const input = formEl.elements.budgetUSD;
      input.disabled = e.target.checked;
      if (e.target.checked) input.value = '';
      touched.add('budgetUSD');
    }
    sync();
  });
  formEl.addEventListener('input', sync);
  formEl.addEventListener('focusout', (e) => {
    const box = e.target.closest('.qbox[data-field]');
    if (!box || box.contains(e.relatedTarget)) return;
    // A box shows its problem once it has something in it, or after a send attempt.
    if (String(e.target.value ?? '').trim() !== '') touched.add(box.dataset.field);
    if (e.target.name === 'budgetUSD') {
      const n = num(e.target.value);
      e.target.value = n ? n.toLocaleString('en-US') : '';
    }
    showProblems(problems());
  });
  formEl.addEventListener('click', (e) => {
    // A style idea adds its words to the description, where the user can edit them.
    const idea = e.target.closest('[data-idea]');
    if (idea) {
      const box = formEl.elements.designPrompt;
      const cur = box.value.trim();
      const add = idea.dataset.idea;
      const text = cur ? `${cur}${/[.!?]$/.test(cur) ? '' : '.'} ${add[0].toUpperCase()}${add.slice(1)}.` : `${add[0].toUpperCase()}${add.slice(1)}.`;
      box.value = text.slice(0, PROMPT_MAX);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      sync();
      return;
    }
    const step = e.target.closest('[data-step]');
    if (!step) return;
    const f = step.dataset.for;
    const input = formEl.elements[f];
    const isArea = f === 'areaM2';
    const [lo, hi] = BRIEF_RULES[form.housingType][f];
    const stepBy = isArea ? (fmt.unitArea() === 'm²' ? 5 : 50) : STEP[f];
    const loD = isArea ? Math.ceil(fmt.toDisplayArea(lo) / stepBy) * stepBy : lo;
    const hiD = isArea ? Math.floor(fmt.toDisplayArea(hi) / stepBy) * stepBy : hi;
    const cur = num(input.value);
    let next;
    if (cur == null) next = Number(step.dataset.step) > 0 ? loD : hiD;
    else next = Math.round((cur + stepBy * Number(step.dataset.step)) / stepBy) * stepBy;
    input.value = Math.max(loD, Math.min(hiD, next));
    touched.add(f);
    sync();
  });
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    read();
    tried = true;
    const p = problems();
    showProblems(p);
    if (siteProblems.length) return;
    const first = Object.keys(p)[0];
    if (first) {
      const box = el.querySelector(`.qbox[data-field="${first}"]`);
      if (box?.closest('details')) box.closest('details').open = true;
      box?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      (box?.querySelector('input:not([type=hidden]):not(:disabled), select, textarea'))?.focus({ preventScroll: true });
      return;
    }
    onChange({ form: structuredClone(form), mode, builder: { ...builder } });
    onSend();
  });
  el.querySelector('[data-edit]').addEventListener('click', onEditOutline);

  renderBasics();
  renderAdvanced();
  sync();

  // Whether the design service has site data for this land; if not, say so before anything is sent.
  coverage?.then((c) => {
    if (!c || c.covered !== false || !el.isConnected) return;
    const box = el.querySelector('[data-coverage]');
    box.innerHTML = `${icon('alert')}<div><strong>No site data for this land</strong><p>${esc(c.message)}</p></div>`;
    box.hidden = false;
    siteProblems.push('No site data for this land, so it can’t be designed yet.');
    showProblems(problems());
  });
}

function textBox(id, label, value, { autocomplete, type = 'text', optional = false } = {}) {
  return `<div class="qbox qbox-plain" data-field="${id}">
    <label class="qlabel" for="${id}">${label}${optional ? ' <span class="optional">(optional)</span>' : ''}</label>
    <input class="input qcontrol" id="${id}" name="${id}" type="${type}" ${autocomplete ? `autocomplete="${autocomplete}"` : ''} value="${esc(value)}" aria-describedby="err-${id}">
    <p class="qerror" id="err-${id}" role="alert"></p>
  </div>`;
}

// Artboard names in types.riv.
export function typeArtboard(id) {
  return { house: 'House', 'tiny-home': 'Tiny', townhouse: 'Townhouse', duplex: 'Duplex', apartment: 'Apartment', condo: 'Condo', dorm: 'Dorm' }[id];
}
