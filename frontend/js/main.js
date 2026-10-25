// TerraSim: the globe, the fly-down, outlining land, the brief, sending, and the house on its lot.

import { settings, store } from './store.js';
import { createMap, setBasemap, locationMarker, flyToGround, getLocation, setEvening, clearLand } from './map/map.js';
import { createOutliner } from './map/draw.js';
import { createHouseLayer } from './map/house-layer.js';
import { measure, problemsFor, placeOnLot } from './lib/place.js';
import { fmt } from './format.js';
import { api } from './api/client.js';
import { config } from './config.js';
import { auth } from './auth.js';
import { buildings } from './api/buildings.js';
import { readSavedBuilding } from './lib/saved-building.js';
import { createBuildingStorage } from './controllers/building-storage.js';
import { createSceneController } from './controllers/scene.js';
import { createAccountSession } from './controllers/account-session.js';
import { mountBuildingInteraction } from './controllers/building-interaction.js';
import { mountAccount } from './ui/account.js';
import { mountHelp } from './ui/help.js';
import { enablePress } from './ui/press.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { renderBriefPanel } from './panels/brief.js';
import { buildRequest } from './api/request.js';
import { renderSending } from './panels/send.js';
import { renderHousePanel, renderDesignProblems } from './panels/house.js';
import { checkDesign } from './lib/design.js';
import { landFit } from './lib/fit.js';
import { createTopo } from './map/topo.js';
import { shareDocument, packShare, unpackShare } from './lib/share.js';
import { projects } from './api/projects.js';
import { createLibraryController } from './controllers/library.js';
import { createGenerationObserver } from './controllers/generation.js';
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
  app.mode = mode;
  body.dataset.mode = mode;
  const compass = document.querySelector('[data-ctl="north"]');
  const label = mode === 'globe' ? 'Centre the Earth on your location' : 'Face north, look straight down (hold Ctrl and drag the map to turn and tilt)';
  compass?.setAttribute('aria-label', label);
  compass?.setAttribute('title', label);
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

const { mover, landOf } = mountBuildingInteraction({ map, app, house, outliner, panel, mainElement: $('#main'), store, auth, wide, panelPadding, arrive, openHouse, closePanel, setMode, rememberScene, openSceneBuilding, persistBuilding, isPending: (...args) => storage.pending(...args), toast });

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

function updateHint({ ring, closed }) {
  if (!outliner.active && !closed) return;
  const m = measure(ring);
  const n = ring.length;
  const touch = matchMedia('(pointer: coarse)').matches;
  const verb = touch ? 'Tap' : 'Click';
  const msg = n === 0 ? `${verb} the first corner of the land.`
    : n < 3 ? `${verb} the next corner.`
    : touch ? 'Keep tapping corners. Tap the first corner, or Finish, when you’re done.' : 'Keep clicking corners. Click the first corner, or press Enter, to finish.';
  // Until the first corner, a short loop shows how outlining works.
  const demo = n === 0 ? (hint.querySelector('.hint-demo') ?? null) : null;
  hint.innerHTML = `
    <div class="hint-head">
      <span class="hint-pin" aria-hidden="true"></span>
      <p class="hint-msg">${msg}</p>
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
    form: store.get(scopeKey('lastForm'), null),
    mode: 'dream',
    builder: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  if (problems.length) toast(problems[0]);
  saveSite();
  openBrief();
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
  }));
}

async function send() {
  if (!await account.require()) return;
  app.generation?.abort();
  const generation = new AbortController();
  app.generation = generation;
  const owner = auth.user?.uid ?? null;
  setMode('sending');
  const request = buildRequest(app.site);
  app.site.lastRequestId = request.id;
  const generationSite = structuredClone(app.site);
  // The lot lights up while the design is made; the building grows out of it when it arrives.
  house.hide();
  house.generating(app.site.ring);
  const form = app.site.form ?? {};
  const fit = form.housingType ? landFit(form.housingType, form.answers ?? {}, form.advanced ?? {}, measure(app.site.ring)) : null;
  openPanel((el) => renderSending(el, {
    request,
    fit,
    run: (onProgress) => api.createDesign(request, { site: generationSite, projectId: generationSite.projectId, onProgress, signal: generation.signal }),
    onDone: async ({ design, estimate, building }) => {
      if (generation.signal.aborted || auth.user?.uid !== owner) return;
      if (!drawable(design, { fresh: true })) return;
      const document = storage.adopt(building);
      api.keepLocal(design, estimate);
      house.stopGenerating();
      showDesign(design, estimate, { ...document, savedBuilding: { id: building.id, uid: owner, designID: design.id } });
      rememberScene();
      toast('Design saved to your account.');
    },
    onFailed: (err) => {
      if (generation.signal.aborted) return;
      app.site.status = 'not-sent';
      app.site.lastError = err.code ?? 'error';
      saveSite();
      house.failGenerating();
      setMode('failed');
    },
    onRetry: () => send(),
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
  house.show(design, placement, { id: savedBuilding?.id ?? null, animate, selected });
  if (camera) {
    map.jumpTo({ ...camera, padding: panelPadding() });
    app.tilted = camera.pitch > 0;
  } else if (focus) frameHouse(placement);
  if (details) {
    if (focus && !camera) setTimeout(() => { if (version === app.displayVersion) openHouse(); }, 1900);
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
  if (design?.schema !== 'terrasim.design/2') {
    toast(`“${file.name}” isn’t a TerraSim design (it needs "schema": "terrasim.design/2").`, { kind: 'error', action: another });
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
  house.show({ ...design, previewOn: app.site.id }, placement);
  app.site.preview = true;
  saveSite();
  setMode('house');
  closePanel();
  if (!placement.fits) toast('The sample house is bigger than this lot, so it hangs over the outline.');
  else toast('Sample house placed on your lot. Click it, then choose Move to move or turn it.');
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


async function openWalk(design) {
  const version = app.displayVersion;
  const { openWalkthrough } = await import('./walk/walk.js');
  if (version !== app.displayVersion) return;
  // The shown building's live placement, so the view outside matches where it stands now.
  openWalkthrough($('#walk'), design, { map, placement: house.design === design ? house.placement : design.placement });
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
function openSites() { return library.open(); }
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


const storage = createBuildingStorage({ app, auth, buildings, house, rememberScene, buildingName });
const library = createLibraryController({ app, auth, buildings, projects, storage, house, map, outliner, panel, store, scopeKey, account, leaveGlobe, closePanel, openPanel, openBrief, openDesignFile, openSceneBuilding, clearLands, setMode, rememberScene, toast });
const generationObserver = createGenerationObserver({ api, auth, onSaved(record) {
  const document = storage.adopt(record);
  house.add(record.id, document.design, document.placement);
  clearLands();
  toast('Your design is ready and saved.', { action: { label: 'Open building', run: () => openSceneBuilding(record.id) } });
}, onFailed() { toast('A design could not finish. Open its site draft to try again.', { kind: 'error' }); } });
const scene = createSceneController({ app, auth, store, map, house, buildings, showDesign, clearLands,
  globePadding, stopSpin, intro, setMode, toast, openSites, location });
function persistBuilding(...args) { return storage.persist(...args); }
function rememberScene() { return scene.remember(); }
function openSceneBuilding(...args) { return scene.open(...args); }
function restoreScene(uid) { return scene.restore(uid); }
createAccountSession({ auth, store, app, restoreScene, panel, openSites, generationObserver, resetView() {
    mover.cancel(); map.dragPan.enable(); map.stop();
    ++app.displayVersion; ++app.sceneVersion;
    $('#walk [data-exit]')?.click();
    house.clear(); outliner.clear(); closePanel();
    app.site = null; app.estimates.clear(); app.savedBuilding = null; app.currentDesignID = null; app.names.clear();
    app.records.clear(); app.removedRecords.clear(); storage.reset(); app.sceneReady = false;
    intro.hidden = false; intro.classList.remove('is-leaving');
    setMode('globe');
    map.jumpTo({ center: [-40, 28], zoom: 1.9, pitch: 0, bearing: 0, padding: globePadding() });
} });
map.on('movestart', (event) => { if (event.originalEvent) ++app.navigationVersion; });
map.on('moveend', rememberScene);
addEventListener('pagehide', rememberScene);
// A shared building opens once everything above is ready (share links keep priority over the saved scene).
if (location.hash.startsWith('#b=')) openSharedBuilding(location.hash);
