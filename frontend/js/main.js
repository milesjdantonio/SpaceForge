// TerraSim: the globe, the fly-down, outlining land, the brief, sending, and the house on its lot.

import { settings, store } from './store.js';
import { createMap, setBasemap, locationMarker, flyToGround, getLocation, setGlobe } from './map/map.js';
import { createOutliner } from './map/draw.js';
import { createHouseLayer } from './map/house-layer.js';
import { measure, problemsFor, placeOnLot, inFootprint } from './lib/place.js';
import { fmt } from './format.js';
import { api } from './api/client.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { renderBriefPanel } from './panels/brief.js';
import { renderSending } from './panels/send.js';
import { renderHousePanel } from './panels/house.js';
import { renderCatalog, renderSites } from './panels/lists.js';
import { mountRive } from './rive.js';

const $ = (sel) => document.querySelector(sel);
const body = document.body;
const panel = $('#panel');
const toolbar = $('#toolbar');
const hint = $('#draw-hint');
const intro = $('#intro');
const introHint = $('#intro-hint');

const app = {
  mode: 'globe',
  basemap: 'satellite',
  tilted: true,
  night: false,
  site: null,      // { id, ring, brief, mode, builder, status }
  you: null,       // visitor location [lng, lat]
};

function setMode(mode) {
  app.mode = mode;
  body.dataset.mode = mode;
  renderToolbar();
}

// ---- boot --------------------------------------------------------------------------------------
const { map, stopSpin } = await createMap($('#map'));
const outliner = createOutliner(map, {
  onChange: (s) => updateHint(s),
  onFinish: (ring, { edited }) => onOutlineDone(ring, edited),
  onCancel: () => { hint.hidden = true; setMode('explore'); },
});
const house = createHouseLayer(map);
map.addLayer(house.layer);
window.__terrasim = { map, app, house, stopSpin };

const marker = { current: null };
if (location.hash.startsWith('#s=')) await openShared(location.hash);
else if (location.hash.startsWith('#l=')) {
  setTimeout(() => document.querySelector('[data-open="catalog"]').click(), 300);
}
getLocation().then((you) => {
  app.you = you;
  if (you) {
    marker.current = locationMarker(map, you);
    introHint.textContent = `${matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click'} anywhere to fly to where you are.`;
  } else {
    introHint.textContent = 'Your location wasn’t shared. Spin the globe and click the place you want to see.';
  }
});

map.on('click', (e) => {
  if (app.mode === 'globe') {
    const target = app.you ?? [e.lngLat.lng, e.lngLat.lat];
    arrive(target);
    return;
  }
  if (app.mode === 'house' || app.mode === 'explore' || app.mode === 'failed') {
    const p = house.placement;
    if (p && inFootprint([e.lngLat.lng, e.lngLat.lat], p.footprint)) openHouse();
  }
});
map.on('mousemove', (e) => {
  if (outliner.active) return;
  const p = house.placement;
  const over = p && map.getZoom() > 14 && inFootprint([e.lngLat.lng, e.lngLat.lat], p.footprint);
  map.getCanvas().style.cursor = over ? 'pointer' : app.mode === 'globe' ? 'pointer' : '';
});

async function arrive(lngLat) {
  stopSpin();
  setMode('flying');
  intro.classList.add('is-leaving');
  await flyToGround(map, lngLat);
  intro.hidden = true;
  setMode('explore');
  toast(app.you ? 'You’re here. Pan around, then outline the land you want to build on.' : 'Pan around, then outline the land you want to build on.');
}

// ---- share links ------------------------------------------------------------------------------
// A shared link carries the outline and brief (never builder details) in the URL hash, so a dreamer's
// design can be shown to someone else without being stored anywhere.
function encodeShare(data) {
  const json = JSON.stringify(data);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeShare(str) {
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return null; }
}
function shareLink({ preview = false } = {}) {
  if (!app.site) return location.href.split('#')[0];
  const data = { v: 1, r: app.site.ring.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]), b: app.site.brief, p: preview ? 1 : 0 };
  return `${location.href.split('#')[0]}#s=${encodeShare(data)}`;
}
async function openShared(hash) {
  const data = decodeShare(hash.slice(3));
  if (!data?.r || data.r.length < 3) { toast('That link doesn’t contain a site.'); return false; }
  stopSpin();
  intro.hidden = true;
  setGlobe(map, false);
  app.site = { id: `site-${Date.now().toString(36)}`, ring: data.r, brief: data.b ?? null, mode: 'dream', builder: null, status: 'shared', createdAt: new Date().toISOString() };
  const c = measure(data.r).centroid;
  map.jumpTo({ center: c, zoom: 18, pitch: 55, bearing: -20, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  outliner.load(data.r);
  setMode('explore');
  if (data.p) await previewSample();
  else openBrief();
  return true;
}

// ---- toolbar -----------------------------------------------------------------------------------
function renderToolbar() {
  const show = ['explore', 'house', 'failed', 'brief', 'sending'].includes(app.mode);
  toolbar.hidden = !show;
  if (!show) return;
  const drawing = outliner.active;
  toolbar.innerHTML = `
    <button type="button" class="btn btn-primary" data-act="outline">${icon('outline')}<span>${app.site ? 'Outline new land' : 'Outline land'}</span></button>
    <div class="tool-group" role="group" aria-label="Map">
      <button type="button" class="btn btn-quiet" data-act="basemap" aria-pressed="${app.basemap === 'satellite'}">${icon(app.basemap === 'satellite' ? 'satellite' : 'map')}<span>${app.basemap === 'satellite' ? 'Satellite' : 'Map'}</span></button>
      <button type="button" class="btn btn-quiet" data-act="tilt" aria-pressed="${app.tilted}">${icon('tilt')}<span>${app.tilted ? '3D' : '2D'}</span></button>
      ${house.design ? `<button type="button" class="btn btn-quiet" data-act="night" aria-pressed="${app.night}">${icon(app.night ? 'moon' : 'sun')}<span>${app.night ? 'Evening' : 'Day'}</span></button>` : ''}
      <button type="button" class="btn btn-quiet btn-icon" data-act="locate" aria-label="Go to my location" title="Go to my location">${icon('locate')}</button>
    </div>`;
  toolbar.querySelector('[data-act="outline"]').disabled = drawing;
}
toolbar.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'outline') startOutline();
  if (act === 'basemap') { app.basemap = app.basemap === 'satellite' ? 'street' : 'satellite'; setBasemap(map, app.basemap); renderToolbar(); }
  if (act === 'tilt') { app.tilted = !app.tilted; map.easeTo({ pitch: app.tilted ? 58 : 0, duration: 900 }); renderToolbar(); }
  if (act === 'night') { app.night = !app.night; house.setNight(app.night); renderToolbar(); }
  if (act === 'locate') locate();
});

async function locate() {
  const you = app.you ?? (await getLocation());
  if (!you) { toast('Your browser didn’t share a location.'); return; }
  app.you = you;
  if (!marker.current) marker.current = locationMarker(map, you);
  map.flyTo({ center: you, zoom: 17.5, pitch: app.tilted ? 58 : 0, duration: 2500 });
}

// ---- outlining ---------------------------------------------------------------------------------
function startOutline() {
  closePanel();
  if (map.getZoom() < 15.5) map.easeTo({ zoom: 17, duration: 800 });
  outliner.start();
  setMode('drawing');
  hint.hidden = false;
  updateHint({ ring: [], closed: false });
}

function updateHint({ ring, closed }) {
  if (!outliner.active && !closed) return;
  const m = measure(ring);
  const n = ring.length;
  const touch = matchMedia('(pointer: coarse)').matches;
  const verb = touch ? 'Tap' : 'Click';
  const msg = n === 0 ? `${verb} the first corner of the land.`
    : n < 3 ? `${verb} the next corner.`
    : touch ? 'Keep tapping corners. Tap the first corner, or Finish, when you’re done.' : 'Keep clicking corners. Click the first corner, or press Enter, to finish.';
  hint.innerHTML = `
    <p class="hint-msg">${msg}</p>
    <dl class="hint-facts num">
      <div><dt>Corners</dt><dd>${n}</dd></div>
      <div><dt>Area</dt><dd>${m && n >= 3 ? fmt.land(m.areaM2) : '–'}</dd></div>
      <div><dt>Around</dt><dd>${m && n >= 2 ? fmt.len(m.perimeterM) : '–'}</dd></div>
    </dl>
    <div class="hint-actions">
      <button type="button" class="btn btn-small btn-quiet" data-h="undo" ${n ? '' : 'disabled'}>Undo</button>
      <button type="button" class="btn btn-small btn-quiet" data-h="cancel">Cancel</button>
      <button type="button" class="btn btn-small btn-primary" data-h="finish" ${n >= 3 ? '' : 'disabled'}>Finish</button>
    </div>`;
}
hint.addEventListener('click', (e) => {
  const h = e.target.closest('[data-h]')?.dataset.h;
  if (h === 'undo') outliner.undo();
  if (h === 'cancel') outliner.cancel();
  if (h === 'finish') outliner.finish();
});

function onOutlineDone(ring, edited) {
  hint.hidden = true;
  const m = measure(ring);
  const problems = problemsFor(m);
  if (edited && app.site) {
    app.site.ring = ring;
    saveSite();
    if (app.mode === 'brief') openBrief();
    return;
  }
  app.site = {
    id: `site-${Date.now().toString(36)}`,
    ring,
    brief: store.get('lastBrief', null),
    mode: 'dream',
    builder: store.get('builder', null),
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  if (problems.length) toast(problems[0]);
  saveSite();
  openBrief();
}

function saveSite() {
  if (!app.site) return;
  store.update('sites', [], (list) => [app.site, ...list.filter((s) => s.id !== app.site.id)].slice(0, 30));
}

// ---- panels ------------------------------------------------------------------------------------
function openPanel(render) {
  panel.hidden = false;
  panel.replaceChildren();
  render(panel);
  panel.scrollTop = 0;
  requestAnimationFrame(() => panel.classList.add('is-open'));
}
function closePanel() {
  panel.classList.remove('is-open');
  panel.hidden = true;
  panel.replaceChildren();
}
panel.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) { closePanel(); if (app.mode === 'brief') setMode(house.design ? 'house' : 'explore'); } });

function openBrief() {
  setMode('brief');
  openPanel((el) => renderBriefPanel(el, {
    site: app.site,
    measure: measure(app.site.ring),
    onEditOutline: () => { closePanel(); outliner.load(app.site.ring); toast('Drag the corners to adjust the outline.'); setMode('explore'); },
    onChange: (patch) => { Object.assign(app.site, patch); if (patch.brief) store.set('lastBrief', patch.brief); if (patch.builder) store.set('builder', patch.builder); saveSite(); },
    onSend: () => send(),
  }));
}

async function send() {
  setMode('sending');
  const request = buildRequest();
  openPanel((el) => renderSending(el, {
    request,
    run: () => api.submitDesign(request),
    onFailed: (err) => {
      app.site.status = 'not-sent';
      app.site.lastError = err.code ?? 'error';
      saveSite();
      setMode('failed');
    },
    onRetry: () => send(),
    onEdit: () => openBrief(),
    onPreview: () => previewSample(),
  }));
}

function buildRequest() {
  const m = measure(app.site.ring);
  const ring = app.site.ring.map((p) => [+p[0].toFixed(7), +p[1].toFixed(7)]);
  return {
    schema: 'terrasim.design-request/1',
    site: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
      properties: { areaM2: Math.round(m.areaM2), perimeterM: Math.round(m.perimeterM), centroid: m.centroid.map((v) => +v.toFixed(6)), setbackM: 3 },
    },
    brief: app.site.brief,
    mode: app.site.mode,
    builder: app.site.mode === 'build' ? app.site.builder : null,
    client: { units: settings.units, createdAt: new Date().toISOString() },
  };
}

async function previewSample() {
  const design = await api.design('sample-0001');
  const placement = placeOnLot(design, app.site.ring);
  house.show({ ...design, previewOn: app.site.id }, placement);
  app.site.preview = true;
  saveSite();
  setMode('house');
  closePanel();
  if (!placement.fits) toast('The sample house is bigger than this lot, so it hangs over the outline.');
  else toast('Sample house placed on your lot. Click it for details.');
  frameHouse(placement);
  setTimeout(() => openHouse(), 2900);
}

// Frames the house in the part of the screen the side panel leaves free.
function panelPadding() {
  const wide = innerWidth > 760;
  return wide
    ? { top: 80, bottom: 90, left: 40, right: Math.min(460, innerWidth * 0.4) + 40 }
    : { top: 70, bottom: Math.round(innerHeight * 0.55), left: 20, right: 20 };
}
function frameHouse(placement, { duration = 1800 } = {}) {
  const fp = placement.footprint;
  const c = [fp.reduce((s, p) => s + p[0], 0) / fp.length, fp.reduce((s, p) => s + p[1], 0) / fp.length];
  // Look at the front of the house, a little from the side.
  const bearing = (placement.xAxisBearingDeg + 90 + 180 + 25) % 360;
  map.easeTo({ center: c, zoom: 19.1, pitch: 62, bearing, duration, padding: panelPadding() });
}

async function openHouse() {
  const design = house.design;
  if (!design) return;
  const estimate = await api.estimate('sample-0001');
  setMode('house');
  openPanel((el) => renderHousePanel(el, {
    design,
    estimate,
    preview: !!design.previewOn,
    onWalk: () => openWalk(design),
    shareUrl: () => (design.previewOn ? shareLink({ preview: true }) : `${location.href.split('#')[0]}#l=${design.id}`),
    onNight: (on) => { app.night = on; house.setNight(on); renderToolbar(); },
  }));
}

async function openWalk(design) {
  const { openWalkthrough } = await import('./walk/walk.js');
  openWalkthrough($('#walk'), design);
}

// Top bar: lists and units.
function leaveGlobe() {
  if (app.mode !== 'globe') return;
  stopSpin();
  intro.hidden = true;
  setMode('explore');
}

document.querySelector('[data-open="catalog"]').addEventListener('click', async () => {
  const listings = await api.listings();
  leaveGlobe();
  openPanel((el) => renderCatalog(el, {
    listings,
    onOpen: (l) => {
      closePanel();
      const placement = l.design.placement;
      setMode('house');
      const c = l.design.placement.footprint[0];
      map.flyTo({ center: c, zoom: 18.3, pitch: 60, bearing: -30, duration: 4500, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      map.once('moveend', () => { setGlobe(map, false); house.show(l.design, placement); frameHouse(placement); setTimeout(openHouse, 2600); });
    },
  }));
});
document.querySelector('[data-open="sites"]').addEventListener('click', () => {
  leaveGlobe();
  openPanel((el) => renderSites(el, {
    sites: store.get('sites', []),
    onOpen: (s) => {
      closePanel();
      app.site = s;
      outliner.load(s.ring);
      const c = measure(s.ring).centroid;
      map.flyTo({ center: c, zoom: 18, pitch: 55, duration: 3500, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      map.once('moveend', () => { setGlobe(map, false); openBrief(); });
    },
    onDelete: (s) => store.update('sites', [], (list) => list.filter((x) => x.id !== s.id)),
  }));
});

function syncUnits() {
  document.querySelectorAll('[data-units]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.units === settings.units)));
}
document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
  settings.units = b.dataset.units;
  syncUnits();
  if (app.mode === 'brief') openBrief();
  if (app.mode === 'house' && !panel.hidden) openHouse();
}));
syncUnits();

document.querySelector('.brand').addEventListener('click', (e) => {
  e.preventDefault();
  closePanel();
  outliner.clear();
  house.hide();
  intro.hidden = false;
  intro.classList.remove('is-leaving');
  setMode('globe');
  setGlobe(map, true);
  map.flyTo({ center: [map.getCenter().lng, 20], zoom: 1.6, pitch: 0, bearing: 0, duration: 4000, padding: { top: 0, bottom: Math.round(innerHeight * 0.34), left: 0, right: 0 } });
});

// The brand mark is a Rive file; the text wordmark stands alone if it fails.
const markEl = document.querySelector('[data-rive="mark"]');
mountRive(markEl, { src: 'assets/rive/mark.riv', stateMachine: 'Mark', hoverInput: 'hover', hoverTarget: markEl.closest('a') });
