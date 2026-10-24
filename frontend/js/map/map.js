// The map: a globe that flies down to street level, satellite imagery by default, OpenStreetMap
// roads, labels and 3D buildings on top (OpenFreeMap, no key).

import * as maplibregl from 'maplibre-gl';
import { config } from '../config.js';

maplibregl.setWorkerUrl(new URL('../../vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);

const SATELLITE_HIDDEN_TYPES = new Set(['fill', 'background']);

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

  // Satellite imagery under everything; the vector style's fills are hidden in satellite mode.
  style.sources.satellite = {
    type: 'raster',
    tiles: [config.map.satellite.url],
    tileSize: 256,
    maxzoom: 18,
    attribution: config.map.satellite.attribution,
  };
  const firstIndex = Math.max(0, style.layers.findIndex((l) => l.type !== 'background'));
  style.layers.splice(firstIndex, 0, { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 200 } });
  style.projection = { type: 'globe' };
  style.sky = {
    'sky-color': '#0b1a30',
    'horizon-color': '#29466e',
    'fog-color': '#0a1424',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.4,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 9, 0],
  };

  const map = new maplibregl.Map({
    container,
    style,
    center: [-40, 28],
    zoom: 1.6,
    pitch: 0,
    maxPitch: 75,
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
  });
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();

  await new Promise((ok) => map.once('load', ok));
  // Lift the globe above the intro text.
  map.setPadding({ top: 0, bottom: Math.round(innerHeight * 0.34), left: 0, right: 0 });
  styleBuildings(map);
  setBasemap(map, 'satellite');

  // A slow spin while the globe waits for the visitor.
  let spinning = true;
  const spin = () => {
    if (!spinning || map.getZoom() > 3) return;
    const c = map.getCenter();
    map.easeTo({ center: [c.lng + 12, c.lat], duration: 4000, easing: (t) => t });
  };
  map.on('moveend', () => { if (spinning) spin(); });
  spin();
  const stopSpin = () => { spinning = false; map.stop(); };
  for (const ev of ['mousedown', 'touchstart', 'wheel']) map.getCanvas().addEventListener(ev, stopSpin, { once: true, passive: true });

  return { map, stopSpin };
}

// OpenFreeMap's buildings, extruded and tinted to sit on imagery.
function styleBuildings(map) {
  const layers = map.getStyle().layers;
  const b3d = layers.find((l) => l.type === 'fill-extrusion');
  if (b3d) {
    map.setPaintProperty(b3d.id, 'fill-extrusion-color', '#d9dee6');
    map.setPaintProperty(b3d.id, 'fill-extrusion-opacity', 0.82);
  }
}

export function setBasemap(map, mode) {
  const style = map.getStyle();
  for (const l of style.layers) {
    if (l.id === 'satellite') {
      map.setLayoutProperty(l.id, 'visibility', mode === 'satellite' ? 'visible' : 'none');
      continue;
    }
    if (SATELLITE_HIDDEN_TYPES.has(l.type) && !/building/.test(l.id)) {
      map.setLayoutProperty(l.id, 'visibility', mode === 'satellite' ? 'none' : 'visible');
    }
  }
  const b3d = style.layers.find((l) => l.type === 'fill-extrusion');
  if (b3d) map.setPaintProperty(b3d.id, 'fill-extrusion-opacity', mode === 'satellite' ? 0.6 : 0.85);
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
