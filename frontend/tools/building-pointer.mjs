// Find a point on the visible upper building whose ground projection lies outside
// its footprint. This reproduces clicking a roof in a pitched view, rather than
// the ground-level footprint center used by earlier drag tests.
export async function roofDragPoints(page, distance = 0.00001) {
  await page.evaluate(() => {
    const { house, map } = window.__terrasim;
    if (!house.layer.__dragTestWrapped) {
      const render = house.layer.render;
      house.layer.render = function (...args) {
        const data = args[1] ?? args[0];
        const matrix = data.defaultProjectionData?.mainMatrix ?? data.modelViewProjectionMatrix;
        if (matrix) window.__buildingDragProjection = Array.from(matrix);
        return render.apply(this, args);
      };
      house.layer.__dragTestWrapped = true;
    }
    map.triggerRepaint();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForFunction(() => window.__buildingDragProjection);
  return page.evaluate(async (distance) => {
    const THREE = await import('three');
    const { maplibregl } = await import('/js/map/map.js');
    const { buildHouseModel } = await import('/js/map/house-layer.js');
    const { footprintOutside, pointInPolygon } = await import('/js/lib/design.js');
    const { house, map, app } = window.__terrasim;
    const p = house.placement, design = house.design;
    const mc = maplibregl.MercatorCoordinate.fromLngLat(p.origin, 0);
    const scale = mc.meterInMercatorCoordinateUnits(), b = p.xAxisBearingDeg * Math.PI / 180;
    const placement = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(Math.sin(b) * scale, -Math.cos(b) * scale, 0),
      new THREE.Vector3(-Math.cos(b) * scale, -Math.sin(b) * scale, 0),
      new THREE.Vector3(0, 0, scale));
    placement.setPosition(mc.x, mc.y, mc.z);
    const projection = new THREE.Matrix4().fromArray(window.__buildingDragProjection).multiply(placement);
    const model = buildHouseModel(design);
    model.updateMatrixWorld(true);
    const height = new THREE.Box3().setFromObject(model).max.z;
    const rect = map.getCanvas().getBoundingClientRect();
    const candidates = [];
    model.traverse((object) => {
      if (!object.isMesh) return;
      const pos = object.geometry.attributes.position, index = object.geometry.index;
      const count = index ? index.count : pos.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const center = new THREE.Vector3();
        for (let j = 0; j < 3; j++) center.add(new THREE.Vector3().fromBufferAttribute(pos, index ? index.getX(i + j) : i + j));
        center.divideScalar(3).applyMatrix4(object.matrixWorld);
        if (center.z < height * 0.7) continue;
        const ndc = center.applyMatrix4(projection);
        const x = (ndc.x + 1) / 2 * rect.width, y = (1 - ndc.y) / 2 * rect.height;
        if (x < 20 || y < 100 || x > rect.width - 20 || y > rect.height - 100) continue;
        if (document.elementFromPoint(x + rect.left, y + rect.top) !== map.getCanvas()) continue;
        const ground = map.unproject([x, y]);
        if (pointInPolygon(ground.lng, ground.lat, p.footprint)) continue;
        candidates.push({ x, y, ground });
      }
    });
    if (!candidates.length) throw new Error('No visible roof point outside the ground footprint; use a close pitched camera');
    const { x, y, ground } = candidates[0];
    const land = design.previewOn ? app.site.ring : design.site.outline;
    const delta = [[distance, 0], [-distance, 0], [0, distance], [0, -distance]].find(([dx, dy]) =>
      !footprintOutside(p.footprint.map(([lng, lat]) => [lng + dx, lat + dy]), land));
    if (!delta) throw new Error('Fixture land has no room for a roof drag');
    const to = map.project([ground.lng + delta[0], ground.lat + delta[1]]);
    return { from: [x + rect.left, y + rect.top], to: [to.x + rect.left, to.y + rect.top] };
  }, distance);
}
