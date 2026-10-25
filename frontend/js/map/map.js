// The map: a globe that flies down to street level, satellite imagery by default, OpenStreetMap
// roads, labels and 3D buildings on top (OpenFreeMap, no key).

import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { config } from '../config.js';

maplibregl.setWorkerUrl(new URL('../../vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);
// Overture's buildings come as one PMTiles archive read in ranges (pmtiles://).
maplibregl.addProtocol('pmtiles', new Protocol().tile);

// Satellite tiles go through this loader. Where Esri has no imagery it serves a grey "Map data
// not yet available" tile; those are dropped so the street map underneath shows instead.
const EMPTY_TILE = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0)).buffer;
let probe = null;
function isPlaceholder(bitmap) {
  probe ??= new OffscreenCanvas(8, 8).getContext('2d', { willReadFrequently: true });
  probe.clearRect(0, 0, 8, 8);
  probe.drawImage(bitmap, 0, 0, 8, 8);
  const px = probe.getImageData(0, 0, 8, 8).data;
  // Placeholders are flat mid grey (about 204) at every corner.
  for (const i of [0, 7, 56, 63]) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (Math.abs(r - g) > 4 || Math.abs(g - b) > 4 || r < 190 || r > 215) return false;
  }
  return true;
}
maplibregl.addProtocol('sat', async (params, abort) => {
  const url = config.map.satellite.url.replace('{z}/{y}/{x}', params.url.replace('sat://', ''));
  const res = await fetch(url, { signal: abort.signal });
  if (!res.ok) return { data: EMPTY_TILE };
  const buf = await res.arrayBuffer();
  try {
    const bmp = await createImageBitmap(new Blob([buf]));
    const empty = isPlaceholder(bmp);
    bmp.close?.();
    if (empty) {
      // Tell the page, so it can say the imagery is missing rather than leave the visitor guessing.
      const z = Number(params.url.replace('sat://', '').split('/')[0]);
      dispatchEvent(new CustomEvent('terrasim:no-imagery', { detail: { z } }));
      return { data: EMPTY_TILE };
    }
  } catch {}
  return { data: buf };
});

export async function createMap(container) {
  let style;
  try {
    style = await fetch(config.map.style).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  } catch {
    style = fallbackStyle();
  }

  // Satellite imagery sits above the street map's land and water fills and below roads, labels and
  // buildings, so wherever there is no imagery the street map shows through.
  style.sources.satellite = {
    type: 'raster',
    tiles: ['sat://{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 18,
    attribution: config.map.satellite.attribution,
  };
  // Every land and water fill goes under the imagery; lines, labels and buildings stay on top.
  const under = style.layers.filter((l) => l.type === 'background' || (l.type === 'fill' && !/building/.test(l.id)));
  const over = style.layers.filter((l) => !under.includes(l));
  // Relief: a light hillshade from the same elevation tiles the land survey reads, so slopes show
  // at a glance from neighbourhood zoom down.
  style.sources.dem = { type: 'raster-dem', tiles: [`${config.map.terrain}/{z}/{x}/{y}.png`], tileSize: 256, encoding: 'terrarium', maxzoom: 15 };
  const hillshade = { id: 'hillshade', type: 'hillshade', source: 'dem', minzoom: 10,
    paint: { 'hillshade-exaggeration': 0.32, 'hillshade-shadow-color': '#0a1019', 'hillshade-highlight-color': '#fff7ea', 'hillshade-accent-color': '#2a2018' } };
  style.layers = [...under, { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 200 } }, hillshade, ...over];
  style.projection = { type: 'globe' };
  style.sky = {
    'sky-color': '#0b1a30',
    'horizon-color': '#1d3a63',
    'fog-color': '#0a1424',
    'sky-horizon-blend': 0.5,
    'horizon-fog-blend': 0.5,
    'fog-ground-blend': 0.6,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 5, 0.45, 9, 0],
  };

  const map = new maplibregl.Map({
    container,
    style,
    center: [-40, 28],
    zoom: 1.9,
    pitch: 0,
    maxPitch: 75,
    minZoom: 1.25,
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
  });
  // Left-drag moves the map; Ctrl + drag turns and tilts it. (MapLibre also turns on a right-drag;
  // that's switched off, so the right button does nothing on the map.)
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();
  const canvasBox = map.getCanvasContainer();
  canvasBox.addEventListener('mousedown', (e) => { if (e.button === 2) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  canvasBox.addEventListener('contextmenu', (e) => e.preventDefault());

  await new Promise((ok) => map.once('load', ok));
  // Start with the attribution folded into its (i) button.
  container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  // Lift the globe above the intro text.
  map.setPadding({ top: 0, bottom: Math.round(innerHeight * 0.26), left: 0, right: 0 });
  styleBuildings(map);
  // Points of interest (shop and parking icons) crowd the view of a site; street names stay.
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && /poi|transit|airport|aeroway/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
  }
  setBasemap(map, 'satellite');
  styleBoundariesAndLabels(map);

  // A slow spin while the globe waits for the visitor; any touch of the map stops it.
  let spinning = false;
  const spin = () => {
    if (!spinning || map.getZoom() > 3) return;
    const c = map.getCenter();
    map.easeTo({ center: [c.lng + 12, c.lat], duration: 4000, easing: (t) => t });
  };
  // The next turn starts on the following frame: starting an ease inside moveend lets MapLibre
  // clear the new ease's state as it finishes the old one.
  map.on('moveend', () => { if (spinning) requestAnimationFrame(spin); });
  const stopSpin = () => { if (spinning) { spinning = false; map.stop(); } };
  const startSpin = () => {
    if (spinning || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    spinning = true;
    for (const ev of ['mousedown', 'touchstart', 'wheel']) map.getCanvas().addEventListener(ev, stopSpin, { once: true, passive: true });
    spin();
  };
  startSpin();

  return { map, stopSpin, startSpin };
}

// Buildings as solid volumes: opaque, light stone that cools a little with height, with MapLibre's
// vertical shading so walls and roofs read apart.
//
// They come from Overture Maps, for as many buildings as possible: every OpenStreetMap building
// (OpenFreeMap's tiles drop most small ones at street zoom) plus Google, Microsoft and Esri
// machine-mapped footprints where OpenStreetMap has none, so thinly mapped cities still stand in 3D.
// Heights: the recorded height, else floors × 3.2 m, else one to two storeys (5 m). A building
// with detailed parts (a tower on a podium) is drawn by its parts, which carry the heights.
// OpenFreeMap's buildings stay as the fallback if Overture can't be reached.
const STOREY_M = 3.2;
const OVERTURE_HEIGHT = ['case', ['has', 'height'], ['get', 'height'], ['has', 'num_floors'], ['*', ['get', 'num_floors'], STOREY_M], 5];
const OVERTURE_BASE = ['case', ['has', 'min_height'], ['get', 'min_height'], ['has', 'min_floor'], ['*', ['get', 'min_floor'], STOREY_M], 0];
const OSM_HEIGHT = ['coalesce', ['get', 'render_height'], 6];
const colour = (h, stops) => ['interpolate', ['linear'], h, ...stops];
const DAY = [0, '#e7e1d6', 12, '#dcd8d0', 40, '#cfd3d8', 120, '#b9c0c9'];
const NIGHT = [0, '#4d5360', 40, '#434a57', 120, '#3a4150'];
export const BUILDING_LAYERS = ['buildings-world', 'buildings-world-parts'];

function styleBuildings(map) {
  const b3d = map.getStyle().layers.find((l) => l.type === 'fill-extrusion');
  map.setLight({ anchor: 'map', position: [1.4, 210, 35], intensity: 0.45, color: '#ffffff' });
  if (b3d) {
    map.setPaintProperty(b3d.id, 'fill-extrusion-color', colour(OSM_HEIGHT, DAY));
    map.setPaintProperty(b3d.id, 'fill-extrusion-opacity', 1);
    map.setPaintProperty(b3d.id, 'fill-extrusion-vertical-gradient', true);
    map.setPaintProperty(b3d.id, 'fill-extrusion-height', OSM_HEIGHT);
    map.setPaintProperty(b3d.id, 'fill-extrusion-base', ['coalesce', ['get', 'render_min_height'], 0]);
  }
  if (!config.map.buildings?.url) return;
  map.addSource('overture-buildings', { type: 'vector', url: `pmtiles://${config.map.buildings.url}`, attribution: config.map.buildings.attribution });
  const paint = {
    'fill-extrusion-color': colour(OVERTURE_HEIGHT, DAY), 'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': true,
    'fill-extrusion-height': OVERTURE_HEIGHT, 'fill-extrusion-base': OVERTURE_BASE,
  };
  const above = ['!=', ['get', 'is_underground'], true];
  map.addLayer({ id: 'buildings-world', type: 'fill-extrusion', source: 'overture-buildings', 'source-layer': 'building', minzoom: 14,
    filter: ['all', above, ['!=', ['get', 'has_parts'], true]], paint }, b3d?.id);
  map.addLayer({ id: 'buildings-world-parts', type: 'fill-extrusion', source: 'overture-buildings', 'source-layer': 'building_part', minzoom: 14,
    filter: above, paint }, b3d?.id);
  if (b3d) map.setLayoutProperty(b3d.id, 'visibility', 'none');
  // If Overture can't be reached, OpenFreeMap's buildings come back.
  map.on('error', (e) => {
    if (e.sourceId !== 'overture-buildings' || !b3d || map.getLayoutProperty(b3d.id, 'visibility') === 'visible') return;
    console.warn('[TerraSim] Overture buildings unavailable; showing OpenStreetMap buildings.', e.error);
    for (const id of BUILDING_LAYERS) map.setLayoutProperty(id, 'visibility', 'none');
    map.setLayoutProperty(b3d.id, 'visibility', 'visible');
  });
}

// Land being designed for is cleared: map buildings whose middle stands inside any of these rings
// ([lng, lat]) are hidden, since the design takes their place. MapLibre can't filter polygons by
// area, so the buildings are found in the loaded tiles and hidden by id, again as more tiles load.
const baseFilters = new Map();
const cleared = { rings: [], timer: 0, watching: false };
export function clearLand(map, rings) {
  cleared.rings = rings.filter((r) => r?.length >= 3);
  applyClearing(map);
  if (!cleared.watching) {
    cleared.watching = true;
    map.on('sourcedata', (e) => {
      if (!cleared.rings.length || !e.isSourceLoaded || e.sourceDataType === 'metadata') return;
      clearTimeout(cleared.timer);
      cleared.timer = setTimeout(() => applyClearing(map), 250);
    });
  }
}
function applyClearing(map) {
  const inLand = (ring) => {
    let x = 0, y = 0;
    for (const [px, py] of ring) { x += px; y += py; }
    const c = [x / ring.length, y / ring.length];
    return cleared.rings.some((r) => insideRing(c, r));
  };
  for (const l of map.getStyle().layers.filter((x) => x.type === 'fill-extrusion')) {
    if (!baseFilters.has(l.id)) baseFilters.set(l.id, map.getFilter(l.id) ?? null);
    const base = baseFilters.get(l.id);
    const overture = BUILDING_LAYERS.includes(l.id);
    const ids = new Set();
    if (cleared.rings.length) {
      for (const f of map.querySourceFeatures(l.source, { sourceLayer: l['source-layer'] })) {
        const id = overture ? f.properties.id : f.id;
        if (id == null) continue;
        const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((p) => p[0]) : [];
        if (rings.some(inLand)) ids.add(id);
      }
    }
    const keep = ids.size ? ['!', ['in', overture ? ['get', 'id'] : ['id'], ['literal', [...ids]]]] : null;
    map.setFilter(l.id, keep && base ? ['all', base, keep] : keep ?? base);
  }
}
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The 3D building layers currently drawn (Overture's, or the fallback).
export function buildingLayers(map) {
  return map.getStyle().layers.filter((l) => l.type === 'fill-extrusion' && map.getLayoutProperty(l.id, 'visibility') !== 'none').map((l) => l.id);
}

export function setBasemap(map, mode) {
  const style = map.getStyle();
  for (const l of style.layers) {
    if (l.id === 'satellite') {
      map.setLayoutProperty(l.id, 'visibility', mode === 'satellite' ? 'visible' : 'none');
      continue;
    }
    // The background is hidden over satellite so space shows round the globe.
    if (l.type === 'background') map.setLayoutProperty(l.id, 'visibility', mode === 'satellite' ? 'none' : 'visible');
  }
}

// Evening: the land dims so lit windows read; buildings darken with it.
export function setEvening(map, on) {
  if (map.getLayer('satellite')) {
    map.setPaintProperty('satellite', 'raster-brightness-max', on ? 0.42 : 1);
    map.setPaintProperty('satellite', 'raster-saturation', on ? -0.35 : 0);
  }
  for (const l of map.getStyle().layers.filter((x) => x.type === 'fill-extrusion')) {
    map.setPaintProperty(l.id, 'fill-extrusion-color', colour(BUILDING_LAYERS.includes(l.id) ? OVERTURE_HEIGHT : OSM_HEIGHT, on ? NIGHT : DAY));
  }
  const bg = map.getStyle().layers.find((l) => l.type === 'background');
  if (bg) map.setPaintProperty(bg.id, 'background-color', on ? '#1c2330' : '#f8f4f0');
}

// The visitor's location: a pulsing marker that is also a button. Hovering it says what a click
// does; clicking it flies there.
export function locationMarker(map, lngLat, { onClick } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'you';
  el.innerHTML = '<span class="you-pulse"></span><span class="you-dot"></span><span class="you-label">Fly to your location</span>';
  el.setAttribute('aria-label', 'Fly to your location');
  el.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(); });
  return new maplibregl.Marker({ element: el, opacityWhenCovered: '0' }).setLngLat(lngLat).addTo(map);
}

// Country, state and province borders and place names that read over satellite imagery, from the
// globe down to street level. Counties and districts appear once zoomed in.
function styleBoundariesAndLabels(map) {
  const layers = map.getStyle().layers;
  const has = (id) => layers.some((l) => l.id === id);
  if (has('boundary_2')) {
    map.setPaintProperty('boundary_2', 'line-color', 'rgba(255, 255, 255, 0.78)');
    map.setPaintProperty('boundary_2', 'line-width', ['interpolate', ['linear'], ['zoom'], 1, 0.7, 5, 1.4, 10, 2]);
  }
  const b3 = layers.find((l) => l.id === 'boundary_3');
  if (b3) {
    // Replaces the admin-level range in the style's filter: states and provinces are levels 3–4,
    // counties and districts 5–6.
    const withLevels = (lo, hi) => JSON.parse(JSON.stringify(b3.filter)
      .replace('[">=",["get","admin_level"],3]', `[">=",["get","admin_level"],${lo}]`)
      .replace('["<=",["get","admin_level"],6]', `["<=",["get","admin_level"],${hi}]`));
    map.setFilter('boundary_3', withLevels(3, 4));
    map.setLayerZoomRange('boundary_3', 2, 24);
    map.setPaintProperty('boundary_3', 'line-color', 'rgba(255, 255, 255, 0.55)');
    map.setPaintProperty('boundary_3', 'line-width', ['interpolate', ['linear'], ['zoom'], 2, 0.6, 6, 1.1, 12, 1.6]);
    map.setPaintProperty('boundary_3', 'line-dasharray', [3, 2]);
    map.addLayer({
      id: 'boundary_local', type: 'line', source: b3.source, 'source-layer': b3['source-layer'], minzoom: 8,
      filter: withLevels(5, 6), layout: b3.layout ?? {},
      paint: { 'line-color': 'rgba(255, 255, 255, 0.32)', 'line-width': 0.8, 'line-dasharray': [2, 2] },
    }, 'boundary_3');
  }
  // Place names: light text with a dark halo over imagery.
  for (const l of layers) {
    if (l.type !== 'symbol' || l['source-layer'] !== 'place') continue;
    map.setPaintProperty(l.id, 'text-color', l.id === 'label_state' ? 'rgba(255, 255, 255, 0.82)' : '#f5f2ec');
    map.setPaintProperty(l.id, 'text-halo-color', 'rgba(8, 12, 18, 0.85)');
    map.setPaintProperty(l.id, 'text-halo-width', 1.4);
  }
  if (has('label_state')) {
    map.setLayerZoomRange('label_state', 3, 9);
    map.setLayoutProperty('label_state', 'text-transform', 'uppercase');
    map.setLayoutProperty('label_state', 'text-letter-spacing', 0.14);
    map.setLayoutProperty('label_state', 'text-size', ['interpolate', ['linear'], ['zoom'], 3, 9, 7, 13]);
  }
}

export function flyToGround(map, lngLat, { zoom = 17.6, pitch = 58, bearing = -20, duration = 7000 } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return new Promise((ok) => {
    map.once('moveend', () => ok());
    const padding = { top: 0, bottom: 0, left: 0, right: 0 };
    if (reduced) map.jumpTo({ center: lngLat, zoom, pitch, bearing, padding });
    else map.flyTo({ center: lngLat, zoom, pitch, bearing, duration, curve: 1.5, essential: true, padding });
  });
}

export function getLocation({ timeout = 8000 } = {}) {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(
      (p) => ok([p.coords.longitude, p.coords.latitude]),
      () => ok(null),
      { enableHighAccuracy: false, timeout, maximumAge: 600000 },
    );
  });
}

function fallbackStyle() {
  // Used when the vector style can't load: imagery only.
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0a1220' } }], glyphs: undefined };
}

export { maplibregl };

// Streets near a piece of land ([lng, lat] ring), read from the map's own loaded tiles: up to eight
// [lng, lat] lines within about 150 m of the land's middle. The design service turns the building's
// front toward the nearest, without a slow street lookup of its own. [] when none are loaded.
const STREET_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'residential', 'unclassified', 'living_street']);
export function nearbyStreets(map, ring, radiusM = 150) {
  if (!ring?.length) return [];
  const c = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  const kx = 111320 * Math.cos((c[1] * Math.PI) / 180), ky = 110540;
  const local = ([lng, lat]) => [(lng - c[0]) * kx, (lat - c[1]) * ky];
  const segDist = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2)) : 0;
    return Math.hypot(a[0] + t * dx, a[1] + t * dy);
  };
  const found = [];
  for (const id of Object.keys(map.getStyle()?.sources ?? {})) {
    let feats = [];
    try { feats = map.querySourceFeatures(id, { sourceLayer: 'transportation' }); } catch { continue; }
    for (const f of feats) {
      if (!STREET_CLASSES.has(f.properties?.class)) continue;
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) {
        let d = Infinity;
        for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, segDist(local(line[i]), local(line[i + 1])));
        if (d < radiusM) found.push({ d, line: line.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)]) });
      }
    }
  }
  return found.sort((a, b) => a.d - b.d).slice(0, 8).map((x) => x.line);
}
