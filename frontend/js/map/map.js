// The map: a globe that flies down to street level, satellite imagery by default, OpenStreetMap
// roads, labels and 3D buildings on top (OpenFreeMap, no key).

import * as maplibregl from 'maplibre-gl';
import { config } from '../config.js';

maplibregl.setWorkerUrl(new URL('../../vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);

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
    if (empty) return { data: EMPTY_TILE };
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
  style.layers = [...under, { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 200 } }, ...over];
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
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();

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

  // A slow spin while the globe waits for the visitor; any touch of the map stops it.
  let spinning = false;
  const spin = () => {
    if (!spinning || map.getZoom() > 3) return;
    const c = map.getCenter();
    map.easeTo({ center: [c.lng + 12, c.lat], duration: 4000, easing: (t) => t });
  };
  map.on('moveend', () => { if (spinning) spin(); });
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

// OpenFreeMap's buildings as solid volumes: opaque, light stone that cools a little with height,
// with MapLibre's vertical shading so walls and roofs read apart.
const BUILDING_DAY = ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#e7e1d6', 12, '#dcd8d0', 40, '#cfd3d8', 120, '#b9c0c9'];
const BUILDING_NIGHT = ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#4d5360', 40, '#434a57', 120, '#3a4150'];

function styleBuildings(map) {
  const b3d = map.getStyle().layers.find((l) => l.type === 'fill-extrusion');
  if (!b3d) return;
  map.setPaintProperty(b3d.id, 'fill-extrusion-color', BUILDING_DAY);
  map.setPaintProperty(b3d.id, 'fill-extrusion-opacity', 1);
  map.setPaintProperty(b3d.id, 'fill-extrusion-vertical-gradient', true);
  map.setPaintProperty(b3d.id, 'fill-extrusion-height', ['coalesce', ['get', 'render_height'], 6]);
  map.setPaintProperty(b3d.id, 'fill-extrusion-base', ['coalesce', ['get', 'render_min_height'], 0]);
  map.setLight({ anchor: 'map', position: [1.4, 210, 35], intensity: 0.45, color: '#ffffff' });
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
  const b3d = map.getStyle().layers.find((l) => l.type === 'fill-extrusion');
  if (b3d) map.setPaintProperty(b3d.id, 'fill-extrusion-color', on ? BUILDING_NIGHT : BUILDING_DAY);
  const bg = map.getStyle().layers.find((l) => l.type === 'background');
  if (bg) map.setPaintProperty(bg.id, 'background-color', on ? '#1c2330' : '#f8f4f0');
}

// The visitor's location as a pulsing marker.
export function locationMarker(map, lngLat) {
  const el = document.createElement('div');
  el.className = 'you';
  el.innerHTML = '<span class="you-pulse"></span><span class="you-dot"></span>';
  el.setAttribute('aria-label', 'Your location');
  return new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

// The globe is for the opening; at street level the map is flat mercator (they look the same
// there), which is what the 3D house layer is placed in.
export function setGlobe(map, on) {
  map.setProjection({ type: on ? 'globe' : 'mercator' });
}

export function flyToGround(map, lngLat, { zoom = 17.6, pitch = 58, bearing = -20, duration = 7000 } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return new Promise((ok) => {
    map.once('moveend', () => { setGlobe(map, false); ok(); });
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
