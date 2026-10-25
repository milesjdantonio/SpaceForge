// A floor plan full screen, for a close look: scroll or pinch-free buttons to zoom, drag to pan,
// double-click to zoom in on a spot, floors switchable. Escape or Close puts it away.

import { icon } from './icons.js';
import { renderPlan } from '../render/plan.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MIN = 0.25, MAX = 12; // below 100% the whole plan sits smaller in the middle

export function openPlanViewer({ design, level = 0, title, onLevel }) {
  const back = document.activeElement;
  const el = document.createElement('div');
  el.className = 'plan-viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `Floor plan of ${title}`);
  el.innerHTML = `
    <header class="pv-bar">
      <div class="pv-title"><strong>${esc(title)}</strong><span data-level-name></span></div>
      <div class="seg pv-levels" role="group" aria-label="Floor">
        ${design.levels.map((l, i) => `<button type="button" data-level="${i}">${esc(l.name)}</button>`).join('')}
      </div>
      <div class="pv-zoom" role="group" aria-label="Zoom">
        <button type="button" class="btn btn-quiet btn-icon" data-z="out" aria-label="Zoom out">${icon('minus')}</button>
        <span class="pv-pct num" data-pct>100%</span>
        <button type="button" class="btn btn-quiet btn-icon" data-z="in" aria-label="Zoom in">${icon('plus')}</button>
        <button type="button" class="btn btn-quiet btn-small" data-z="fit">Fit</button>
      </div>
      <button type="button" class="btn" data-close>${icon('close')}<span>Close</span></button>
    </header>
    <div class="pv-stage" data-stage tabindex="0" aria-label="Plan. Drag to move around, scroll to zoom."></div>
    <p class="pv-hint">Scroll to zoom · drag to move · double-click to zoom in</p>`;
  document.body.append(el);
  const stage = el.querySelector('[data-stage]');
  let svg, base, zoom = 1, cx = 0, cy = 0;

  function draw(i) {
    level = i;
    svg = renderPlan(design, { level, className: 'plan plan-full' });
    stage.replaceChildren(svg);
    base = svg.getAttribute('viewBox').split(' ').map(Number);
    zoom = 1; cx = base[0] + base[2] / 2; cy = base[1] + base[3] / 2;
    apply();
    el.querySelectorAll('[data-level]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.level) === level)));
    el.querySelector('[data-level-name]').textContent = design.levels[level].name;
    onLevel?.(level);
  }
  function apply() {
    const w = base[2] / zoom, h = base[3] / zoom;
    // Keep the view over the plan; zoomed out past 100%, the plan stays in the middle.
    cx = Math.max(base[0] + w / 2 - base[2] * 0.4, Math.min(base[0] + base[2] - w / 2 + base[2] * 0.4, cx));
    cy = Math.max(base[1] + h / 2 - base[3] * 0.4, Math.min(base[1] + base[3] - h / 2 + base[3] * 0.4, cy));
    if (zoom <= 1) { cx = base[0] + base[2] / 2; cy = base[1] + base[3] / 2; }
    svg.setAttribute('viewBox', `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
    el.querySelector('[data-pct]').textContent = `${Math.round(zoom * 100)}%`;
  }
  // Plan units under a screen point.
  const at = (x, y) => {
    const r = svg.getBoundingClientRect();
    const w = base[2] / zoom, h = base[3] / zoom;
    // preserveAspectRatio meet: the drawn box is centred in the element.
    const s = Math.min(r.width / w, r.height / h);
    return [cx + (x - (r.left + r.width / 2)) / s, cy + (y - (r.top + r.height / 2)) / s];
  };
  function zoomAt(f, x, y) {
    const before = x == null ? [cx, cy] : at(x, y);
    zoom = Math.max(MIN, Math.min(MAX, zoom * f));
    apply();
    if (x != null) {
      const after = at(x, y);
      cx += before[0] - after[0]; cy += before[1] - after[1];
      apply();
    }
  }

  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('dblclick', (e) => zoomAt(2, e.clientX, e.clientY));
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx, cy };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const s = Math.min(r.width / (base[2] / zoom), r.height / (base[3] / zoom));
    cx = drag.cx - (e.clientX - drag.x) / s; cy = drag.cy - (e.clientY - drag.y) / s;
    apply();
  });
  const endDrag = () => { drag = null; stage.classList.remove('is-dragging'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  el.addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') zoomAt(1.4);
    if (z === 'out') zoomAt(1 / 1.4);
    if (z === 'fit') { zoom = 1; cx = base[0] + base[2] / 2; cy = base[1] + base[3] / 2; apply(); }
    const l = e.target.closest('[data-level]');
    if (l) draw(Number(l.dataset.level));
    if (e.target.closest('[data-close]')) close();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === '+' || e.key === '=') zoomAt(1.4);
    if (e.key === '-') zoomAt(1 / 1.4);
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (pan && document.activeElement === stage) { e.preventDefault(); cx += pan[0] * base[2] / zoom / 10; cy += pan[1] * base[3] / zoom / 10; apply(); }
  };
  addEventListener('keydown', onKey, true);
  function close() {
    removeEventListener('keydown', onKey, true);
    el.remove();
    back?.focus?.();
  }

  draw(level);
  el.querySelector('[data-close]').focus();
  return { close };
}
