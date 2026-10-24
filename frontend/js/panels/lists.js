// Catalog of published listings, and the visitor's own saved sites.

import { fmt } from '../format.js';
import { measure } from '../lib/place.js';
import { icon } from '../ui/icons.js';
import { renderPlan } from '../render/plan.js';

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
        <span class="card-title">${l.design.title}</span>
        <span class="card-meta num">${l.design.bedrooms} bed · ${l.design.bathrooms} bath · ${fmt.area(l.design.finishedAreaM2)}</span>
        <span class="card-price num">${fmt.money(l.estimate.buildCost.low, { short: true })}–${fmt.money(l.estimate.buildCost.high, { short: true })} to build</span>
        <span class="card-by">${l.builder.company}</span>
      </span></button>`;
    li.querySelector('.card-plan').append(renderPlan(l.design, { labels: false, dims: false, className: 'plan plan-thumb', pad: 0.6 }));
    li.querySelector('button').addEventListener('click', () => onOpen(l));
    ul.append(li);
  }
}

export function renderSites(el, { sites, onOpen, onDelete }) {
  const statusText = { draft: 'Draft', 'not-sent': 'Not sent yet', sent: 'Sent' };
  el.innerHTML = `
    <header class="panel-head">
      <div><h2 class="panel-title">My sites</h2><p class="panel-sub">Saved in this browser</p></div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    ${sites.length ? '<ul class="sites"></ul>' : '<p class="empty">No sites yet. Outline some land on the map and it will be saved here.</p>'}`;
  const ul = el.querySelector('.sites');
  for (const s of sites) {
    const m = measure(s.ring);
    const li = document.createElement('li');
    li.className = 'site-row';
    li.innerHTML = `
      <button type="button" class="site-open">
        <span class="site-name">${s.brief?.style ? cap(s.brief.style) : 'Outline'} · ${m ? fmt.land(m.areaM2) : ''}</span>
        <span class="site-meta">${statusText[s.status] ?? 'Draft'} · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${s.mode === 'build' ? ' · Listing' : ''}</span>
      </button>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="Delete this site">${icon('trash')}</button>`;
    li.querySelector('.site-open').addEventListener('click', () => onOpen(s));
    li.querySelector('.btn-icon').addEventListener('click', () => { onDelete(s); li.remove(); });
    ul.append(li);
  }
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
