// Outlining land on the map. Click to add corners; click the first corner, double-click or press
// Enter to finish; drag corners to adjust; Backspace removes the last corner; Escape cancels.
// The first corner pulses once it can close the outline. A corner that would make two edges cross
// isn't added: the line turns red and onChange reports `problem`, so the hint can say why.

const SRC = 'outline';
const AMBER = '#ffb15c', RED = '#ff8f8f';

// Do segments ab and cd cross at a point inside both? (lng/lat treated as flat: fine for a lot.)
function cross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
// Would a new edge a to b cross an edge of the open path pts (skipping the ones it touches)?
function crossesPath(a, b, pts, { skipFirst = false } = {}) {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (i === pts.length - 2) continue;   // the edge ending where the new one starts
    if (skipFirst && i === 0) continue;   // the closing edge touches the first corner
    if (cross(a, b, pts[i], pts[i + 1])) return true;
  }
  return false;
}
// Does a closed ring cross itself?
export function ringCrosses(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
  }
  return false;
}

export function createOutliner(map, { onChange, onFinish, onCancel } = {}) {
  let pts = [];
  let closed = false;
  let cursor = null;
  let dragging = -1;
  let active = false;
  let locked = false; // while a design is generating for this land, its corners stay put
  let problem = null;  // 'cross' or 'close' after a refused click; cleared when the pointer moves on
  let warning = false; // a building being moved is past the boundary (setWarning)

  map.addSource(SRC, { type: 'geojson', data: empty() });
  map.addLayer({ id: 'outline-fill', type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': '#ffb15c', 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'outline-line', type: 'line', source: SRC, filter: ['in', ['get', 'kind'], ['literal', ['area', 'edge']]], paint: { 'line-color': ['case', ['get', 'bad'], RED, AMBER], 'line-width': 3 } });
  map.addLayer({ id: 'outline-rubber', type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'rubber'], paint: { 'line-color': ['case', ['get', 'bad'], RED, AMBER], 'line-width': 2, 'line-dasharray': [2, 2] } });
  // A ring that pulses round the first corner once clicking it would close the outline.
  map.addLayer({ id: 'outline-first-pulse', type: 'circle', source: SRC, filter: ['all', ['==', ['get', 'kind'], 'corner'], ['get', 'first']], paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': AMBER, 'circle-stroke-width': 2, 'circle-stroke-opacity': 0 } });
  map.addLayer({ id: 'outline-corner', type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'corner'], paint: { 'circle-radius': ['case', ['get', 'first'], 8, 6], 'circle-color': '#0d131c', 'circle-stroke-color': '#ffb15c', 'circle-stroke-width': 3 } });

  function empty() { return { type: 'FeatureCollection', features: [] }; }

  function redraw() {
    const fc = empty();
    const bad = closed && pts.length > 3 && ringCrosses(pts);
    if (pts.length >= 3 && closed) fc.features.push({ type: 'Feature', properties: { kind: 'area', bad: bad || warning }, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
    else if (pts.length >= 2) fc.features.push({ type: 'Feature', properties: { kind: 'edge', bad: false }, geometry: { type: 'LineString', coordinates: pts } });
    let rubberBad = false;
    if (!closed && cursor && pts.length) {
      rubberBad = pts.length >= 3 && crossesPath(pts[pts.length - 1], cursor, pts);
      const rubber = [pts[pts.length - 1], cursor];
      if (pts.length >= 2) rubber.push(pts[0]);
      fc.features.push({ type: 'Feature', properties: { kind: 'rubber', bad: rubberBad || !!problem }, geometry: { type: 'LineString', coordinates: rubber } });
    }
    pts.forEach((p, i) => fc.features.push({ type: 'Feature', properties: { kind: 'corner', index: i, first: i === 0 && !closed && pts.length >= 3 }, geometry: { type: 'Point', coordinates: p } }));
    map.getSource(SRC)?.setData(fc);
    pulse(active && !closed && pts.length >= 3);
    onChange?.({ ring: pts.slice(), closed, cursor, problem: problem ?? (rubberBad ? 'cross-ahead' : null), crossing: bad });
  }

  // The first corner's pulse: a ring that grows and fades, about once a second.
  let pulseRaf = 0;
  function pulse(on) {
    if (!on || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (pulseRaf) { cancelAnimationFrame(pulseRaf); pulseRaf = 0; map.setPaintProperty('outline-first-pulse', 'circle-stroke-opacity', 0); }
      return;
    }
    if (pulseRaf) return;
    const step = (t) => {
      const k = (t % 1100) / 1100;
      map.setPaintProperty('outline-first-pulse', 'circle-radius', 9 + k * 14);
      map.setPaintProperty('outline-first-pulse', 'circle-stroke-opacity', 0.9 * (1 - k));
      pulseRaf = requestAnimationFrame(step);
    };
    pulseRaf = requestAnimationFrame(step);
  }

  const cornerAt = (e) => {
    const hits = map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['outline-corner'] });
    return hits.length ? hits[0].properties.index : -1;
  };

  function onClick(e) {
    if (!active || closed) return;
    const hit = cornerAt(e);
    if (hit === 0 && pts.length >= 3) { finish(); return; }
    if (hit >= 0) return;
    const p = [e.lngLat.lng, e.lngLat.lat];
    // A corner whose edge would cross an earlier edge isn't added.
    if (pts.length >= 3 && crossesPath(pts[pts.length - 1], p, pts)) { problem = 'cross'; redraw(); return; }
    problem = null;
    pts.push(p);
    redraw();
  }
  function onDblClick(e) {
    if (!active || closed) return;
    e.preventDefault();
    if (pts.length >= 3) finish();
  }
  function onMove(e) {
    if (dragging >= 0) {
      pts[dragging] = [e.lngLat.lng, e.lngLat.lat];
      redraw();
      return;
    }
    if (!active) return;
    if (!closed) {
      cursor = [e.lngLat.lng, e.lngLat.lat];
      if (problem && !(pts.length >= 3 && crossesPath(pts[pts.length - 1], cursor, pts))) problem = null;
      redraw();
    }
    map.getCanvas().style.cursor = cornerAt(e) >= 0 && !locked ? 'grab' : closed ? '' : 'crosshair';
  }
  function onDown(e) {
    if (locked || (!active && !closed)) return;
    const hit = cornerAt(e);
    if (hit < 0 || (!closed && !(pts.length >= 3))) return;
    if (!closed && hit === 0) return; // a click on the first corner closes instead
    e.preventDefault();
    dragging = hit;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  }
  function onUp() {
    if (dragging < 0) return;
    dragging = -1;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    if (closed) onFinish?.(pts.slice(), { edited: true });
  }
  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { cancel(); }
    else if (e.key === 'Enter' && pts.length >= 3 && !closed) { finish(); }
    else if ((e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) && !closed && pts.length) {
      e.preventDefault();
      pts.pop();
      redraw();
    }
  }

  map.on('click', onClick);
  map.on('dblclick', onDblClick);
  map.on('mousemove', onMove);
  map.on('mousedown', onDown);
  map.on('mouseup', onUp);
  map.on('touchstart', (e) => onDown(e));
  map.on('touchmove', (e) => { if (dragging >= 0) onMove(e); });
  map.on('touchend', onUp);
  addEventListener('keydown', onKey);

  function start() {
    pts = [];
    closed = false;
    cursor = null;
    active = true;
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = 'crosshair';
    redraw();
  }
  function finish() {
    // Closing across an earlier edge would make a bow tie: say so instead.
    if (pts.length >= 4 && crossesPath(pts[pts.length - 1], pts[0], pts, { skipFirst: true })) { problem = 'close'; redraw(); return; }
    problem = null;
    closed = true;
    active = false;
    cursor = null;
    map.getCanvas().style.cursor = '';
    setTimeout(() => map.doubleClickZoom.enable(), 300);
    redraw();
    onFinish?.(pts.slice(), { edited: false });
  }
  function cancel() {
    active = false;
    map.getCanvas().style.cursor = '';
    map.doubleClickZoom.enable();
    pts = [];
    closed = false;
    redraw();
    onCancel?.();
  }
  function load(ring) {
    pts = ring.slice();
    closed = true;
    active = false;
    redraw();
  }
  function clear() { pts = []; closed = false; active = false; redraw(); }
  function undo() { if (!closed && pts.length) { pts.pop(); redraw(); } }
  // Red while a building being moved is past the boundary; amber again once it's back inside.
  function setWarning(on) {
    warning = !!on;
    map.setPaintProperty('outline-fill', 'fill-color', on ? RED : AMBER);
    map.setPaintProperty('outline-fill', 'fill-opacity', on ? 0.22 : 0.16);
    redraw();
  }
  function setLocked(v) {
    locked = !!v;
    if (locked && dragging >= 0) { dragging = -1; map.dragPan.enable(); }
    // Corners hide while locked, so nothing looks draggable.
    map.setLayoutProperty('outline-corner', 'visibility', locked ? 'none' : 'visible');
  }
  function setVisible(v) {
    for (const id of ['outline-fill', 'outline-line', 'outline-rubber', 'outline-corner']) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
  }

  return {
    start, finish, cancel, load, clear, undo, setVisible, setWarning, setLocked,
    get locked() { return locked; },
    get ring() { return pts.slice(); },
    get closed() { return closed; },
    get active() { return active; },
  };
}
