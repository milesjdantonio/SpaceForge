// Share: the place to get a building's link, for a builder, a landowner or anyone else, and every
// link made before. A link carries the building itself (lib/share.js), so it works without an
// account; very long links also come as a file.

import { icon } from '../ui/icons.js';
import { LONG_LINK } from '../lib/share.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// `current` is the building being shared now ({ name, url, sample }), or null; `links` the history.
export function renderShare(el, { current, links, onCopy, onOpen, onDownload, onRemove, onPickBuilding }) {
  el.innerHTML = `
    <header class="panel-head">
      <div><h2 class="panel-title">Share</h2><p class="panel-sub">Send a building to a builder, a landowner or anyone</p></div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    ${current ? `
      <section class="share-now" aria-labelledby="share-now-title">
        <h3 class="group-title" id="share-now-title">${esc(current.name)}</h3>
        <p class="note">${current.sample ? 'The sample house shares its land and brief.' : 'Anyone with this link sees the building on its land, with its plans and costs. They don’t need an account.'}</p>
        <div class="share-link">
          <label class="sr-only" for="share-url">Link</label>
          <input class="input" id="share-url" readonly value="${esc(current.url)}">
          <button type="button" class="btn btn-primary" data-copy-current>${icon('copy')}<span>Copy</span></button>
        </div>
        ${current.url.length > LONG_LINK ? `<p class="note share-long">This building is large, so its link is long (${Math.round(current.url.length / 1000)} KB). Some apps cut long links; the file always works.</p>` : ''}
        <div class="fail-actions">
          ${current.sample ? '' : `<button type="button" class="btn" data-download-current>${icon('house')}<span>Download as a File</span></button>`}
          <button type="button" class="btn btn-quiet" data-open-current>Open the Link</button>
        </div>
      </section>` : `
      <section class="share-now">
        <p class="empty">Choose a building on the map, or open one from My Builds, then choose Share to make its link.</p>
        <button type="button" class="btn" data-pick>Open My Builds</button>
      </section>`}
    <section aria-labelledby="share-links-title">
      <h3 class="group-title" id="share-links-title">Your Share Links</h3>
      ${links.length ? '<ul class="sites" data-links></ul>' : '<p class="empty">Links you make appear here, so you can copy them again.</p>'}
    </section>`;

  const current$ = el.querySelector('#share-url');
  current$?.addEventListener('focus', () => current$.select());
  el.querySelector('[data-copy-current]')?.addEventListener('click', () => onCopy(current.url));
  el.querySelector('[data-download-current]')?.addEventListener('click', () => onDownload(current));
  el.querySelector('[data-open-current]')?.addEventListener('click', () => onOpen(current.url));
  el.querySelector('[data-pick]')?.addEventListener('click', onPickBuilding);

  const ul = el.querySelector('[data-links]');
  for (const link of links) {
    const li = document.createElement('li');
    li.className = 'site-row';
    li.innerHTML = `<div class="site-open share-row"><span class="site-name"></span><span class="site-meta"></span></div>
      <button type="button" class="btn btn-quiet btn-icon" data-copy aria-label="Copy link">${icon('copy')}</button>
      <button type="button" class="btn btn-quiet btn-icon" data-remove aria-label="Remove from this list">${icon('trash')}</button>`;
    li.querySelector('.site-name').textContent = link.name;
    li.querySelector('.site-meta').textContent = `Made ${when(link.createdAt)}${link.sample ? ' · land only' : ''}`;
    li.querySelector('[data-copy]').onclick = () => onCopy(link.url);
    li.querySelector('.share-row').onclick = () => onOpen(link.url);
    li.querySelector('[data-remove]').onclick = () => { onRemove(link); li.remove(); };
    ul.append(li);
  }
}
