// Catalog of published listings, and the visitor's own saved sites.

import { fmt } from '../format.js';
import { measure } from '../lib/place.js';
import { icon } from '../ui/icons.js';
import { renderPlan } from '../render/plan.js';
import { typeName } from '../lib/housing.js';
import { holdsLine } from './house.js';

export function renderCatalog(el, { listings, onOpen }) {
  el.innerHTML = `
    <header class="panel-head">
      <div><h2 class="panel-title">Catalog</h2><p class="panel-sub">Designs builders have published</p></div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    ${listings.length ? '' : '<p class="empty">No listings yet. When builders publish designs, they appear here.</p>'}
    <ul class="cards"></ul>
    <p class="note">Only the sample is listed until the TerraSim API is connected.</p>`;
  const ul = el.querySelector('.cards');
  for (const l of listings) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="card">
      <span class="card-plan"></span>
      <span class="card-body">
        <span class="card-title">${l.design.overview.title}</span>
        <span class="card-meta num">${typeName(l.design.housingType)} · ${holdsLine(l.design)} · ${fmt.area(l.design.totals.finishedAreaM2)}</span>
        <span class="card-price num">${fmt.money(l.estimate.buildCost.low, { short: true })}–${fmt.money(l.estimate.buildCost.high, { short: true })} to build</span>
        <span class="card-by">${l.builder.company}</span>
      </span></button>`;
    li.querySelector('.card-plan').append(renderPlan(l.design, { labels: false, dims: false, className: 'plan plan-thumb', pad: 0.6 }));
    li.querySelector('button').addEventListener('click', () => onOpen(l));
    ul.append(li);
  }
}

export function renderSites(el, { sites, onOpen, onDelete, onOpenFile, account, buildings = [], loading = false, error = '', nextOffset = null, onSignIn, onOpenBuilding, onDeleteBuilding, onMore }) {
  const statusText = { draft: 'Draft', 'not-sent': 'Not sent yet', sent: 'Sent' };
  el.innerHTML = `
    <header class="panel-head">
      <div><h2 class="panel-title">My sites</h2><p class="panel-sub">Your buildings and site drafts</p></div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    <section class="saved-buildings" aria-labelledby="saved-buildings-title">
      <h3 class="group-title" id="saved-buildings-title">Saved buildings</h3>
      <p class="note">${account ? 'Private to your account.' : 'Sign in to save buildings and open them on your next visit.'}</p>
      ${!account ? '<button type="button" class="btn btn-primary" data-library-signin>Sign in</button>' : ''}
      <p class="account-error" data-library-error role="alert" hidden></p>
      ${loading ? '<p role="status">Loading saved buildings…</p>' : ''}
      ${account && !loading && !error && !buildings.length ? '<p class="empty">No saved buildings yet. Open a design and choose Save building.</p>' : ''}
      <ul class="sites" data-buildings></ul>
      ${nextOffset != null ? '<button type="button" class="btn btn-small" data-library-more>Load more</button>' : ''}
    </section>
    <h3 class="group-title">Site drafts in this browser</h3>
    ${sites.length ? '<ul class="sites" data-drafts></ul>' : '<p class="empty">Outline some land to start a site draft.</p>'}
    <div class="file-open">
      <label class="btn btn-small">${icon('house')}<span>Open a design file</span><input type="file" accept="application/json,.json" class="sr-only" data-file></label>
      <p class="note">For checking Gemma’s output: a terrasim.design/2 JSON file, or a reply with design and estimate. It’s checked against the contract, then drawn where it stands.</p>
    </div>`;
  el.querySelector('[data-file]').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) onOpenFile?.(f); });
  el.querySelector('[data-library-signin]')?.addEventListener('click', onSignIn);
  el.querySelector('[data-library-more]')?.addEventListener('click', onMore);
  if (error) { const note = el.querySelector('[data-library-error]'); note.textContent = error; note.hidden = false; }
  for (const building of buildings) {
    const li = document.createElement('li');
    li.className = 'site-row';
    li.innerHTML = '<button type="button" class="site-open"><span class="site-name"></span><span class="site-meta"></span></button><button type="button" class="btn btn-quiet btn-icon" aria-label="Delete saved building"></button>';
    li.querySelector('.site-name').textContent = building.name;
    li.querySelector('.site-meta').textContent = 'Saved ' + new Date(building.updated_at).toLocaleDateString();
    li.querySelector('.site-open').onclick = () => onOpenBuilding(building);
    const remove = li.querySelector('.btn-icon');
    remove.innerHTML = icon('trash');
    remove.onclick = async () => {
      if (!confirm(`Delete “${building.name}” from your account?`)) return;
      remove.disabled = true;
      try { await onDeleteBuilding(building); li.remove(); }
      catch (err) { const note = el.querySelector('[data-library-error]'); note.textContent = err.message || 'Couldn’t delete the building.'; note.hidden = false; remove.disabled = false; }
    };
    el.querySelector('[data-buildings]').append(li);
  }
  const ul = el.querySelector('[data-drafts]');
  for (const s of sites) {
    const m = measure(s.ring);
    const li = document.createElement('li');
    li.className = 'site-row';
    li.innerHTML = `
      <button type="button" class="site-open">
        <span class="site-name">${s.form?.housingType ? typeName(s.form.housingType) : 'Outline'} · ${m ? fmt.land(m.areaM2) : ''}</span>
        <span class="site-meta">${statusText[s.status] ?? 'Draft'} · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${s.mode === 'build' ? ' · Listing' : ''}</span>
      </button>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="Delete this site">${icon('trash')}</button>`;
    li.querySelector('.site-open').addEventListener('click', () => onOpen(s));
    li.querySelector('.btn-icon').addEventListener('click', () => { onDelete(s); li.remove(); });
    ul.append(li);
  }
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
