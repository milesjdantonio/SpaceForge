// TerraSim: the globe, the fly-down, outlining land, the brief, sending, and the house on its lot.

import { settings, store } from './store.js';
import { createMap, setBasemap, locationMarker, flyToGround, getLocation, setEvening, clearLand, nearbyStreets } from './map/map.js';
import { createOutliner } from './map/draw.js';
import { createHouseLayer } from './map/house-layer.js';
import { measure, problemsFor, placeOnLot, placementCenter } from './lib/place.js';
import { fmt } from './format.js';
import { api } from './api/client.js';
import { config } from './config.js';
import { auth } from './auth.js';
import { buildings } from './api/buildings.js';
import { savedDocument, readSavedBuilding } from './lib/saved-building.js';
import { createBuildingSaver } from './lib/building-saver.js';
import { loadSavedScene, sceneCamera } from './lib/saved-scene.js';
import { mountAccount } from './ui/account.js';
import { mountHelp } from './ui/help.js';
import { enablePress } from './ui/press.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { renderBriefPanel } from './panels/brief.js';
import { buildRequest } from './api/request.js';
import { renderSending } from './panels/send.js';
import { renderHousePanel, renderDesignProblems } from './panels/house.js';
import { checkDesign, pointInPolygon } from './lib/design.js';
import { isSite, homePlacement, variantOf } from './lib/site.js';
import { landFit } from './lib/fit.js';
import { explainSaveError } from './lib/errors.js';
import { createMover } from './map/mover.js';
import { createTopo } from './map/topo.js';
import { shareDocument, packShare, unpackShare } from './lib/share.js';
import { renderSites } from './panels/lists.js';
import { renderShare } from './panels/share.js';
import { mountRive } from './rive.js';
import { createStarfield } from './map/stars.js';
import { searchPlaces, suggestPlaces, placeName } from './map/places.js';

const $ = (sel) => document.querySelector(sel);
const body = document.body;
const panel = $('#panel');
const toolbar = $('#toolbar');
const hint = $('#draw-hint');
const intro = $('#intro');
const account = mountAccount($('#account-button'), $('#dialog'));
mountHelp($('#help-button'), $('#help'));
enablePress();
const scopeKey = (key) => auth.user ? `${key}:${auth.user.uid}` : key;

const app = {
  mode: 'globe',
  basemap: 'satellite',
  tilted: true,
  night: false,
  site: null,      // { id, ring, form, mode, builder, status }
  you: null,       // visitor location [lng, lat]
  estimates: new Map(), // design id -> estimate that came with it
  savedBuilding: null, // SQL UUID + owner, separate from the immutable Gemma design ID
  displayVersion: 0,
  generation: null,
  currentDesignID: null,
  libraryVersion: 0,
  saving: null,
  savers: new Map(), // One ordered writer per SQL building, independent of selection.
  records: new Map(), // SQL UUID -> validated document for the signed-in account
  removedRecords: new Set(),
  sceneReady: false,
  sceneVersion: 0,
  navigationVersion: 0,
  names: new Map(),  // design id -> the person's own name for it
  shared: new Set(), // design ids opened from someone's link
};

// Declared early: a share link opens the brief (and the hint) before the rest of this file runs.
const hintPin = { el: null, rive: null, replay: false }; // the drawing hint's Rive pin

function setMode(mode) {
  if (mode !== 'house') stopOrbit({ reopen: false });
  app.mode = mode;
  body.dataset.mode = mode;
  const compass = document.querySelector('[data-ctl="north"]');
  const label = mode === 'globe' ? 'Centre the Earth on your location' : 'Face north, look straight down (hold Ctrl and drag the map to turn and tilt)';
  compass?.setAttribute('aria-label', label);
  compass?.setAttribute('title', label);
  renderToolbar();
}

// ---- boot --------------------------------------------------------------------------------------
// When the site is served by the design service itself (housecost -serve), its API is at /api on
// the same address: use it unless another one was chosen with ?api=.
// Opened locally from another server (npm start on :5173), it also looks for the service on :8000.
if (!config.apiBaseUrl) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const bases = [`${location.origin}/api`, ...(local && location.port !== '8000' ? ['http://localhost:8000/api'] : [])];
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      const h = res.ok ? await res.json() : null;
      if (h?.ok) {
        config.apiBaseUrl = base;
        if (h.key === false) console.warn('[TerraSim] The design service has no Gemini API key yet; designs will fail until one is added.');
        break;
      }
    } catch {}
  }
}

const { map, stopSpin, startSpin } = await createMap($('#map'));
createStarfield($('#stars'), map);
const outliner = createOutliner(map, {
  onChange: (s) => updateHint(s),
  onFinish: (ring, { edited }) => onOutlineDone(ring, edited),
  onCancel: () => { hint.hidden = true; setMode('explore'); },
});
const house = createHouseLayer(map);
map.addLayer(house.layer);
// Contour lines over the land being built on, and its lie (slope, fall) for the brief.
const topo = createTopo(map);
let survey = { ring: null, promise: Promise.resolve(null) };
function surveyFor(ring) {
  if (!ring) { topo.hide(); survey = { ring: null, promise: Promise.resolve(null) }; clearLands(); return survey.promise; }
  if (survey.ring !== ring) { survey = { ring, promise: topo.show(ring) }; clearLands(); }
  return survey.promise;
}
// The map's own buildings give way on the land being designed for and under every saved building.
function clearLands() {
  const rings = [survey.ring, ...house.entries.map((e) => e.design.site?.outline)].filter(Boolean);
  clearLand(map, rings);
}
// Contours follow the outline: shown with land, cleared with it, hidden while drawing new land.
{
  const { load, clear, start } = outliner;
  outliner.load = (ring) => { load(ring); surveyFor(ring); };
  outliner.clear = () => { clear(); surveyFor(null); };
  outliner.start = () => { start(); surveyFor(null); };
}
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

const touch = () => matchMedia('(pointer: coarse)').matches;
const verb = () => (touch() ? 'Tap' : 'Click');
// The three ways to start on the intro: your marker (once the location is known), anywhere on the
// globe, or zooming in. Wording follows the device; the marker option says why when it can't be used.
let located = false;
for (const slot of intro.querySelectorAll('[data-icon]')) slot.innerHTML = icon(slot.dataset.icon === 'scroll' && touch() ? 'pinch' : slot.dataset.icon);
function globeHint() {
  const option = (name) => intro.querySelector(`[data-start="${name}"]`);
  const home = option('marker');
  home.querySelector('[data-start-title]').textContent = `${verb()} your marker`;
  home.querySelector('[data-start-note]').textContent = !located ? 'Finding your location…'
    : app.you ? 'Fly straight to where you are.' : 'Your location wasn’t shared.';
  home.disabled = !app.you;
  home.classList.toggle('is-loading', !located);
  home.setAttribute('aria-busy', String(!located));
  home.classList.toggle('is-unavailable', located && !app.you);
  // Once it can be used, a neon line travels round its edge to show it can be clicked.
  home.classList.toggle('is-ready', !!app.you);
  option('anywhere').querySelector('[data-start-title]').textContent = `${verb()} anywhere`;
  option('zoom').querySelector('[data-start-title]').textContent = touch() ? 'Pinch to zoom in' : 'Scroll on the world';
}
intro.querySelector('[data-start="marker"]').addEventListener('click', () => goHome());
globeHint();

const marker = { current: null };
if (location.hash.startsWith('#s=')) await openShared(location.hash);
getLocation().then((you) => {
  app.you = you;
  located = true;
  if (you) marker.current = locationMarker(map, you, { onClick: () => goHome() });
  globeHint();
});

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
  if (app.justMoved && Date.now() - app.justMoved < 400) return;
  if (mover.active) return; // While moving, clicks on the map neither select nor deselect.
  if (app.mode === 'house' || app.mode === 'explore' || app.mode === 'failed') {
    const hit = house.pick(e.point) ?? house.at([e.lngLat.lng, e.lngLat.lat]);
    // A click on a building always opens its details (cost, materials, plans); Move sits beside it.
    if (hit) selectBuilding(hit, { details: true });
    else if (emptyLandAt(e.lngLat)) {
      // Land with no building on it: back to its brief, to design one.
      house.deselect();
      openBrief();
    } else {
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
  const land = !hit && !mover.active && emptyLandAt(e.lngLat);
  map.getCanvas().style.cursor = hit || land ? (mover.active && house.isSelected(hit) ? 'grab' : 'pointer') : app.mode === 'globe' ? 'crosshair' : '';
  // Say what a click will open before it's clicked.
  const show = (!!hit || !!land) && !mover.active && !e.originalEvent?.ctrlKey;
  hoverTip.hidden = !show;
  if (show) {
    hoverTip.textContent = land ? 'Click to design a building on this land'
      : panel.dataset.view === 'house' && house.isSelected(hit) ? 'Showing its details' : 'Click for details: cost, plans, materials';
    hoverTip.style.transform = `translate(${e.point.x + 16}px, ${e.point.y + 18}px)`;
  }
});
// The land being worked on, when the point is on it and it has no building yet (or its building
// was removed or failed): a click there reopens its brief. null otherwise.
function emptyLandAt(lngLat) {
  const site = app.site;
  if (!site?.ring || outliner.active || !['house', 'explore', 'failed'].includes(app.mode) || map.getZoom() < 15) return null;
  if (!pointInPolygon(lngLat.lng, lngLat.lat, site.ring)) return null;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-7 && Math.abs(p[1] - b[i][1]) < 1e-7);
  const built = house.entries.some((e) => (site.designId && e.design?.id === site.designId) || same(e.design?.site?.outline, site.ring));
  return built ? null : site;
}
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
$('#main').append(tiltTip);
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
// A click selects a house (a thin line round it on the ground) and opens its details. The Move button beside a selected house
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
  canOffer: () => ['house', 'explore', 'failed'].includes(app.mode) && !outliner.active && !isSite(house.design), // a site is its land: it doesn't move
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
  const saving = app.saving;
  const saved = known?.uid === uid && known?.designID === design.id;
  const pending = saving?.uid === uid && saving?.version === version && saving?.designID === design.id;
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
// The opening view of the globe (the same as createMap's).
const HOME_VIEW = { center: [-40, 28], zoom: 1.9 };
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
// Zoomed all the way out, the Earth goes back to where it started: upright, facing north, beside
// the intro. It waits until the scroll wheel has stopped, so the two never fight.
let homeTimer = 0, homePending = false;
function goHomeWhenStill() {
  clearTimeout(homeTimer);
  homeTimer = setTimeout(() => {
    if (!homePending || app.mode !== 'globe') return;
    if (map.isMoving()) { goHomeWhenStill(); return; }
    homePending = false;
    map.easeTo({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom, pitch: 0, bearing: 0, duration: 1600, padding: globePadding() });
    map.once('moveend', () => { if (app.mode === 'globe') startSpin(); });
  }, 450);
}
map.on('zoomend', () => {
  const z = map.getZoom();
  if (z < WORLD_ZOOM && ['explore', 'house', 'failed', 'brief'].includes(app.mode)) {
    enterGlobeMode();
    homePending = true;
  }
  if (homePending) goHomeWhenStill();
  // Zooming in on the globe by hand leaves the intro.
  if (app.mode === 'globe' && z >= 6) { homePending = false; leaveGlobe(); }
});
map.on('zoomstart', () => clearTimeout(homeTimer));

// The Globe button: back out to the whole Earth, keeping the outline and any building.
function toWorld() {
  enterGlobeMode();
  closePanel();
  map.easeTo({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom, pitch: 0, bearing: 0, duration: 2200, padding: globePadding() });
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

// Where the satellite service has no imagery, the street map shows instead; say so once in a while.
let noImageryAt = 0;
addEventListener('terrasim:no-imagery', (e) => {
  if (app.basemap !== 'satellite' || e.detail.z < 13 || map.getZoom() < 13) return;
  if (Date.now() - noImageryAt < 90000) return;
  noImageryAt = Date.now();
  toast('No satellite imagery for this spot at this zoom, so the street map shows instead. Zoom out a little to see imagery.');
});

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
  // On the globe, the compass turns the Earth upright with you in the middle; on the map, it faces north.
  if (c === 'north' && app.mode === 'globe') {
    stopSpin();
    map.easeTo({ center: app.you ?? HOME_VIEW.center, zoom: HOME_VIEW.zoom, bearing: 0, pitch: 0, duration: 1400, padding: globePadding() });
  } else if (c === 'north') map.easeTo({ bearing: 0, pitch: map.getBearing() === 0 ? 0 : map.getPitch(), duration: 700 });
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
// Suggestions appear as you type (the cursor stays in the box); Enter goes to the first one, or
// runs a full search when there are no suggestions yet.
let suggestTimer = 0, foundFor = '';
async function runSearch(q, { typing }) {
  searchAbort?.abort();
  searchAbort = new AbortController();
  const signal = searchAbort.signal;
  results.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  if (!found.length || !typing) results.innerHTML = '<li class="search-note">Searching…</li>';
  try {
    const c = map.getCenter();
    const list = typing
      ? await suggestPlaces(q, { signal, near: app.mode === 'globe' ? null : [c.lng, c.lat] })
      : await searchPlaces(q, { signal });
    if (signal.aborted) return;
    found = list; foundFor = q;
    results.innerHTML = found.length
      ? found.map((p, i) => `<li role="option" id="sr-${i}" tabindex="-1" data-i="${i}"><span class="sr-name">${esc(p.name)}</span><span class="sr-detail">${esc(p.detail)}</span></li>`).join('')
      : '<li class="search-note">No places found. Try a town, address or landmark.</li>';
    if (!typing) results.querySelector('[data-i]')?.focus();
  } catch (err) {
    if (err.name !== 'AbortError') {
      results.innerHTML = `<li class="search-note">Search isn’t reachable right now. You can still click anywhere on the globe to fly there.</li><li role="option" tabindex="-1" data-retry class="search-retry">${icon('retry')}<span>Try the search again</span></li>`;
    }
  }
}
const searchClear = $('#search-clear');
searchClear.innerHTML = icon('close');
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input'));
  searchInput.focus();
});
searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  searchClear.hidden = !searchInput.value;
  const q = searchInput.value.trim();
  if (q.length < 2) { searchAbort?.abort(); found = []; foundFor = ''; closeResults(); return; }
  suggestTimer = setTimeout(() => runSearch(q, { typing: true }), 250);
});
searchInput.addEventListener('focus', () => {
  if (found.length && foundFor === searchInput.value.trim()) { results.hidden = false; searchInput.setAttribute('aria-expanded', 'true'); }
});
search.addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) return;
  if (found.length && foundFor === q) { goToPlace(found[0]); return; }
  runSearch(q, { typing: false });
});
function goToPlace(p) {
  closeResults();
  searchInput.value = p.name;
  searchClear.hidden = false;
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
  if (e.target.closest('[data-retry]')) { const q = searchInput.value.trim(); if (q.length >= 2) runSearch(q, { typing: false }); return; }
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

// The page's own address for share links, without this browser's ?api= or other settings.
const shareBase = () => location.origin + location.pathname;

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
  if (!app.site) return shareBase();
  const data = { v: 2, r: app.site.ring.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]), f: app.site.form ?? null, p: preview ? 1 : 0 };
  return `${shareBase()}#s=${encodeShare(data)}`;
}
async function openShared(hash) {
  const data = decodeShare(hash.slice(3));
  if (!data?.r || data.r.length < 3) {
    toast('That link is incomplete, so there’s no land to show. Ask for the link again, or outline land yourself.', { kind: 'error', action: { label: 'Outline land', run: () => { leaveGlobe(); startOutline(); } } });
    return false;
  }
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
  const outlineBtn = toolbar.querySelector('[data-act="outline"]');
  outlineBtn.disabled = drawing || app.generating;
  if (app.generating) outlineBtn.title = 'Wait for the design, or cancel it, to outline other land.';
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
  if (!you) {
    toast('Your browser didn’t share your location. Allow it in the address bar, or search for a place.', { kind: 'error', action: { label: 'Search', run: () => searchInput.focus() } });
    return;
  }
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
  placeHint();
  // Slide out, and drop the pin.
  hint.classList.remove('is-out');
  void hint.offsetWidth;
  hint.classList.add('is-out');
  hintPin.replay = true;
  updateHint({ ring: [], closed: false });
}

// The hint sits in the bottom-left corner; drag its grip to move it anywhere (remembered).
function placeHint() {
  const pos = store.get('hintPos', null);
  if (!pos) { hint.style.left = ''; hint.style.top = ''; hint.style.bottom = ''; hint.classList.remove('is-moved'); return; }
  const r = hint.getBoundingClientRect();
  const x = Math.max(8, Math.min(innerWidth - Math.max(r.width, 200) - 8, pos.x));
  const y = Math.max(8, Math.min(innerHeight - Math.max(r.height, 120) - 8, pos.y));
  Object.assign(hint.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto' });
  hint.classList.add('is-moved');
}
hint.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip) return;
  e.preventDefault();
  const r = hint.getBoundingClientRect();
  const off = { x: e.clientX - r.left, y: e.clientY - r.top };
  grip.setPointerCapture(e.pointerId);
  hint.classList.add('is-dragging');
  const move = (ev) => {
    const x = Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - off.x));
    const y = Math.max(8, Math.min(innerHeight - r.height - 8, ev.clientY - off.y));
    Object.assign(hint.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto' });
    hint.classList.add('is-moved');
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    hint.classList.remove('is-dragging');
    const nr = hint.getBoundingClientRect();
    store.set('hintPos', { x: nr.left, y: nr.top });
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});
hint.addEventListener('keydown', (e) => {
  // Arrow keys on the grip move the box too; Home puts it back in its corner.
  const grip = e.target.closest('[data-grip]');
  if (!grip) return;
  if (e.key === 'Home') { store.set('hintPos', null); placeHint(); e.preventDefault(); return; }
  const d = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key];
  if (!d) return;
  e.preventDefault();
  const r = hint.getBoundingClientRect();
  store.set('hintPos', { x: r.left + d[0], y: r.top + d[1] });
  placeHint();
});

function updateHint({ ring, closed, problem }) {
  if (!outliner.active && !closed) return;
  const m = measure(ring);
  const n = ring.length;
  const touch = matchMedia('(pointer: coarse)').matches;
  const verb = touch ? 'Tap' : 'Click';
  // Edges that would cross say so, and what to do instead.
  const problemMsg = problem === 'cross' ? `That corner would make two edges cross, so it wasn’t added. ${verb} somewhere the red line doesn’t cross the outline.`
    : problem === 'close' ? `Closing now would make two edges cross. Add a corner that untangles it, or press Undo.`
    : problem === 'cross-ahead' ? `A corner here would cross an edge.` : null;
  const msg = problemMsg ?? (n === 0 ? `${verb} the first corner of the land.`
    : n < 3 ? `${verb} the next corner.`
    : touch ? 'Keep tapping corners. Tap the pulsing first corner, or Finish, when you’re done.' : 'Keep clicking corners. Click the pulsing first corner, or press Enter, to finish.');
  // Until the first corner, a short loop shows how outlining works.
  const demo = n === 0 ? (hint.querySelector('.hint-demo') ?? null) : null;
  hint.innerHTML = `
    <div class="hint-head">
      <span class="hint-pin" aria-hidden="true"></span>
      <p class="hint-msg${problemMsg ? ' is-problem' : ''}" ${problem === 'cross' || problem === 'close' ? 'role="alert"' : ''}>${msg}</p>
      <button type="button" class="hint-grip" data-grip aria-label="Move this box (arrow keys; Home puts it back)" title="Drag to move">${icon('grip')}</button>
    </div>
    ${n === 0 ? '<div class="hint-demo" aria-hidden="true"></div>' : ''}
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
  if (n === 0) {
    const slot = hint.querySelector('.hint-demo');
    if (demo) slot.replaceWith(demo);
    else mountRive(slot, { src: 'assets/rive/outline.riv', fit: 'cover' });
  }
  // The pin keeps its Rive animation across updates; it drops again each time outlining starts.
  const pinSlot = hint.querySelector('.hint-pin');
  if (hintPin.el) pinSlot.replaceWith(hintPin.el);
  else {
    hintPin.el = pinSlot;
    hintPin.rive = mountRive(pinSlot, { src: 'assets/rive/pin.riv', stateMachine: 'Pin' });
    hintPin.replay = false;
  }
  if (hintPin.replay) { hintPin.rive?.fire('drop'); hintPin.replay = false; }
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
  surveyFor(ring);
  if (edited && app.site) {
    app.site.ring = ring;
    saveSite();
    if (app.mode === 'brief') openBrief();
    return;
  }
  app.site = {
    id: `site-${Date.now().toString(36)}`,
    ring,
    form: carriedForm(store.get(scopeKey('lastForm'), null)),
    mode: 'dream',
    builder: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  if (problems.length) toast(problems[0]);
  saveSite();
  openBrief();
}

// What a new building's brief keeps from the last one: the housing type, the Advanced menu and the
// description. The numbers (floors, size, bedrooms, budget, …) start empty and wait for the user.
function carriedForm(last) {
  if (!last) return null;
  return {
    housingType: last.housingType ?? null,
    answers: { designPrompt: last.answers?.designPrompt ?? '' },
    advanced: structuredClone(last.advanced ?? {}),
  };
}

function saveSite() {
  if (!app.site) return;
  store.update(scopeKey('sites'), [], (list) => [app.site, ...list.filter((s) => s.id !== app.site.id)].slice(0, 30));
}

// ---- panels ------------------------------------------------------------------------------------
function openPanel(render, view = '') {
  panel.dataset.view = view;
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
    coverage: api.coverage(measure(app.site.ring).centroid),
    terrain: surveyFor(app.site.ring),
    onEditOutline: () => { closePanel(); outliner.load(app.site.ring); toast('Drag the corners to adjust the outline.'); setMode('explore'); },
    onChange: (patch) => { Object.assign(app.site, patch); if (patch.form) store.set(scopeKey('lastForm'), patch.form); saveSite(); },
    onSend: () => send(),
    checkFit: api.connected ? (form) => api.fit(buildRequest({ ...app.site, form })) : null,
  }));
}

// While a design is generating the land is locked: its corners can't be dragged and no other land
// can be outlined, so the design always matches the land it was asked for.
function lockLand(on) {
  app.generating = on;
  outliner.setLocked(on);
  renderToolbar();
}

async function send({ keepRetryFlag = false } = {}) {
  if (!keepRetryFlag && app.site) app.site.costRetried = false;
  app.generation?.abort();
  const generation = new AbortController();
  app.generation = generation;
  const owner = auth.user?.uid ?? null;
  lockLand(true);
  setMode('sending');
  const request = buildRequest(app.site);
  // The streets near the land, from the map, so the design service can face the front to the street.
  try {
    const streets = nearbyStreets(map, app.site.ring);
    if (streets.length) request.site.properties.streets = streets;
  } catch { /* the map's tiles aren't readable: the service looks the streets up itself */ }
  app.site.lastRequestId = request.id;
  // The lot lights up while the design is made; the building grows out of it when it arrives.
  house.hide();
  house.generating(app.site.ring);
  const form = app.site.form ?? {};
  const checked = app.site.fitCheck?.formKey === JSON.stringify(app.site.form) ? app.site.fitCheck : null;
  const fit = checked ?? (form.housingType ? landFit(form.housingType, form.answers ?? {}, form.advanced ?? {}, measure(app.site.ring)) : null);
  openPanel((el) => renderSending(el, {
    request,
    fit,
    run: (onProgress) => api.createDesign(request, { onProgress, signal: generation.signal }),
    onDone: async ({ design, estimate }) => {
      if (generation.signal.aborted || (owner && auth.user?.uid !== owner)) return;
      // A design that came back without its cost or materials is made again, once, by itself.
      if (!design.cost && !estimate && !app.site.costRetried) {
        app.site.costRetried = true;
        toast('The design came back without its cost and materials, so it’s being made again.');
        send({ keepRetryFlag: true });
        return;
      }
      lockLand(false);
      if (!drawable(design, { fresh: true })) return;
      app.site.status = 'sent';
      app.site.designId = design.id;
      saveSite();
      api.keepLocal(design, estimate);
      house.stopGenerating();
      const site = app.site;
      showDesign(design, estimate, { site });
      if (owner) {
        const save = async () => {
          try { await persistBuilding(design, estimate, site, house.design === design ? house.placement : design.placement); toast('Design saved to your account.'); }
          catch (err) {
            const why = explainSaveError(err);
            toast(`Design received, but not saved. ${why.text}`, { kind: 'error', action: why.action && { label: why.action, run: () => (err.code === 'sign-in-required' || err.status === 401 ? account.require().then((u) => u && save()) : save()) } });
          }
        };
        save();
      }
    },
    onFailed: (err) => {
      if (generation.signal.aborted) return;
      lockLand(false);
      app.site.status = 'not-sent';
      app.site.lastError = err.code ?? 'error';
      saveSite();
      house.failGenerating();
      setMode('failed');
    },
    onRetry: () => send(),
    onCancel: () => {
      generation.abort();
      lockLand(false);
      house.stopGenerating();
      app.site.status = 'draft';
      saveSite();
      openBrief();
      toast('Design cancelled. Your brief is kept, so you can change it or send it again.');
    },
    onEdit: () => openBrief(),
    onPreview: () => previewSample(),
    onOutline: () => { closePanel(); outliner.clear(); app.site = null; setMode('explore'); startOutline(); },
    // A suggested change: apply it to the brief and open the brief so it can be checked and sent.
    onFix: (patch) => {
      const f = app.site.form ?? { answers: {} };
      app.site.form = { ...f, answers: { ...f.answers, ...patch } };
      store.set(scopeKey('lastForm'), app.site.form);
      saveSite();
      openBrief();
      toast('Brief changed. Check it, then send it again.');
    },
  }));
}

// Redesign from a written change (Change this design). The service turns the change into a new brief
// and designs it on the same land; the new design replaces this one (and its saved copy). A
// cancelled or failed change puts the old design back as it was.
function sendEdit(design, estimate, change) {
  app.generation?.abort();
  const generation = new AbortController();
  app.generation = generation;
  const owner = auth.user?.uid ?? null;
  const before = { design, estimate, placement: house.placement, savedBuilding: app.savedBuilding, site: app.site };
  // The brief this design was made from, when this tab still has it; otherwise the service reads
  // one back from the design.
  const original = app.site?.designId === design.id && app.site?.form?.housingType ? buildRequest(app.site) : null;
  const restore = () => {
    if (generation.signal.aborted && app.generation !== generation) return;
    lockLand(false);
    showDesign(before.design, before.estimate, { site: before.site, placement: before.placement, savedBuilding: before.savedBuilding, focus: false });
  };
  lockLand(true);
  setMode('sending');
  house.hide();
  house.generating(design.site.outline);
  const ring = design.site.outline;
  const display = {
    housingType: design.housingType,
    brief: { floors: design.totals.floors, designPrompt: `Change: ${change}` },
    aiDecides: [],
    site: { geometry: { coordinates: [[...ring, ring[0]]] }, properties: { areaM2: design.site.areaM2 ?? 0 } },
  };
  openPanel((el) => renderSending(el, {
    request: display,
    fit: null,
    run: (onProgress) => api.editDesign({ design, request: original, change }, { onProgress, signal: generation.signal }),
    onDone: async ({ design: next, estimate: est, request }) => {
      if (generation.signal.aborted || (owner && auth.user?.uid !== owner)) return;
      lockLand(false);
      if (!drawable(next, { fresh: true })) return;
      house.stopGenerating();
      // The change replaces the old design, and its saved copy when there is one.
      if (before.savedBuilding?.uid === owner) app.savedBuilding = { ...before.savedBuilding, designID: next.id };
      const site = { ...(before.site ?? {}), ring: next.site.outline, designId: next.id, status: 'sent', lastRequestId: request?.id ?? null };
      app.site = site;
      api.keepLocal(next, est);
      showDesign(next, est, { site, savedBuilding: app.savedBuilding });
      if (owner) {
        try { await persistBuilding(next, est, site, next.placement); toast('Changed design saved.'); }
        catch (err) { toast(`The changed design is on the map but wasn’t saved. ${explainSaveError(err).text}`, { kind: 'error' }); }
      }
    },
    onFailed: () => {
      if (generation.signal.aborted) return;
      lockLand(false);
      house.failGenerating();
      setMode('failed');
    },
    onRetry: () => sendEdit(design, estimate, change),
    onEdit: () => restore(),
    onPreview: () => restore(),
    onOutline: () => { closePanel(); outliner.clear(); app.site = null; setMode('explore'); startOutline(); },
    onCancel: () => {
      generation.abort();
      house.stopGenerating();
      restore();
      toast('Change cancelled. The design is as it was.');
    },
  }));
}

// Checks a design against the contract before anything is drawn; a broken file opens a panel that
// says what's wrong instead.
// `fresh` is set for a design Gemma just sent, which can be generated again.
function drawable(design, { fresh = false } = {}) {
  let result;
  try { result = checkDesign(design); }
  catch { result = { ok: false, errors: [{ rule: 0, message: 'The design file has an incomplete structure.' }], warnings: [] }; }
  for (const w of result.warnings) console.warn(`[design ${design?.id}] ${w.message}`);
  if (result.ok) return true;
  if (fresh) house.failGenerating();
  setMode(house.design ? 'house' : 'explore');
  const actions = fresh
    ? [{ label: 'Generate again', primary: true, run: () => send() }, { label: 'Edit the brief', run: () => openBrief() }]
    : [{ label: 'Choose another file', primary: true, run: () => openSites().then(() => panel.querySelector('[data-file]')?.click()) }];
  if (config.showSample && app.site) actions.push({ label: 'Preview the sample house', run: () => previewSample() });
  openPanel((el) => renderDesignProblems(el, { design, result, onClose: closePanel, actions }));
  return false;
}

// Shows a stored design where it stands: flies there, draws the lot and the building, opens it.
function showDesign(design, estimate, { site = null, placement = design.placement, savedBuilding = null, focus = true, camera = null, animate = true, selected = false, details = true } = {}) {
  if (!drawable(design)) return;
  const version = ++app.displayVersion;
  app.currentDesignID = design.id;
  app.savedBuilding = savedBuilding;
  app.site = site ?? { id: `site-${Date.now().toString(36)}`, ring: design.site.outline, form: null, mode: 'dream', status: 'sent', createdAt: design.createdAt };
  if (estimate) app.estimates.set(design.id, estimate);
  closePanel();
  setMode('house');
  stopSpin(); intro.hidden = true;
  outliner.load(app.site.ring);
  // The rise waits for the camera to arrive, so it's seen from the start.
  const riseDelay = focus && !camera ? 1600 : 1;
  house.show(design, placement, { id: savedBuilding?.id ?? null, animate: animate && riseDelay, selected });
  if (camera) {
    map.jumpTo({ ...camera, padding: panelPadding() });
    app.tilted = camera.pitch > 0;
  } else if (focus) frameHouse(placement);
  if (details) {
    // Details open as the building lands, not while it rises.
    if (focus && !camera) setTimeout(() => { if (version === app.displayVersion) openHouse(); }, Math.max(1900, house.riseRemaining - 500));
    else openHouse();
  }
  rememberScene();
}

// Opens a design file from disk: a Gemma reply ({ design, estimate }) or a bare design.
async function openDesignFile(file) {
  let data;
  const another = { label: 'Choose another file', run: () => openSites().then(() => panel.querySelector('[data-file]')?.click()) };
  try { data = JSON.parse(await file.text()); }
  catch { toast(`“${file.name}” isn’t a JSON file, so it can’t be opened. Choose a design file saved from TerraSim or Gemma.`, { kind: 'error', action: another }); return; }
  const design = data?.design ?? data;
  const estimate = data?.estimate ?? null;
  if (design?.schema !== 'terrasim.design/2' && !isSite(design)) {
    toast(`“${file.name}” isn’t a TerraSim design (it needs "schema": "terrasim.design/2", or "terrasim.design/3" for a site).`, { kind: 'error', action: another });
    return;
  }
  showDesign(design, estimate);
}

async function previewSample() {
  ++app.displayVersion;
  app.savedBuilding = null;
  let design;
  try { design = await api.design('sample-0001'); }
  catch {
    toast('The sample house couldn’t load. Check your connection and try again.', { kind: 'error', action: { label: 'Try again', run: () => previewSample() } });
    return;
  }
  app.currentDesignID = design.id;
  if (!drawable(design)) return;
  const placement = placeOnLot(design, app.site.ring);
  house.show({ ...design, previewOn: app.site.id }, placement, { animate: 1600 });
  app.site.preview = true;
  saveSite();
  setMode('house');
  closePanel();
  if (!placement.fits) toast('The sample house is bigger than this lot, so it hangs over the outline.');
  else toast('Sample house placed on your lot. Click it, then choose Move to move or turn it.');
  frameHouse(placement);
  setTimeout(() => openHouse(), Math.max(2900, house.riseRemaining - 500));
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
  const version = app.displayVersion;
  const owner = auth.user?.uid ?? null;
  // New housecost designs carry their cost; older services return a separate estimate.
  let estimate = design.cost ?? app.estimates.get(design.id) ?? null;
  if (!estimate) {
    try { estimate = await api.estimate(design.id); } catch { estimate = null; }
  }
  if (version !== app.displayVersion || house.design !== design || (auth.user?.uid ?? null) !== owner) return;
  setMode('house');
  openPanel((el) => renderHousePanel(el, {
    design,
    estimate,
    preview: !!design.previewOn,
    onWalk: () => openWalk(design),
    onPreview: () => startOrbit(),
    onChangeDesign: api.connected && !design.sample && !design.previewOn ? (change) => sendEdit(design, estimate, change) : null,
    saved: app.savedBuilding?.uid === auth.user?.uid && app.savedBuilding?.designID === design.id,
    onSave: async () => {
      if (!(await account.require())) return false;
      await persistBuilding(design, estimate, app.site, house.placement);
      return true;
    },
    placement: house.placement,
    shared: app.shared.has(design.id),
    name: buildingName(design),
    // Renaming keeps Gemma's design as it is; the name is the saved record's own.
    onRename: design.sample ? null : async (name) => {
      app.names.set(design.id, name);
      const saved = app.savedBuilding?.uid === auth.user?.uid && app.savedBuilding?.designID === design.id;
      if (saved) await persistBuilding(design, estimate, app.site, house.placement);
      toast(saved ? 'Renamed.' : 'Renamed. Choose Save building to keep the name in your account.');
    },
    onShare: () => shareBuilding(design),
    onNight: (on) => { app.night = on; house.setNight(on); setEvening(map, on); renderToolbar(); },
  }), 'house');
}

// The person's own name for a building: what they renamed it to, or its saved record's name.
function buildingName(design) {
  if (app.names.has(design.id)) return app.names.get(design.id);
  const id = app.savedBuilding?.designID === design.id ? app.savedBuilding.id : null;
  return (id && app.records.get(id)?.record.name) || null;
}

// Share: a real building goes into the link whole (design, where it stands, its land); the sample
// preview shares its land and brief. The link is made, kept in "Your share links", and shown in
// the Share panel to copy, open or download.
async function shareBuilding(design) {
  const name = buildingName(design) ?? design.overview.title;
  let url;
  if (design.sample) url = shareLink({ preview: !!design.previewOn });
  else {
    try {
      const doc = shareDocument({ design, placement: house.design === design ? house.placement : design.placement, ring: landOf(design) ?? design.site.outline, name, estimate: app.estimates.get(design.id) ?? null });
      url = `${shareBase()}#b=${await packShare(doc)}`;
    } catch {
      toast('This browser can’t pack the building into a link. Download it as a file to share instead.', { kind: 'error', action: { label: 'Download file', run: () => downloadBuilding(design) } });
      return;
    }
  }
  const link = { id: `${design.id}:${Date.now().toString(36)}`, designId: design.id, name, url, sample: !!design.sample, createdAt: new Date().toISOString() };
  // One entry per building: a newer link replaces the older one.
  store.update(scopeKey('shares'), [], (list) => [link, ...list.filter((l) => l.designId !== design.id)].slice(0, 50));
  openShare({ link, design });
}

// The Share panel: the link for the building being shared (if any), and all links made before.
function openShare({ link = null, design = null } = {}) {
  leaveGlobe();
  const render = () => renderShare(panel, {
    current: link,
    links: store.get(scopeKey('shares'), []),
    onCopy: (url) => copyLink(url, url === link?.url ? `Link copied. Send it to a builder, a landowner or anyone.` : 'Link copied.'),
    onOpen: (url) => window.open(url, '_blank', 'noopener'),
    onDownload: () => design && downloadBuilding(design),
    onRemove: (l) => store.update(scopeKey('shares'), [], (list) => list.filter((x) => x.id !== l.id)),
    onPickBuilding: () => openSites(),
  });
  openPanel(render, 'share');
}
async function copyLink(url, done) {
  try { await navigator.clipboard.writeText(url); toast(done); }
  catch { prompt('Your browser blocked copying. Copy this link:', url); }
}
// The building as a design file, opened with My Builds → Open a design file.
function downloadBuilding(design) {
  const placement = house.design === design ? house.placement : design.placement;
  const file = { design: { ...design, placement }, estimate: app.estimates.get(design.id) ?? null };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  a.download = `${(buildingName(design) ?? design.overview.title).replace(/[^\w -]+/g, '').trim() || 'building'}.terrasim.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Downloaded. The person you send it to opens it from My Builds → Open a design file.');
}

// Opening a building someone shared (#b=...): drawn where it stands, as theirs, ready to save.
async function openSharedBuilding(hash) {
  let doc;
  try { doc = await unpackShare(hash.slice(3)); }
  catch {
    toast('That building link is incomplete or damaged, often because an app cut it short. Ask for the link again, or for the building as a file.', { kind: 'error', action: { label: 'Outline land', run: () => { leaveGlobe(); startOutline(); } } });
    return;
  }
  if (!drawable(doc.design)) return;
  stopSpin(); intro.hidden = true;
  app.shared.add(doc.design.id);
  if (doc.name) app.names.set(doc.design.id, doc.name);
  const site = { id: `site-${Date.now().toString(36)}`, ring: doc.ring ?? doc.design.site.outline, form: null, mode: 'dream', builder: null, status: 'shared', createdAt: new Date().toISOString() };
  showDesign(doc.design, doc.estimate ?? null, { site, placement: doc.placement });
  toast('A building shared with you. Sign in and choose Save building to keep a copy.');
}

async function persistBuilding(design, estimate, site, placement) {
  const uid = auth.user?.uid;
  const version = app.displayVersion;
  if (!uid) throw new Error('Sign in to save your building.');
  const known = app.savedBuilding;
  const id = known?.uid === uid && known?.designID === design.id ? known.id : null;
  let writer = id ? app.savers.get(id) : null;
  if (!writer && app.saving?.uid === uid && app.saving.version === version && app.saving.designID === design.id) writer = app.saving;
  if (!writer) {
    const accountVersion = app.sceneVersion;
    writer = { uid, version, designID: design.id, id, save: createBuildingSaver({
      id,
      save: (input) => buildings.save(input),
      isCurrent: () => auth.user?.uid === uid && app.sceneVersion === accountVersion && !app.removedRecords.has(writer.id),
      onSaved: (result) => {
        writer.id = result.id;
        app.savers.set(result.id, writer);
        const document = readSavedBuilding(result);
        app.records.set(result.id, { record: result, document });
        if (app.currentDesignID === design.id && (app.displayVersion === version || app.savedBuilding?.id === result.id)) {
          app.savedBuilding = { id: result.id, uid, designID: design.id };
          house.remember(result.id);
        } else if (!house.entries.some((entry) => entry.id === result.id)) house.add(result.id, document.design, document.placement);
        app.sceneReady = true;
        rememberScene();
      },
    }) };
  }
  app.saving = writer;
  return writer.save({ name: (buildingName(design) ?? design.overview.title).slice(0, 120),
    data: savedDocument({ design, estimate, site, placement }) });
}

// ---- preview: the camera circles the building ---------------------------------------------------
// The panel slides away and the camera turns slowly round the building, until Stop, Escape, or any
// touch of the map; then the details come back.
var orbit = null; // var: setMode can run before this line on boot
function startOrbit() {
  if (!house.placement) return;
  stopOrbit({ reopen: false });
  closePanel();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  map.easeTo({ center: placementCenter(house.placement), zoom: Math.max(18.6, Math.min(map.getZoom(), 19.6)), pitch: 62,
    padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: reduced ? 0 : 1000 });
  const bar = document.createElement('div');
  bar.className = 'orbit-bar';
  bar.innerHTML = `<span class="orbit-label">${icon('orbit')}<span>Previewing ${esc(house.design?.overview?.title ?? 'the building')}</span></span><button type="button" class="btn btn-primary btn-small" data-stop>${icon('close')}<span>Stop</span></button>`;
  document.body.append(bar);
  let last = null, raf = 0;
  const step = (t) => {
    if (last != null) map.setBearing(map.getBearing() + Math.min(50, t - last) * 0.014); // about 26 s a lap
    last = t;
    raf = requestAnimationFrame(step);
  };
  const begin = setTimeout(() => { if (!reduced) raf = requestAnimationFrame(step); }, reduced ? 0 : 1050);
  const canvas = map.getCanvas();
  const onTouch = () => stopOrbit();
  const onKey = (e) => { if (e.key === 'Escape') stopOrbit(); };
  canvas.addEventListener('pointerdown', onTouch);
  canvas.addEventListener('wheel', onTouch, { passive: true });
  addEventListener('keydown', onKey);
  bar.querySelector('[data-stop]').addEventListener('click', () => stopOrbit());
  bar.querySelector('[data-stop]').focus();
  orbit = { cleanup: () => {
    clearTimeout(begin); cancelAnimationFrame(raf); bar.remove();
    canvas.removeEventListener('pointerdown', onTouch); canvas.removeEventListener('wheel', onTouch); removeEventListener('keydown', onKey);
  } };
}
function stopOrbit({ reopen = true } = {}) {
  if (!orbit) return;
  orbit.cleanup();
  orbit = null;
  if (reopen && house.design) openHouse();
}

async function openWalk(design) {
  stopOrbit({ reopen: false });
  const version = app.displayVersion;
  const { openWalkthrough } = await import('./walk/walk.js');
  if (version !== app.displayVersion) return;
  // The shown building's live placement, so the view outside matches where it stands now.
  const placement = house.design === design ? house.placement : design.placement;
  if (isSite(design)) {
    // A site: walk through its first home, where that home stands.
    const home = design.homes[0];
    openWalkthrough($('#walk'), variantOf(design, home).design, { map, placement: homePlacement(design, home, placement) });
    return;
  }
  openWalkthrough($('#walk'), design, { map, placement });
}

// Top bar: lists and units.
function leaveGlobe() {
  if (app.mode !== 'globe') return;
  stopSpin();
  intro.hidden = true;
  setMode('explore');
  map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
}

// The top bar's Share: the building on show (if any) gets its link; otherwise the links made before.
document.querySelector('[data-open="share"]').addEventListener('click', () => {
  if (house.design) shareBuilding(house.design);
  else openShare();
});
async function openSites() {
  await auth.ready;
  const version = ++app.libraryVersion;
  leaveGlobe();
  const uid = auth.user?.uid ?? null;
  let items = [], nextOffset = null, loading = !!uid, error = '';
  const render = () => renderSites(panel, {
    account: auth.user, buildings: items, nextOffset, loading, error,
    sites: store.get(scopeKey('sites'), []),
    onOpen: (s) => {
      closePanel();
      app.site = s;
      outliner.load(s.ring);
      const c = measure(s.ring).centroid;
      map.flyTo({ center: c, zoom: 18, pitch: 55, duration: 3500, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      map.once('moveend', () => openBrief());
    },
    onDelete: (s) => store.update(scopeKey('sites'), [], (list) => list.filter((x) => x.id !== s.id)),
    onOpenFile: (file) => openDesignFile(file),
    onSignIn: async () => { if (await account.require()) openSites(); },
    onOpenBuilding: async (summary) => {
      try {
        const record = await buildings.get(summary.id);
        const document = readSavedBuilding(record);
        if (auth.user?.uid !== uid) return;
        app.records.set(record.id, { record, document });
        app.sceneReady = true;
        openSceneBuilding(record.id);
      } catch (err) {
        toast(`“${summary.name}” couldn’t be opened. ${err.message || ''}`.trim(), { kind: 'error', action: { label: 'Back to My Builds', run: () => openSites() } });
      }
    },
    onDeleteBuilding: async (record) => {
      app.removedRecords.add(record.id);
      try { await buildings.remove(record.id); }
      catch (error) { if (auth.user?.uid === uid) app.removedRecords.delete(record.id); throw error; }
      if (auth.user?.uid !== uid) return;
      items = items.filter((item) => item.id !== record.id);
      app.savers.delete(record.id);
      house.remove(record.id); app.records.delete(record.id); clearLands();
      if (app.savedBuilding?.id === record.id) {
        app.savedBuilding = null; app.currentDesignID = null; ++app.displayVersion;
        outliner.clear(); setMode('explore');
      }
      rememberScene();
      toast('Building deleted.');
      if (!items.length && panel.dataset.view === 'sites') render();
    },
    onMore: () => load(nextOffset),
    onRetry: () => load(items.length ? nextOffset ?? 0 : 0),
  });
  async function load(offset = 0) {
    if (version !== app.libraryVersion) return;
    loading = true; error = ''; render();
    try {
      const page = await buildings.list(offset);
      if (auth.user?.uid !== uid || panel.dataset.view !== 'sites' || version !== app.libraryVersion) return;
      items = offset ? [...items, ...page.items] : page.items;
      nextOffset = page.next_offset;
    } catch (err) { error = `Your saved buildings couldn’t be loaded. ${err.message || ''}`.trim(); }
    finally { loading = false; if ((auth.user?.uid ?? null) === uid && panel.dataset.view === 'sites' && version === app.libraryVersion) render(); }
  }
  openPanel(render, 'sites');
  if (uid) await load();
}
document.querySelector('[data-open="sites"]').addEventListener('click', openSites);

function syncUnits() {
  document.querySelectorAll('[data-units]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.units === settings.units)));
}
document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
  settings.units = b.dataset.units;
  // Contour intervals are round in the chosen units, so the land is measured again.
  if (survey.ring) { const ring = survey.ring; survey = { ring: null, promise: Promise.resolve(null) }; surveyFor(ring); }
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

// ---- restore the account's saved scene ----------------------------------------------------------
function rememberScene() {
  const uid = auth.user?.uid;
  if (!uid || !app.sceneReady) return;
  const center = map.getCenter();
  store.set(`scene:${uid}`, {
    selectedID: house.design ? app.savedBuilding?.id ?? null : null,
    selected: house.selected,
    mode: app.mode === 'globe' ? 'globe' : 'map',
    camera: { center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
  });
}

function openSceneBuilding(id, options = {}) {
  const item = app.records.get(id);
  if (!item) return;
  // A house may have moved since its last response arrived; use its live placement.
  const placement = house.entries.find((entry) => entry.id === id)?.placement ?? item.document.placement;
  const { design, estimate } = item.document;
  showDesign(design, estimate, { ...item.document, placement, selected: true, ...options,
    savedBuilding: { id, uid: auth.user.uid, designID: design.id } });
}

async function restoreScene(uid) {
  const sceneVersion = ++app.sceneVersion;
  const displayVersion = app.displayVersion, navigationVersion = app.navigationVersion;
  const previous = store.get(`scene:${uid}`, null);
  const current = () => auth.user?.uid === uid && app.sceneVersion === sceneVersion;
  try {
    const { records, skipped } = await loadSavedScene({ client: buildings, isCurrent: current,
      onRecord: (record, document) => {
        if (app.records.has(record.id) || app.removedRecords.has(record.id)) return; // Preserve edits/deletions made during loading.
        house.add(record.id, document.design, document.placement);
        app.records.set(record.id, { record, document });
      },
    });
    if (!current()) return;
    app.sceneReady = true;
    clearLands();
    if (app.displayVersion === displayVersion && app.navigationVersion === navigationVersion && app.mode === 'globe' && !location.hash) {
      const camera = sceneCamera(previous);
      const newest = records.filter(({ record }) => app.records.has(record.id))
        .sort((a, b) => b.record.created_at.localeCompare(a.record.created_at))[0];
      const id = app.records.has(previous?.selectedID) ? previous.selectedID : newest?.record.id;
      if (camera && previous.mode === 'globe') {
        map.jumpTo({ ...camera, padding: globePadding() });
      } else if (id) {
        openSceneBuilding(id, { camera, animate: false, selected: previous?.selected === true });
      } else if (camera) {
        stopSpin(); intro.hidden = true; setMode('explore');
        map.jumpTo({ ...camera, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      }
    }
    if (skipped) toast(`${skipped} saved building${skipped === 1 ? '' : 's'} couldn’t be drawn. The rest are on the map.`, { kind: 'error', action: { label: 'Open My Builds', run: () => openSites() } });
  } catch (error) {
    if (current()) toast('Your saved buildings couldn’t be loaded right now.', { kind: 'error', action: { label: 'Try again', run: () => restoreScene(uid) } });
  }
}

let previousUser;
function accountChanged(user) {
  const uid = user?.uid ?? null;
  if (uid === previousUser) return;
  if (previousUser) {
    store.set(`designs:${previousUser}`, []);
    store.set(`sites:${previousUser}`, []);
    store.set(`builder:${previousUser}`, null);
    store.set(`lastForm:${previousUser}`, null);
    app.generation?.abort(); lockLand(false);
    mover.cancel(); map.dragPan.enable(); map.stop();
    ++app.displayVersion; ++app.sceneVersion;
    $('#walk [data-exit]')?.click();
    house.clear(); outliner.clear(); closePanel();
    app.site = null; app.estimates.clear(); app.savedBuilding = null; app.currentDesignID = null; app.names.clear();
    app.records.clear(); app.removedRecords.clear(); app.savers.clear(); app.saving = null; app.sceneReady = false;
    intro.hidden = false; intro.classList.remove('is-leaving');
    setMode('globe');
    map.jumpTo({ center: [-40, 28], zoom: 1.9, pitch: 0, bearing: 0, padding: globePadding() });
  }
  previousUser = uid;
  if (uid) restoreScene(uid);
  if (panel.dataset.view === 'sites' && !panel.hidden) openSites();
}
map.on('movestart', (event) => { if (event.originalEvent) ++app.navigationVersion; });
map.on('moveend', rememberScene);
addEventListener('pagehide', rememberScene);
auth.onChange(accountChanged);
auth.ready.then(() => accountChanged(auth.user));
// A shared building opens once everything above is ready (share links keep priority over the saved scene).
if (location.hash.startsWith('#b=')) openSharedBuilding(location.hash);
