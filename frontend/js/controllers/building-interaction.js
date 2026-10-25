import { createMover } from '../map/mover.js';
import { explainSaveError } from '../lib/errors.js';
import { icon } from '../ui/icons.js';

export function mountBuildingInteraction({ map, app, house, outliner, panel, mainElement, store, auth, wide, panelPadding, arrive, openHouse, closePanel, setMode, rememberScene, openSceneBuilding, persistBuilding, isPending, toast }) {
  map.on('click', (e) => {
    if (e.originalEvent?.target?.closest?.('.you')) return;
    if (app.mode === 'globe') {
      // Fly to where the click landed, as long as it landed on the globe and not in space beside it.
      const back = map.project(e.lngLat);
      if (Math.hypot(back.x - e.point.x, back.y - e.point.y) > 4) return;
      arrive([e.lngLat.lng, e.lngLat.lat], { zoom: 16.2 });
      return;
    }
    if (app.justMoved && Date.now() - app.justMoved < 400) return;
    if (mover.active) return; // While moving, clicks on the map neither select nor deselect.
    if (app.mode === 'house' || app.mode === 'explore' || app.mode === 'failed') {
      const hit = house.pick(e.point) ?? house.at([e.lngLat.lng, e.lngLat.lat]);
      // A click on a building always opens its details (cost, materials, plans); Move sits beside it.
      if (hit) selectBuilding(hit, { details: true });
      else {
        house.deselect();
        if (panel.dataset.view === 'house') closePanel();
        setMode('explore'); rememberScene();
      }
    }
  });
  map.on('mousemove', (e) => {
    if (outliner.active || mover.dragging) return;
    const hit = ['house', 'explore', 'failed'].includes(app.mode) && map.getZoom() >= 15 &&
      (house.pick(e.point) ?? house.at([e.lngLat.lng, e.lngLat.lat]));
    map.getCanvas().style.cursor = hit ? (mover.active && house.isSelected(hit) ? 'grab' : 'pointer') : app.mode === 'globe' ? 'crosshair' : '';
    // Say what a click will open before it's clicked.
    const show = !!hit && !mover.active && !e.originalEvent?.ctrlKey;
    hoverTip.hidden = !show;
    if (show) {
      hoverTip.textContent = panel.dataset.view === 'house' && house.isSelected(hit) ? 'Showing its details' : 'Click for details: cost, plans, materials';
      hoverTip.style.transform = `translate(${e.point.x + 16}px, ${e.point.y + 18}px)`;
    }
  });
  const hoverTip = document.createElement('div');
  hoverTip.className = 'hover-tip';
  hoverTip.hidden = true;
  map.getContainer().append(hoverTip);
  map.getCanvas().addEventListener('mouseleave', () => { hoverTip.hidden = true; });
  map.on('movestart', () => { hoverTip.hidden = true; });

  // Teaching Ctrl + drag (the only way to turn and tilt with a mouse): a tip at street level until it's
  // dismissed or used, and a cue beside the pointer while Ctrl is held over the map.
  const finePointer = matchMedia('(pointer: fine)').matches;
  const tiltTip = document.createElement('div');
  tiltTip.className = 'tilt-tip';
  tiltTip.hidden = true;
  tiltTip.innerHTML = `<span class="tilt-keys"><kbd>Ctrl</kbd><span aria-hidden="true">+</span>${icon('move')}</span><span>Hold <strong>Ctrl</strong> and drag to turn and tilt the view</span><button type="button" class="tilt-tip-close" aria-label="Got it, hide this tip">${icon('close')}</button>`;
  mainElement.append(tiltTip);
  let tiltLearned = store.get('tiltLearned', false);
  const learnTilt = () => { if (tiltLearned) return; tiltLearned = true; store.set('tiltLearned', true); syncTiltTip(); };
  function syncTiltTip() {
    tiltTip.hidden = !finePointer || tiltLearned || ['globe', 'flying', 'drawing', 'sending'].includes(app.mode) || map.getZoom() < 14 || mover.active;
  }
  tiltTip.querySelector('button').addEventListener('click', learnTilt);
  map.on('moveend', syncTiltTip);
  for (const ev of ['rotatestart', 'pitchstart']) map.on(ev, (e) => { if (e.originalEvent) learnTilt(); });

  const ctrlCue = document.createElement('div');
  ctrlCue.className = 'hover-tip ctrl-cue';
  ctrlCue.hidden = true;
  ctrlCue.textContent = 'Drag to turn and tilt';
  map.getContainer().append(ctrlCue);
  let pointer = null;
  map.getCanvas().addEventListener('mousemove', (e) => {
    const r = map.getCanvas().getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (!ctrlCue.hidden) ctrlCue.style.transform = `translate(${pointer.x + 16}px, ${pointer.y + 18}px)`;
    if (e.ctrlKey !== !ctrlCue.hidden) setCtrlCue(e.ctrlKey);
  });
  map.getCanvas().addEventListener('mouseleave', () => { pointer = null; setCtrlCue(false); });
  function setCtrlCue(on) {
    const show = on && !!pointer && finePointer && app.mode !== 'globe' && !outliner.active && !mover.active;
    ctrlCue.hidden = !show;
    map.getCanvas().classList.toggle('is-ctrl', show);
    if (show) { hoverTip.hidden = true; ctrlCue.style.transform = `translate(${pointer.x + 16}px, ${pointer.y + 18}px)`; }
  }
  addEventListener('keydown', (e) => { if (e.key === 'Control' && !e.repeat) setCtrlCue(true); });
  addEventListener('keyup', (e) => { if (e.key === 'Control') setCtrlCue(false); });
  addEventListener('blur', () => setCtrlCue(false));
  map.on('dblclick', (e) => {
    if (house.pick(e.point) ?? house.at([e.lngLat.lng, e.lngLat.lat])) e.preventDefault();
  });

  // ---- selecting and moving a building -----------------------------------------------------------
  // A click selects a house in orange and opens its details. The Move button beside a selected house
  // (map/mover.js) turns on the move and turn grips.
  function selectBuilding(hit, { details = false } = {}) {
    if (hit.id && (!house.design || hit.id !== app.savedBuilding?.id)) openSceneBuilding(hit.id, { focus: false, details });
    else {
      house.select();
      if (details) openHouse();
      else if (panel.dataset.view === 'house') closePanel();
      rememberScene();
    }
    // On phones the details sheet covers the lower half: keep the building (and Move) above it.
    if (details && !wide()) {
      const fp = (hit.placement ?? house.placement)?.footprint;
      if (fp) map.easeTo({ center: [fp.reduce((s, p) => s + p[0], 0) / fp.length, fp.reduce((s, p) => s + p[1], 0) / fp.length], padding: panelPadding(), duration: 600 });
    }
  }
  const landOf = (design) => (design.previewOn ? app.site?.ring : design.site?.outline) ?? null;
  const mover = createMover(map, {
    house, outliner, landOf,
    canOffer: () => ['house', 'explore', 'failed'].includes(app.mode) && !outliner.active,
    onDone: (placement) => savePlacement(placement),
    // On phones the details panel covers the map, so moving puts it away.
    onStart: () => { if (!wide() && panel.dataset.view === 'house') closePanel(); },
    onDragEnd: () => { app.justMoved = Date.now(); }, // Ignore the click that follows a drag.
  });

  // Keeps a building's new spot: saved buildings save it to the account; others keep it until saved.
  function savePlacement(last) {
    const design = house.design;
    const uid = auth.user?.uid;
    const version = app.displayVersion;
    const known = app.savedBuilding;
    const saved = known?.uid === uid && known?.designID === design.id;
    const pending = isPending(design.id, version);
    if (!uid || (!saved && !pending)) {
      toast('Position updated. Choose Save building to keep it in your account.');
      return;
    }
    // Keep Gemma's original geometry intact; persist the actual map placement beside it.
    persistBuilding(design, app.estimates.get(design.id) ?? null, app.site, last).then(() => {
      if (auth.user?.uid === uid && app.displayVersion === version && house.placement === last) toast('Position saved.');
    }).catch((err) => {
      if (auth.user?.uid === uid && app.displayVersion === version && house.placement === last) {
        const why = explainSaveError(err);
        toast(`The new position wasn’t saved. ${why.text}`, { kind: 'error', action: why.action && { label: why.action, run: () => savePlacement(last) } });
      }
    });
  }


  return { mover, landOf };
}
