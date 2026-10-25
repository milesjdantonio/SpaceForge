// Browser regression for selecting, moving and turning a building in a pitched 3D view.
// Uses fixture JSON, no account, provider calls, or database writes.
//   Select: a click on the visible roof selects it; nothing moves.
//   Move:   the Move button beside it opens the grips; dragging the roof or the top grip moves the
//           building without panning the map; the ring grip turns it; a spot outside the land
//           can't be kept; Done keeps the spot.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from './serve.mjs';
import { withBrowser } from './browser.mjs';
import { roofDragPoints } from './building-pointer.mjs';

const fixture = { design: JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url))),
  estimate: JSON.parse(await readFile(new URL('../fixtures/mock-house/estimate.json', import.meta.url))) };
const server = await startServer(5199);
const center = (box) => [box.x + box.width / 2, box.y + box.height / 2];
try {
  await withBrowser(async (browser) => {
    const prepare = async (page) => {
      await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#1b2639' } }] } }));
      await page.route('https://server.arcgisonline.com/**', (route) => route.fulfill({ status: 404, body: '' }));
      await page.route('https://nominatim.openstreetmap.org/**', (route) => route.fulfill({ json: {} }));
      await page.goto('http://127.0.0.1:5199/?api=http://design.test');
      await page.waitForFunction(() => window.__terrasim?.house);
      await page.click('[data-open=sites]');
      await page.locator('[data-file]').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
      await page.waitForSelector('[data-save]');
      await page.waitForFunction(() => !window.__terrasim.map.isMoving());
      await page.waitForFunction(() => window.__terrasim.house.riseRemaining === 0, null, { timeout: 15000 }); // Let the rise finish before picking its roof.
      await page.waitForTimeout(300);
    };
    const snapshot = (page) => page.evaluate(() => ({ origin: window.__terrasim.house.placement.origin, bearing: window.__terrasim.house.placement.xAxisBearingDeg, camera: window.__terrasim.map.getCenter().toArray() }));
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await prepare(page);
    await page.click('#panel [data-close]');
    await page.evaluate(() => window.__terrasim.map.jumpTo({ pitch: 70, zoom: 20 }));
    const points = await roofDragPoints(page);
    const before = await snapshot(page);

    // Select.
    assert.equal(await page.evaluate(() => window.__terrasim.house.selected), false);
    await page.mouse.click(...points.from);
    assert.deepEqual(await snapshot(page), before, 'a click selects without moving or panning');
    assert.equal(await page.evaluate(() => window.__terrasim.house.selected), true);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.filter((entry) => entry.selected).length), 1);
    await page.waitForSelector('.mover-offer:not([hidden])');
    console.log('PASS: a click on the visible roof selects it in orange and offers Move');

    // Move by the roof, then by the grip.
    await page.click('.mover-offer');
    await page.waitForSelector('.mover-grip-move:not([hidden])');
    await page.mouse.move(...points.from); await page.mouse.down();
    await page.mouse.move(...points.to, { steps: 6 }); await page.mouse.up();
    let after = await snapshot(page);
    assert.notDeepEqual(after.origin, before.origin, 'dragging the roof in move mode must move the building');
    assert.deepEqual(after.camera, before.camera, 'dragging the roof must not pan the camera');
    const grip = center(await page.locator('.mover-grip-move').boundingBox());
    await page.mouse.move(...grip); await page.mouse.down();
    await page.mouse.move(grip[0] - 12, grip[1] + 6, { steps: 6 }); await page.mouse.up();
    const gripped = await snapshot(page);
    assert.notDeepEqual(gripped.origin, after.origin, 'dragging the top grip must move the building');
    assert.deepEqual(gripped.camera, before.camera);
    console.log('PASS: in move mode the roof and the top grip drag the building without moving the map');

    // Turn by the ring grip.
    const knob = center(await page.locator('.mover-grip-turn').boundingBox());
    const mid = await page.evaluate(() => { const { map, house } = window.__terrasim; const f = house.placement.footprint; const q = map.project([f.reduce((s, p) => s + p[0], 0) / 4, f.reduce((s, p) => s + p[1], 0) / 4]); return [q.x, q.y]; });
    const r = Math.hypot(knob[0] - mid[0], knob[1] - mid[1]), a0 = Math.atan2(knob[1] - mid[1], knob[0] - mid[0]);
    await page.mouse.move(...knob); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(mid[0] + Math.cos(a0 + i * 0.03) * r, mid[1] + Math.sin(a0 + i * 0.03) * r);
    await page.mouse.up();
    const turned = await snapshot(page);
    assert.notEqual(Math.round(turned.bearing), Math.round(gripped.bearing), 'dragging round the ring must turn the building');
    assert.ok(Math.abs(turned.bearing - Math.round(turned.bearing / 90) * 90) > 0.5 || turned.bearing % 1 !== 0, 'turning is not limited to right angles');
    console.log('PASS: the ring grip turns the building to any angle');

    // A release outside the canvas restores panning; a spot outside the land can't be kept.
    const roof = await roofDragPoints(page);
    await page.mouse.move(...roof.from); await page.mouse.down();
    assert.equal(await page.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), false);
    await page.mouse.move(1425, 20); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), true, 'release outside the canvas must restore map panning');
    // That release may have left the building past its land, so put it back and start a fresh move.
    await page.keyboard.press('Escape');
    await page.click('.mover-offer');
    const beforeKeys = await snapshot(page);
    await page.locator('.mover-grip-move').focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.isDisabled('[data-m="done"]'), true, 'Done waits while the building is outside its land');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.body.classList.contains('is-moving')), false, 'Escape ends moving');
    assert.deepEqual((await snapshot(page)).origin, beforeKeys.origin, 'Escape puts the building back');
    console.log('PASS: release outside the canvas restores panning, and an outside spot cannot be kept');

    // Done keeps a spot; empty land still pans and a click there deselects.
    await page.click('.mover-offer');
    await page.locator('.mover-grip-move').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press(']');
    const kept = await snapshot(page);
    await page.click('[data-m="done"]');
    assert.deepEqual((await snapshot(page)).origin, kept.origin, 'Done keeps the new spot');
    const panBefore = await snapshot(page);
    await page.mouse.move(90, 500); await page.mouse.down(); await page.mouse.move(170, 500, { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(() => !window.__terrasim.map.isMoving());
    const panAfter = await snapshot(page);
    assert.notDeepEqual(panAfter.camera, panBefore.camera, 'dragging empty land must still pan the map');
    assert.deepEqual(panAfter.origin, panBefore.origin);
    await page.mouse.click(90, 500);
    assert.equal(await page.evaluate(() => window.__terrasim.house.selected), false, 'clicking empty land clears selection');
    console.log('PASS: Done keeps the spot; empty land still pans and clears the selection');
    await context.close();

    // Mobile: tap selects, Move, then a touch drag on the building moves it; cancel restores panning.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touchPage = await mobile.newPage();
    await prepare(touchPage);
    await touchPage.click('#panel [data-close]');
    await touchPage.evaluate(() => {
      const { map, house } = window.__terrasim;
      const c = house.placement.footprint.reduce(([x, y], p) => [x + p[0] / 4, y + p[1] / 4], [0, 0]);
      map.jumpTo({ center: c, padding: { top: 110, bottom: 110, left: 30, right: 30 }, pitch: 70, zoom: 20 });
    });
    const touch = await roofDragPoints(touchPage, 0.00003); // Exceed the browser's finger-motion threshold.
    const session = await mobile.newCDPSession(touchPage);
    const sendTouch = (type, [x, y]) => session.send('Input.dispatchTouchEvent', { type,
      touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
    const touchBefore = await snapshot(touchPage);
    await sendTouch('touchStart', touch.from);
    await sendTouch('touchEnd', touch.from);
    await touchPage.waitForTimeout(900);
    assert.deepEqual((await snapshot(touchPage)).origin, touchBefore.origin, 'a tap selects without moving the building');
    assert.equal(await touchPage.evaluate(() => window.__terrasim.house.selected), true);
    await touchPage.waitForSelector('#panel [data-tab="cost"]', { timeout: 5000 });
    console.log('PASS: mobile tap selects the building and opens its details');
    await touchPage.tap('.mover-offer');
    await touchPage.waitForSelector('.mover-grip-move:not([hidden])');
    assert.equal(await touchPage.locator('#panel').isVisible(), false, 'Move puts the details sheet away on phones');
    await touchPage.waitForTimeout(300);
    await touchPage.waitForFunction(() => !window.__terrasim.map.isMoving());
    const moveFrom = await snapshot(touchPage);
    const drag = await roofDragPoints(touchPage, 0.00003); // the view eased over when the details opened
    await sendTouch('touchStart', drag.from);
    for (let i = 1; i <= 6; i++) await sendTouch('touchMove', drag.from.map((v, j) => v + (drag.to[j] - v) * i / 6));
    await sendTouch('touchEnd', drag.to);
    const touchAfter = await snapshot(touchPage);
    assert.notDeepEqual(touchAfter.origin, moveFrom.origin, 'a touch drag in move mode moves the building');
    assert.deepEqual(touchAfter.camera, moveFrom.camera, 'and does not pan the map');
    const cancel = await roofDragPoints(touchPage);
    await sendTouch('touchStart', cancel.from);
    assert.equal(await touchPage.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), false);
    await sendTouch('touchCancel', cancel.from);
    assert.equal(await touchPage.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), true);
    console.log('PASS: mobile tap selects, Move then a touch drag moves the house, and cancellation restores controls');
    await mobile.close();
  }, { maxSeconds: 150 });
} finally { server.close(); }
