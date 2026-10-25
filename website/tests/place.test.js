import test from 'node:test';
import assert from 'node:assert/strict';
import { transformPlacement, placementCenter } from '../js/lib/place.js';
import { projection } from '../js/lib/geo.js';

// A 10 x 6 m building whose x axis points east (bearing 90), origin at its south-west corner.
const proj = projection([-82.55, 35.59]);
const geo = (pts) => pts.map(proj.toGeo);
const placement = { origin: proj.toGeo([0, 0]), xAxisBearingDeg: 90, footprint: geo([[0, 0], [10, 0], [10, 6], [0, 6]]), extra: 'kept' };
const close = (a, b, eps = 0.01) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < eps, `${a} vs ${b}`);
const local = (p) => proj.toLocal(p);

test('moving keeps the shape and shifts every point', () => {
  const center = proj.toGeo([25, 13]);
  const moved = transformPlacement(placement, { center });
  close(local(placementCenter(moved)), [25, 13]);
  close(local(moved.origin), [20, 10]);
  assert.equal(moved.xAxisBearingDeg, 90);
  assert.equal(moved.extra, 'kept');
});

test('turning 90° clockwise points the x axis south and swings the corners round the middle', () => {
  const turned = transformPlacement(placement, { turnDeg: 90 });
  assert.equal(turned.xAxisBearingDeg, 180);
  close(local(placementCenter(turned)), [5, 3]);
  // The south-west corner (-5, -3 from the middle) turns clockwise to (-3, +5).
  close(local(turned.origin), [2, 8]);
});

test('any angle, and bearings wrap', () => {
  const t = transformPlacement(placement, { turnDeg: -97 });
  assert.equal(Math.round(t.xAxisBearingDeg), 353);
  const sides = (p) => p.footprint.map(local).map((a, i, all) => Math.hypot(...all[(i + 1) % 4].map((v, k) => v - a[k])));
  sides(t).forEach((s, i) => assert.ok(Math.abs(s - sides(placement)[i]) < 0.01));
});
