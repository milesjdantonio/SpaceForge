// Outlining land on the map. Click to add corners; click the first corner, double-click or press
// Enter to finish; drag corners to adjust; Backspace removes the last corner; Escape cancels.

const SRC = 'outline';

export function createOutliner(map, { onChange, onFinish, onCancel } = {}) {
  let pts = [];
  let closed = false;
  let cursor = null;
  let dragging = -1;
  let active = false;

  map.addSource(SRC, { type: 'geojson', data: empty() });
  map.addLayer({ id: 'outline-fill', type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': '#ffb15c', 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'outline-line', type: 'line', source: SRC, filter: ['in', ['get', 'kind'], ['literal', ['area', 'edge']]], paint: { 'line-color': '#ffb15c', 'line-width': 3 } });
  map.addLayer({ id: 'outline-rubber', type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'rubber'], paint: { 'line-color': '#ffb15c', 'line-width': 2, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'outline-corner', type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'corner'], paint: { 'circle-radius': ['case', ['get', 'first'], 8, 6], 'circle-color': '#0d131c', 'circle-stroke-color': '#ffb15c', 'circle-stroke-width': 3 } });

  function empty() { return { type: 'FeatureCollection', features: [] }; }

  function redraw() {
    const fc = empty();
    if (pts.length >= 3 && closed) fc.features.push({ type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
    else if (pts.length >= 2) fc.features.push({ type: 'Feature', properties: { kind: 'edge' }, geometry: { type: 'LineString', coordinates: pts } });
    if (!closed && cursor && pts.length) {
      const rubber = [pts[pts.length - 1], cursor];
      if (pts.length >= 2) rubber.push(pts[0]);
      fc.features.push({ type: 'Feature', properties: { kind: 'rubber' }, geometry: { type: 'LineString', coordinates: rubber } });
    }
    pts.forEach((p, i) => fc.features.push({ type: 'Feature', properties: { kind: 'corner', index: i, first: i === 0 && !closed && pts.length >= 3 }, geometry: { type: 'Point', coordinates: p } }));
    map.getSource(SRC)?.setData(fc);
    onChange?.({ ring: pts.slice(), closed, cursor });
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
    pts.push([e.lngLat.lng, e.lngLat.lat]);
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
    if (!closed) { cursor = [e.lngLat.lng, e.lngLat.lat]; redraw(); }
    map.getCanvas().style.cursor = cornerAt(e) >= 0 ? 'grab' : closed ? '' : 'crosshair';
  }
  function onDown(e) {
    if (!active && !closed) return;
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
    const color = on ? '#ff8f8f' : '#ffb15c';
    map.setPaintProperty('outline-line', 'line-color', color);
    map.setPaintProperty('outline-fill', 'fill-color', color);
    map.setPaintProperty('outline-fill', 'fill-opacity', on ? 0.22 : 0.16);
  }
  function setVisible(v) {
    for (const id of ['outline-fill', 'outline-line', 'outline-rubber', 'outline-corner']) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
  }

  return {
    start, finish, cancel, load, clear, undo, setVisible, setWarning,
    get ring() { return pts.slice(); },
    get closed() { return closed; },
    get active() { return active; },
  };
}
