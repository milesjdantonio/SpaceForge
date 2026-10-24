// TerraSim: the globe, the fly-down, outlining land, the brief, sending, and the house on its lot.

import { settings, store } from './store.js';
import { createMap, setBasemap, locationMarker, flyToGround, getLocation, setEvening } from './map/map.js';
import { createOutliner } from './map/draw.js';
import { createHouseLayer } from './map/house-layer.js';
import { measure, problemsFor, placeOnLot, inFootprint } from './lib/place.js';
import { fmt } from './format.js';
import { api } from './api/client.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { renderBriefPanel } from './panels/brief.js';
import { buildRequest } from './api/request.js';
import { renderSending } from './panels/send.js';
import { renderHousePanel, renderDesignProblems } from './panels/house.js';
import { checkDesign } from './lib/design.js';
import { renderCatalog, renderSites } from './panels/lists.js';
import { mountRive } from './rive.js';
import { createStarfield } from './map/stars.js';
import { searchPlaces, placeName } from './map/places.js';

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
  site: null,      // { id, ring, form, mode, builder, status }
  you: null,       // visitor location [lng, lat]
  estimates: new Map(), // design id -> estimate that came with it
};

function setMode(mode) {
  app.mode = mode;
  body.dataset.mode = mode;
  renderToolbar();
}

// ---- boot --------------------------------------------------------------------------------------
const { map, stopSpin, startSpin } = await createMap($('#map'));
createStarfield($('#stars'), map);
const outliner = createOutliner(map, {
  onChange: (s) => updateHint(s),
  onFinish: (ring, { edited }) => onOutlineDone(ring, edited),
  onCancel: () => { hint.hidden = true; setMode('explore'); },
});
const house = createHouseLayer(map);
map.addLayer(house.layer);
window.__terrasim = { map, app, house, stopSpin };

// The globe sits beside the intro: to its right on wide screens, above it on phones.
const wide = () => innerWidth > 760;
function globePadding() {
  return wide()
    ? { top: 0, bottom: 0, left: Math.min(560, Math.round(innerWidth * 0.4)), right: 0 }
    : { top: 0, bottom: Math.round(innerHeight * 0.34), left: 0, right: 0 };
}
map.setPadding(globePadding());
addEventListener('resize', () => { if (app.mode === 'globe') map.setPadding(globePadding()); });

const verb = () => (matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click');
function globeHint() {
  introHint.textContent = app.you
    ? `${verb()} your marker to fly home, or anywhere on the globe to go there.`
    : `${verb()} anywhere on the globe to fly there, or search for a place.`;
}

const marker = { current: null };
if (location.hash.startsWith('#s=')) await openShared(location.hash);
else if (location.hash.startsWith('#l=')) {
  setTimeout(() => document.querySelector('[data-open="catalog"]').click(), 300);
}
getLocation().then((you) => {
  app.you = you;
  if (you) marker.current = locationMarker(map, you, { onClick: () => goHome() });
  globeHint();
  if (!you) introHint.textContent = `Your location wasn’t shared. ${globeHintTail()}`;
});
const globeHintTail = () => `${verb()} anywhere on the globe to fly there, or search for a place.`;

function goHome() {
  if (!app.you) return;
  if (app.mode === 'globe' || map.getZoom() < 10) arrive(app.you, { zoom: 17.6 });
  else map.flyTo({ center: app.you, zoom: 17.5, pitch: app.tilted ? 58 : 0, duration: 2500 });
}

map.on('click', (e) => {
  if (e.originalEvent?.target?.closest?.('.you')) return;
  if (app.mode === 'globe') {
    // Fly to where the click landed, as long as it landed on the globe and not in space beside it.
    const back = map.project(e.lngLat);
    if (Math.hypot(back.x - e.point.x, back.y - e.point.y) > 4) return;
    arrive([e.lngLat.lng, e.lngLat.lat], { zoom: 16.2 });
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
  map.getCanvas().style.cursor = over ? 'pointer' : app.mode === 'globe' ? 'crosshair' : '';
});

// Space shows behind the globe whenever the map is zoomed out far enough to see it.
const syncSpace = () => {
  body.classList.toggle('in-space', map.getZoom() < 5.5);
  // Zoomed in on the globe, the intro steps back to just its hint so the map shows.
  body.classList.toggle('globe-near', map.getZoom() > 2.7);
};
map.on('zoom', syncSpace);
syncSpace();

// Zooming far out by hand eases back into globe mode where the camera already is: nothing is
// cleared and the camera isn't moved, so it never fights the scroll wheel.
const WORLD_ZOOM = 3;
function enterGlobeMode() {
  if (outliner.active) outliner.cancel();
  if (!wide()) closePanel();
  hint.hidden = true;
  setMode('globe');
  intro.hidden = false;
  intro.classList.remove('is-leaving');
  globeHint();
  placeChip.hidden = true;
}
map.on('zoomend', () => {
  const z = map.getZoom();
  if (z < WORLD_ZOOM && ['explore', 'house', 'failed', 'brief'].includes(app.mode)) enterGlobeMode();
  // Zooming in on the globe by hand leaves the intro.
  if (app.mode === 'globe' && z >= 6) leaveGlobe();
});

// The Globe button: back out to the whole Earth, keeping the outline and any building.
function toWorld() {
  enterGlobeMode();
  closePanel();
  const c = map.getCenter();
  map.easeTo({ center: [c.lng, Math.max(-50, Math.min(50, c.lat))], zoom: 1.9, pitch: 0, bearing: 0, duration: 2200, padding: globePadding() });
  map.once('moveend', () => { if (app.mode === 'globe') startSpin(); });
}

async function arrive(lngLat, { zoom = 17.6 } = {}) {
  stopSpin();
  setMode('flying');
  intro.classList.add('is-leaving');
  await flyToGround(map, lngLat, { zoom });
  intro.hidden = true;
  setMode('explore');
  const atYou = app.you && Math.abs(lngLat[0] - app.you[0]) < 1e-6 && Math.abs(lngLat[1] - app.you[1]) < 1e-6;
  toast(atYou ? 'You’re here. Pan around, then outline the land you want to build on.' : 'Pan around, then outline the land you want to build on.');
}

// ---- finding your way: controls, place name, search -------------------------------------------
const controls = $('#map-controls');
controls.querySelector('[data-ctl="in"]').innerHTML = icon('plus');
controls.querySelector('[data-ctl="out"]').innerHTML = icon('minus');
controls.querySelector('[data-ctl="globe"]').innerHTML = icon('globe');
const needle = controls.querySelector('.compass-needle');
controls.addEventListener('click', (e) => {
  const c = e.target.closest('[data-ctl]')?.dataset.ctl;
  if (c === 'in') map.zoomIn({ duration: 300 });
  if (c === 'out') map.zoomOut({ duration: 300 });
  if (c === 'north') map.easeTo({ bearing: 0, pitch: map.getBearing() === 0 ? 0 : map.getPitch(), duration: 700 });
  if (c === 'globe') toWorld();
});
const syncCompass = () => {
  needle.style.transform = `rotate(${-map.getBearing()}deg)`;
  controls.querySelector('[data-ctl="north"]').classList.toggle('is-turned', Math.abs(map.getBearing()) > 0.5 || map.getPitch() > 1);
};
map.on('rotate', syncCompass);
map.on('pitch', syncCompass);
syncCompass();

// "Near Asheville, North Carolina": where the map is looking, once it settles.
const placeChip = $('#place-chip');
let placeTimer = 0, placeAbort = null;
map.on('movestart', () => { clearTimeout(placeTimer); placeAbort?.abort(); });
map.on('moveend', () => {
  clearTimeout(placeTimer);
  if (app.mode === 'globe' || app.mode === 'flying' || map.getZoom() < 4) { placeChip.hidden = true; return; }
  placeTimer = setTimeout(async () => {
    placeAbort = new AbortController();
    try {
      const c = map.getCenter();
      const name = await placeName([c.lng, c.lat], map.getZoom(), { signal: placeAbort.signal });
      if (!name || app.mode === 'globe') return;
      placeChip.innerHTML = `${icon('pin')}<span>${name.replace(/[<>&]/g, '')}</span>`;
      placeChip.hidden = false;
    } catch {}
  }, 1200);
});

const search = $('#search');
const searchInput = $('#search-q');
const results = $('#search-results');
let found = [];
let searchAbort = null;
search.querySelector('.search-icon').innerHTML = icon('search');
const closeResults = () => { results.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); };
search.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q.length < 2) return;
  searchAbort?.abort();
  searchAbort = new AbortController();
  results.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  results.innerHTML = '<li class="search-note">Searching…</li>';
  try {
    found = await searchPlaces(q, { signal: searchAbort.signal });
    results.innerHTML = found.length
      ? found.map((p, i) => `<li role="option" id="sr-${i}" tabindex="-1" data-i="${i}"><span class="sr-name">${esc(p.name)}</span><span class="sr-detail">${esc(p.detail)}</span></li>`).join('')
      : '<li class="search-note">No places found. Try a town, address or landmark.</li>';
    results.querySelector('[data-i]')?.focus();
  } catch (err) {
    if (err.name !== 'AbortError') results.innerHTML = '<li class="search-note">Search isn’t reachable right now.</li>';
  }
});
function goToPlace(p) {
  closeResults();
  searchInput.value = p.name;
  searchInput.blur();
  stopSpin();
  if (app.mode === 'globe') { intro.classList.add('is-leaving'); }
  const done = () => { if (app.mode === 'globe' || app.mode === 'flying') { intro.hidden = true; setMode('explore'); } };
  setMode('flying');
  const padding = { top: 80, bottom: 90, left: 40, right: 40 };
  if (p.bbox && (p.bbox[2] - p.bbox[0] > 0.003 || p.bbox[3] - p.bbox[1] > 0.003)) {
    map.fitBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], { maxZoom: 17.5, pitch: app.tilted ? 50 : 0, duration: 4000, padding });
  } else {
    map.flyTo({ center: p.center, zoom: 17.5, pitch: app.tilted ? 58 : 0, duration: 4000, padding });
  }
  map.once('moveend', done);
}
results.addEventListener('click', (e) => {
  const li = e.target.closest('[data-i]');
  if (li) goToPlace(found[Number(li.dataset.i)]);
});
results.addEventListener('keydown', (e) => {
  const li = e.target.closest('[data-i]');
  if (!li) return;
  if (e.key === 'Enter') { e.preventDefault(); goToPlace(found[Number(li.dataset.i)]); }
  if (e.key === 'ArrowDown') { e.preventDefault(); (li.nextElementSibling ?? li).focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousElementSibling ?? searchInput).focus(); }
  if (e.key === 'Escape') { closeResults(); searchInput.focus(); }
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && !results.hidden) { e.preventDefault(); results.querySelector('[data-i]')?.focus(); }
  if (e.key === 'Escape') closeResults();
});
document.addEventListener('pointerdown', (e) => { if (!search.contains(e.target)) closeResults(); });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  const data = { v: 2, r: app.site.ring.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]), f: app.site.form ?? null, p: preview ? 1 : 0 };
  return `${location.href.split('#')[0]}#s=${encodeShare(data)}`;
}
async function openShared(hash) {
  const data = decodeShare(hash.slice(3));
  if (!data?.r || data.r.length < 3) { toast('That link doesn’t contain a site.'); return false; }
  stopSpin();
  intro.hidden = true;
  app.site = { id: `site-${Date.now().toString(36)}`, ring: data.r, form: data.v === 2 ? data.f ?? null : null, mode: 'dream', builder: null, status: 'shared', createdAt: new Date().toISOString() };
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
  if (act === 'night') { app.night = !app.night; house.setNight(app.night); setEvening(map, app.night); renderToolbar(); }
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
    form: store.get('lastForm', null),
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
    onChange: (patch) => { Object.assign(app.site, patch); if (patch.form) store.set('lastForm', patch.form); if (patch.builder) store.set('builder', patch.builder); saveSite(); },
    onSend: () => send(),
  }));
}

async function send() {
  setMode('sending');
  const request = buildRequest(app.site);
  app.site.lastRequestId = request.id;
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

// Checks a design against the contract before anything is drawn; a broken file opens a panel that
// says what's wrong instead.
function drawable(design) {
  const result = checkDesign(design);
  for (const w of result.warnings) console.warn(`[design ${design?.id}] ${w.message}`);
  if (result.ok) return true;
  setMode(house.design ? 'house' : 'explore');
  openPanel((el) => renderDesignProblems(el, { design, result, onClose: closePanel }));
  return false;
}

// Shows a stored design where it stands: flies there, draws the lot and the building, opens it.
function showDesign(design, estimate) {
  if (!drawable(design)) return;
  if (estimate) app.estimates.set(design.id, estimate);
  closePanel();
  setMode('house');
  const placement = design.placement;
  const c = placement.footprint[0];
  map.flyTo({ center: c, zoom: 18.3, pitch: 60, bearing: -30, duration: 4500, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  map.once('moveend', () => {
    stopSpin();
    intro.hidden = true;
      if (design.site?.outline) outliner.load(design.site.outline);
    house.show(design, placement);
    frameHouse(placement);
    setTimeout(openHouse, 2600);
  });
}

// Opens a design file from disk: a Gemma reply ({ design, estimate }) or a bare design.
async function openDesignFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('That file isn’t JSON.'); return; }
  const design = data?.design ?? data;
  const estimate = data?.estimate ?? null;
  if (design?.schema !== 'terrasim.design/2') { toast('That file isn’t a terrasim.design/2 design.'); return; }
  showDesign(design, estimate);
}

async function previewSample() {
  const design = await api.design('sample-0001');
  if (!drawable(design)) return;
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
  let estimate = app.estimates.get(design.id) ?? null;
  if (!estimate) {
    try { estimate = await api.estimate(design.id); } catch { estimate = null; }
  }
  setMode('house');
  openPanel((el) => renderHousePanel(el, {
    design,
    estimate,
    preview: !!design.previewOn,
    onWalk: () => openWalk(design),
    shareUrl: () => (design.previewOn ? shareLink({ preview: true }) : `${location.href.split('#')[0]}#l=${design.id}`),
    onNight: (on) => { app.night = on; house.setNight(on); setEvening(map, on); renderToolbar(); },
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
  map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
}

document.querySelector('[data-open="catalog"]').addEventListener('click', async () => {
  const listings = await api.listings();
  leaveGlobe();
  openPanel((el) => renderCatalog(el, {
    listings,
    onOpen: (l) => showDesign(l.design, l.estimate),
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
      map.once('moveend', () => openBrief());
    },
    onDelete: (s) => store.update('sites', [], (list) => list.filter((x) => x.id !== s.id)),
    onOpenFile: (file) => openDesignFile(file),
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
  globeHint();
  placeChip.hidden = true;
  map.flyTo({ center: [map.getCenter().lng, 20], zoom: 1.9, pitch: 0, bearing: 0, duration: 4000, padding: globePadding() });
  map.once('moveend', () => { if (app.mode === 'globe') startSpin(); });
});

// The brand mark is a Rive file; the text wordmark stands alone if it fails.
const markEl = document.querySelector('[data-rive="mark"]');
mountRive(markEl, { src: 'assets/rive/mark.riv', stateMachine: 'Mark', hoverInput: 'hover', hoverTarget: markEl.closest('a') });
