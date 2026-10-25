import test from 'node:test';
import assert from 'node:assert/strict';
import { landFit, fitMessage, briefFloorArea } from '../js/lib/fit.js';

const land = (areaM2, buildableM2) => ({ areaM2, buildableM2 });
const fmt = { area: (x) => `${Math.round(x)} m²`, land: (x) => `${Math.round(x)} m²`, len: (x) => `${x} m` };

test('floor area follows the housing type', () => {
  assert.equal(briefFloorArea('house', { areaM2: 200 }), 200);
  assert.equal(briefFloorArea('duplex', { areaM2: 100 }), 200);
  assert.equal(briefFloorArea('townhouse', { areaM2: 120, unitCount: 4 }), 480);
  assert.equal(briefFloorArea('apartment', { areaM2: 80, unitCount: 10 }), 1000);
  assert.equal(briefFloorArea('dorm', { residents: 100, roomType: 'single' }), 2000);
  assert.equal(briefFloorArea('townhouse', { areaM2: 120 }), null);
});

test('a house that fits, is tight, or is too big', () => {
  assert.equal(landFit('house', { areaM2: 200, floors: 2 }, {}, land(800, 500)).level, 'ok');
  assert.equal(landFit('house', { areaM2: 450, floors: 1 }, {}, land(800, 500)).level, 'tight');
  const over = landFit('house', { areaM2: 600, floors: 1 }, {}, land(800, 500));
  assert.equal(over.level, 'over');
  assert.equal(over.floorsNeeded, 2);
  assert.match(fitMessage(over, fmt).text, /Try 2 floors/);
});

test('garage and parking count against the buildable land', () => {
  assert.equal(landFit('house', { areaM2: 400, floors: 1 }, {}, land(800, 500)).level, 'ok');
  assert.equal(landFit('house', { areaM2: 400, floors: 1 }, { garage: 3 }, land(800, 500)).level, 'tight');
  assert.equal(landFit('apartment', { areaM2: 80, unitCount: 10, floors: 4 }, { parkingSpaces: 12 }, land(800, 500)).level, 'over');
});

test('no floors suggestion beyond what the type allows', () => {
  const over = landFit('house', { areaM2: 900, floors: 3 }, {}, land(400, 200));
  assert.equal(over.level, 'over');
  assert.equal(over.floorsNeeded, null);
  assert.match(fitMessage(over, fmt).text, /Try a smaller size/);
  const row = landFit('townhouse', { areaM2: 300, unitCount: 12, floors: 4 }, {}, land(1000, 600));
  assert.match(fitMessage(row, fmt).text, /smaller or fewer homes/);
});

test('a tiny building on a big piece of land', () => {
  assert.equal(landFit('tiny-home', { areaM2: 30, floors: 1 }, {}, land(40000, 38000)).level, 'small');
});

test('nothing to say until the boxes are filled, and special cases', () => {
  assert.equal(landFit('house', { areaM2: 200, floors: null }, {}, land(800, 500)), null);
  assert.equal(landFit(null, {}, {}, land(800, 500)), null);
  assert.equal(landFit('house', { areaM2: 200, floors: 1 }, {}, land(100, 0)).level, 'none');
  assert.equal(landFit('house', { areaByAI: true, floors: 1 }, {}, land(800, 500)).level, 'ai');
});
