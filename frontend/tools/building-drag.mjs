// Browser regression for picking a visible roof/wall in a pitched 3D view.
// Uses fixture JSON, no account, provider calls, or database writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from './serve.mjs';
import { withBrowser } from './browser.mjs';
import { roofDragPoints } from './building-pointer.mjs';

const fixture = { design: JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url))),
  estimate: JSON.parse(await readFile(new URL('../fixtures/mock-house/estimate.json', import.meta.url))) };
const server = await startServer(5199);
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
      await page.waitForTimeout(2800); // Let the rise finish before picking its roof.
    };
    const snapshot = (page) => page.evaluate(() => ({ origin: window.__terrasim.house.placement.origin, camera: window.__terrasim.map.getCenter().toArray() }));
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await prepare(page);
    await page.evaluate(() => window.__terrasim.map.jumpTo({ pitch: 70, zoom: 20 }));
    const points = await roofDragPoints(page);
    const before = await snapshot(page);
    assert.equal(await page.evaluate(() => window.__terrasim.house.selected), false);
    await page.mouse.move(...points.from); await page.mouse.down();
    await page.mouse.move(...points.to, { steps: 6 }); await page.mouse.up();
    assert.deepEqual(await snapshot(page), before, 'first gesture selects without dragging or panning');
    assert.equal(await page.evaluate(() => window.__terrasim.house.selected), true);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.filter((entry) => entry.selected).length), 1);
    await page.screenshot({ path: '/tmp/terrasim-building-selected.png' });
    console.log('PASS: first gesture selects the visible roof in orange without moving it or panning');
    await page.mouse.move(...points.from); await page.mouse.down();
    await page.mouse.move(...points.to, { steps: 6 }); await page.mouse.up();
    const after = await snapshot(page);
    assert.notDeepEqual(after.origin, before.origin, 'dragging the visible roof must move the building');
    assert.deepEqual(after.camera, before.camera, 'dragging the visible roof must not pan the camera');
    console.log('PASS: a visible roof outside the ground footprint drags the building without moving the map');

    const outside = await roofDragPoints(page);
    await page.mouse.move(...outside.from); await page.mouse.down();
    assert.equal(await page.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), false);
    await page.mouse.move(1425, 20); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), true, 'release outside the canvas must restore map panning');
    const panBefore = await snapshot(page);
    await page.mouse.move(90, 500); await page.mouse.down(); await page.mouse.move(170, 500, { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(() => !window.__terrasim.map.isMoving());
    const panAfter = await snapshot(page);
    assert.notDeepEqual(panAfter.camera, panBefore.camera, 'dragging empty land must still pan the map');
    assert.deepEqual(panAfter.origin, panBefore.origin);
    await page.mouse.click(90, 500);
    assert.equal(await page.evaluate(() => window.__terrasim.house.selected), false, 'clicking empty land clears selection');
    console.log('PASS: releasing outside the canvas restores controls and empty land still pans');
    await context.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touchPage = await mobile.newPage();
    await prepare(touchPage);
    await touchPage.click('#panel [data-close]');
    await touchPage.evaluate(() => {
      const { map, house } = window.__terrasim;
      const center = house.placement.footprint.reduce(([x, y], p) => [x + p[0] / 4, y + p[1] / 4], [0, 0]);
      map.jumpTo({ center, padding: { top: 110, bottom: 110, left: 30, right: 30 }, pitch: 70, zoom: 20 });
    });
    const touch = await roofDragPoints(touchPage, 0.00003); // Exceed the browser's finger-motion threshold.
    const session = await mobile.newCDPSession(touchPage);
    const sendTouch = (type, [x, y]) => session.send('Input.dispatchTouchEvent', { type,
      touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
    const touchBefore = await snapshot(touchPage);
    await sendTouch('touchStart', touch.from);
    await sendTouch('touchEnd', touch.from);
    assert.deepEqual(await snapshot(touchPage), touchBefore, 'first tap selects without moving');
    assert.equal(await touchPage.evaluate(() => window.__terrasim.house.selected), true);
    assert.equal(await touchPage.locator('#panel').isVisible(), false, 'selection must keep the building exposed for the next touch drag');
    await sendTouch('touchStart', touch.from);
    for (let i = 1; i <= 6; i++) await sendTouch('touchMove', touch.from.map((v, j) => v + (touch.to[j] - v) * i / 6));
    await sendTouch('touchEnd', touch.to);
    const touchAfter = await snapshot(touchPage);
    assert.notDeepEqual(touchAfter.origin, touchBefore.origin);
    assert.deepEqual(touchAfter.camera, touchBefore.camera);
    const cancel = await roofDragPoints(touchPage);
    await sendTouch('touchStart', cancel.from);
    assert.equal(await touchPage.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), false);
    await sendTouch('touchCancel', cancel.from);
    assert.equal(await touchPage.evaluate(() => window.__terrasim.map.dragPan.isEnabled()), true);
    console.log('PASS: mobile tap selects, next gesture moves the house, and cancellation restores controls');
    await mobile.close();
  }, { maxSeconds: 120 });
} finally { server.close(); }
