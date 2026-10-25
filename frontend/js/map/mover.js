// Moving and turning a building on its land. A selected building offers a Move button beside it.
// Move puts a ring on the ground round the building, with a grip at its front for turning (to any
// angle), and a grip above the roof for dragging it; the building itself can be dragged too. It may
// leave its land while moving: the outline turns red, and Done waits until it's back inside.
//
// Keys while moving: arrows move it (Shift for bigger steps), [ and ] turn it a degree (Shift for
// 15°), Enter is Done, Escape puts it back.

import { mountRive } from '../rive.js';
import { icon } from '../ui/icons.js';
import { transformPlacement, placementCenter } from '../lib/place.js';
import { footprintOutside } from '../lib/design.js';
import { projection, bearing } from '../lib/geo.js';

const SRC = 'mover';
const RING_GAP_M = 3; // the ring sits this far beyond the building's corners
const empty = () => ({ type: 'FeatureCollection', features: [] });
const norm = (deg) => ((deg % 360) + 360) % 360;
const frontOf = (placement) => norm(placement.xAxisBearingDeg + 90);

export function createMover(map, { house, outliner, landOf, canOffer, onDone, onDragEnd, onStart }) {
  const root = map.getContainer();
  const canvas = map.getCanvas();
  map.addSource(SRC, { type: 'geojson', data: empty() });
  const under = map.getLayer('house-3d') ? 'house-3d' : undefined;
  map.addLayer({ id: 'mover-ring-shade', type: 'line', source: SRC, paint: { 'line-color': '#000000', 'line-opacity': 0.4, 'line-width': 8, 'line-blur': 3 } }, under);
  map.addLayer({ id: 'mover-ring', type: 'line', source: SRC, paint: { 'line-color': '#ffb15c', 'line-width': 3, 'line-dasharray': [2, 1.4] } }, under);

  // Grips and the Move button ride on the map (under the side panel); the bar sits over the page.
  const make = (tag, cls, html = '', parent = root) => {
    const node = document.createElement(tag);
    node.className = cls;
    node.innerHTML = html;
    node.hidden = true;
    parent.append(node);
    return node;
  };
  const offer = make('button', 'mover-offer', `${icon('move')}<span>Move</span>`);
  offer.type = 'button';
  offer.title = 'Move or turn this building';
  const grip = make('div', 'mover-grip mover-grip-move', `<span class="mover-fallback">${icon('move')}</span>`);
  const knob = make('div', 'mover-grip mover-grip-turn', `<span class="mover-fallback">${icon('turn')}</span>`);
  for (const [node, label] of [[grip, 'Drag to move the building'], [knob, 'Drag round the ring to turn the building']]) {
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', label);
    node.tabIndex = -1;
  }
  const rive = {
    move: mountRive(grip, { src: 'assets/rive/handle.riv', artboard: 'Move', stateMachine: 'Handle', hoverInput: 'hover', hoverTarget: grip }),
    turn: mountRive(knob, { src: 'assets/rive/handle.riv', artboard: 'Rotate', stateMachine: 'Handle', hoverInput: 'hover', hoverTarget: knob }),
  };
  const bar = make('div', 'mover-bar', `
    <p class="mover-status" data-status aria-live="polite"></p>
    <div class="mover-controls">
      <label class="mover-angle"><span>Front Faces</span><input class="input num" data-angle type="number" min="0" max="359" step="1" inputmode="numeric" aria-label="Front faces, degrees from north"><span aria-hidden="true">°</span></label>
      <button type="button" class="btn btn-small btn-quiet" data-m="cancel">Cancel</button>
      <button type="button" class="btn btn-small btn-primary" data-m="done">Done</button>
    </div>`, document.body);
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Moving the building');
  const status = bar.querySelector('[data-status]');
  const angle = bar.querySelector('[data-angle]');
  const done = bar.querySelector('[data-m="done"]');

  let active = null; // { design, from, placement, land, outside }
  let drag = null;   // { kind: 'move' | 'turn', base, offset?, center?, start? }

  // ---- drawing ---------------------------------------------------------------------------------
  function ringRadius() {
    const s = house.size;
    return s ? Math.hypot(s.W, s.D) / 2 + RING_GAP_M : 10;
  }
  function knobAt(placement) {
    const c = placementCenter(placement);
    const proj = projection(c);
    const f = (frontOf(placement) * Math.PI) / 180, r = ringRadius();
    return proj.toGeo([Math.sin(f) * r, Math.cos(f) * r]);
  }
  function drawRing() {
    if (!active) { map.getSource(SRC)?.setData(empty()); return; }
    const c = placementCenter(active.placement);
    const proj = projection(c);
    const r = ringRadius();
    const ring = [];
    for (let i = 0; i <= 72; i++) ring.push(proj.toGeo([Math.sin((i / 72) * Math.PI * 2) * r, Math.cos((i / 72) * Math.PI * 2) * r]));
    map.getSource(SRC)?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } }] });
  }
  const place = (node, pt) => {
    node.hidden = !pt || pt.x < -40 || pt.y < -40 || pt.x > canvas.clientWidth + 40 || pt.y > canvas.clientHeight + 40;
    if (!node.hidden) node.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
  };
  // Keeps the button and grips on the building as the map moves; runs after every map render.
  function position() {
    const s = house.size;
    const close = map.getZoom() >= 15;
    if (active && house.design !== active.design) { stop(); return; } // another building was opened
    if (active && !canOffer()) { finish(false); return; }             // the app moved on (brief, globe…)
    const roof = s && close ? house.screenPoint([s.W / 2, s.D / 2, s.height]) : null;
    if (!active) {
      const show = !!roof && house.selected && canOffer();
      if (!show) { offer.hidden = true; return; }
      place(offer, roof);
      return;
    }
    offer.hidden = true;
    place(grip, roof);
    place(knob, close ? map.project(knobAt(active.placement)) : null);
  }

  // ---- changing the placement --------------------------------------------------------------------
  function apply(next) {
    active.placement = next;
    house.move(next);
    active.outside = footprintOutside(next.footprint, active.land) > 0;
    outliner.setWarning(active.outside);
    done.disabled = active.outside;
    status.textContent = active.outside
      ? 'Outside your land. Move it back inside to keep this spot.'
      : 'Drag the top grip or the building to move it, the ring grip to turn it.';
    status.classList.toggle('is-warning', active.outside);
    if (document.activeElement !== angle) angle.value = Math.round(frontOf(next)) % 360;
    drawRing();
    position();
  }

  function start() {
    const placement = house.placement, design = house.design;
    const land = design && landOf(design);
    if (!placement || !land || active) return;
    active = { design, from: placement, placement, land, outside: false };
    onStart?.();
    bar.hidden = false;
    document.body.classList.add('is-moving');
    grip.tabIndex = 0; knob.tabIndex = 0;
    addEventListener('keydown', onKey);
    apply(placement);
    grip.focus({ preventScroll: true });
  }

  // Ends moving: keep the new spot (when it's inside the land) or put the building back.
  function finish(keep) {
    if (!active) return;
    if (keep && active.outside) return;
    const { from, placement } = active;
    if (!keep) house.move(from);
    stop();
    if (keep && placement !== from) onDone(placement, from);
  }
  function stop() {
    endDrag();
    active = null;
    removeEventListener('keydown', onKey);
    outliner.setWarning(false);
    document.body.classList.remove('is-moving');
    bar.hidden = true; grip.hidden = true; knob.hidden = true;
    grip.tabIndex = -1; knob.tabIndex = -1;
    drawRing();
    position();
  }

  // ---- dragging --------------------------------------------------------------------------------
  const pointAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const compassAt = (pt, center) => {
    const ll = map.unproject([pt.x, pt.y]);
    const proj = projection(center);
    return bearing([0, 0], proj.toLocal([ll.lng, ll.lat]));
  };
  function beginMove(pt) {
    const c = map.project(placementCenter(active.placement));
    drag = { kind: 'move', base: active.placement, offset: { x: pt.x - c.x, y: pt.y - c.y } };
    rive.move?.set('active', true);
    grip.classList.add('is-active');
    begin();
  }
  function beginTurn(pt) {
    const center = placementCenter(active.placement);
    drag = { kind: 'turn', base: active.placement, center, start: compassAt(pt, center) };
    rive.turn?.set('active', true);
    knob.classList.add('is-active');
    begin();
  }
  function begin() {
    drag.panEnabled = map.dragPan.isEnabled();
    map.dragPan.disable();
    root.classList.add('is-moving-building');
    addEventListener('pointermove', onDrag);
    addEventListener('pointerup', endDrag);
    addEventListener('pointercancel', endDrag);
    addEventListener('blur', endDrag);
  }
  function onDrag(e) {
    if (!drag || !active) return;
    e.preventDefault();
    const pt = pointAt(e);
    if (drag.kind === 'move') {
      const ll = map.unproject([pt.x - drag.offset.x, pt.y - drag.offset.y]);
      apply(transformPlacement(drag.base, { center: [ll.lng, ll.lat] }));
    } else {
      let front = frontOf(drag.base) + (compassAt(pt, drag.center) - drag.start);
      if (e.shiftKey) front = Math.round(front / 15) * 15;
      apply(transformPlacement(drag.base, { turnDeg: front - frontOf(drag.base) }));
    }
  }
  function endDrag() {
    if (!drag) return;
    if (drag.panEnabled) map.dragPan.enable();
    drag = null;
    rive.move?.set('active', false); rive.turn?.set('active', false);
    grip.classList.remove('is-active'); knob.classList.remove('is-active');
    root.classList.remove('is-moving-building');
    removeEventListener('pointermove', onDrag);
    removeEventListener('pointerup', endDrag);
    removeEventListener('pointercancel', endDrag);
    removeEventListener('blur', endDrag);
    onDragEnd?.();
  }
  const press = (fn) => (e) => {
    if (!active || e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    fn(pointAt(e));
  };
  grip.addEventListener('pointerdown', press(beginMove));
  knob.addEventListener('pointerdown', press(beginTurn));
  // Pressing on the building itself drags it too.
  const onMapDown = (e) => {
    if (!active || drag) return;
    const ev = e.originalEvent;
    if (ev && 'button' in ev && ev.button !== 0) return;
    if (e.points && e.points.length !== 1) return;
    const hit = house.pick(e.point) ?? house.at([e.lngLat.lng, e.lngLat.lat]);
    if (!hit || hit.design !== active.design) return;
    e.preventDefault();
    beginMove(e.point);
  };
  map.on('mousedown', onMapDown);
  map.on('touchstart', onMapDown);

  // ---- keys and the bar --------------------------------------------------------------------------
  function nudge(screenDeg, metres) {
    const c = placementCenter(active.placement);
    const proj = projection(c);
    const b = ((map.getBearing() + screenDeg) * Math.PI) / 180;
    apply(transformPlacement(active.placement, { center: proj.toGeo([Math.sin(b) * metres, Math.cos(b) * metres]) }));
  }
  function onKey(e) {
    if (!active) return;
    const typing = e.target === angle;
    if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (typing) setAngle(); finish(true); return; }
    if (typing || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const step = e.shiftKey ? 2 : 0.5;
    const dir = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 }[e.key];
    if (dir != null) { e.preventDefault(); nudge(dir, step); return; }
    const turn = { '[': -1, ']': 1, '{': -15, '}': 15 }[e.key];
    if (turn) { e.preventDefault(); apply(transformPlacement(active.placement, { turnDeg: turn })); }
  }
  function setAngle() {
    const v = Number(angle.value);
    if (!active || angle.value === '' || !Number.isFinite(v)) return;
    apply(transformPlacement(active.placement, { turnDeg: norm(v) - frontOf(active.placement) }));
  }
  angle.addEventListener('change', setAngle);
  angle.addEventListener('blur', () => { if (active) angle.value = Math.round(frontOf(active.placement)) % 360; });
  bar.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (m === 'done') finish(true);
    if (m === 'cancel') finish(false);
  });
  offer.addEventListener('click', (e) => { e.stopPropagation(); start(); });
  // Keep the map from treating presses on the overlay as map gestures.
  for (const node of [offer, bar]) node.addEventListener('pointerdown', (e) => e.stopPropagation());

  map.on('render', position);

  return {
    start,
    cancel: () => finish(false),
    refresh: position,
    get active() { return !!active; },
    get dragging() { return !!drag; },
  };
}
