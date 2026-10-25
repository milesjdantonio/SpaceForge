// The lie of the land on the map: contour lines over the outlined land and a little round it, with
// heights labelled, so the slope can be seen before anything is designed. lib/terrain.js measures
// it; this draws it.

import { surveyLand } from '../lib/terrain.js';
import { fmt } from '../format.js';
import { settings } from '../store.js';

const SRC = 'topo';
const empty = () => ({ type: 'FeatureCollection', features: [] });

export function createTopo(map) {
  map.addSource(SRC, { type: 'geojson', data: empty() });
  const before = map.getLayer('outline-fill') ? 'outline-fill' : undefined;
  map.addLayer({ id: 'topo-line', type: 'line', source: SRC, filter: ['!', ['get', 'index']],
    paint: { 'line-color': '#fff3dc', 'line-opacity': 0.55, 'line-width': 1 } }, before);
  map.addLayer({ id: 'topo-index', type: 'line', source: SRC, filter: ['get', 'index'],
    paint: { 'line-color': '#fff3dc', 'line-opacity': 0.85, 'line-width': 1.8 } }, before);
  const glyphs = !!map.getStyle().glyphs;
  if (glyphs) {
    map.addLayer({ id: 'topo-label', type: 'symbol', source: SRC, filter: ['get', 'index'],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Noto Sans Regular'], 'symbol-spacing': 220, 'text-keep-upright': true },
      paint: { 'text-color': '#fff3dc', 'text-halo-color': 'rgba(10, 16, 25, 0.85)', 'text-halo-width': 1.4 } });
  }

  let version = 0, abort = null, last = null;
  async function show(ring) {
    const v = ++version;
    abort?.abort();
    abort = new AbortController();
    let survey = null;
    try { survey = await surveyLand(ring, { signal: abort.signal, imperial: settings.units !== 'metric' }); } catch (e) { if (e.name === 'AbortError') return null; }
    if (v !== version) return null;
    last = survey;
    draw();
    return survey;
  }
  // Labels in the visitor's units; every fifth line is heavier and carries one.
  function draw() {
    if (!last) { map.getSource(SRC)?.setData(empty()); return; }
    const every = last.interval * 5;
    const features = last.contours.map((c) => {
      const index = Math.abs(c.level / every - Math.round(c.level / every)) < 1e-6 || last.contours.length < 8;
      return { type: 'Feature', properties: { index, label: fmt.len(c.level, { precise: false }) }, geometry: { type: 'LineString', coordinates: c.coords } };
    });
    map.getSource(SRC)?.setData({ type: 'FeatureCollection', features });
  }
  function hide() { ++version; abort?.abort(); last = null; draw(); }
  return { show, hide, redraw: draw, get survey() { return last; } };
}
