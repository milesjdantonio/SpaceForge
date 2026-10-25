// My Builds: the visitor's saved buildings and site drafts.

import { fmt } from '../format.js';
import { measure } from '../lib/place.js';
import { icon } from '../ui/icons.js';
import { typeName } from '../lib/housing.js';

export function renderSites(el, { sites, onOpen, onDelete, onOpenFile, account, buildings = [], projects = [], projectID = '', onProjectChange, onCreateProject, onMoveBuilding, loading = false, error = '', nextOffset = null, onSignIn, onOpenBuilding, onDeleteBuilding, onMore, onRetry }) {
  const statusText = { draft: 'Draft', 'not-sent': 'Not sent yet', sent: 'Sent' };
  el.innerHTML = `
    <header class="panel-head">
      <div><h2 class="panel-title">My Builds</h2><p class="panel-sub">Your buildings and site drafts</p></div>
      <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
    </header>
    <section class="saved-buildings" aria-labelledby="saved-buildings-title">
      <h3 class="group-title" id="saved-buildings-title">Saved buildings</h3>
      <p class="note">${account ? 'Private to your account.' : 'Sign in to save buildings and open them on your next visit.'}</p>
      ${account ? '<label>Project <select class="select" data-project-filter><option value="">All projects</option></select></label><button type="button" class="btn btn-small" data-new-project>New project</button>' : ''}
      ${!account ? '<button type="button" class="btn btn-primary" data-library-signin>Sign in</button>' : ''}
      <p class="account-error" data-library-error role="alert" hidden></p>
      ${error && onRetry ? `<div class="fail-actions"><button type="button" class="btn btn-small" data-library-retry>${icon('retry')}<span>Try again</span></button></div><p class="note">Site drafts below are kept in this browser and still work.</p>` : ''}
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
  el.querySelector('[data-library-retry]')?.addEventListener('click', onRetry);
  const filter = el.querySelector('[data-project-filter]');
  for (const project of projects) {
    const option = document.createElement('option'); option.value = project.id; option.textContent = project.name;
    filter?.append(option);
  }
  if (filter) { filter.value = projectID; filter.onchange = () => onProjectChange?.(filter.value); }
  el.querySelector('[data-new-project]')?.addEventListener('click', onCreateProject);
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
    if (projects.length && onMoveBuilding) {
      const select = document.createElement('select'); select.className = 'select project-assignment';
      select.setAttribute('aria-label', `Project for ${building.name}`);
      for (const project of projects) {
        const option = document.createElement('option'); option.value = project.id; option.textContent = project.name;
        select.append(option);
      }
      select.value = building.project_id;
      select.onchange = async () => {
        select.disabled = true;
        try { await onMoveBuilding(building, select.value); }
        catch (err) {
          select.value = building.project_id;
          const note = el.querySelector('[data-library-error]'); note.textContent = err.message; note.hidden = false;
        } finally { select.disabled = false; }
      };
      li.insertBefore(select, remove);
    }
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
