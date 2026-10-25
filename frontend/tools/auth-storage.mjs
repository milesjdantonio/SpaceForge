// Uses the real local Auth emulator + Go API/SQL, with a fixture design-service reply.
// TEST_STORAGE_URL may point to an isolated API/database; no AI provider is called.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { startServer } from './serve.mjs';
import { withBrowser } from './browser.mjs';
import { roofDragPoints } from './building-pointer.mjs';

const storage = process.env.TEST_STORAGE_URL || 'http://127.0.0.1:8080';
const port = Number(process.env.TEST_FRONTEND_PORT || 5197);
const base = `http://127.0.0.1:${port}`;
const sample = JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url)));
const estimate = JSON.parse(await readFile(new URL('../fixtures/mock-house/estimate.json', import.meta.url)));
const title = 'Account storage integration house';
const generated = { ...sample, id: `browser-design-${Date.now()}`, sample: false, overview: { ...sample.overview, title }, cost: {
  currency: estimate.currency, asOf: estimate.asOf, buildCost: estimate.buildCost,
  materials: estimate.materials, overTime: estimate.overTime,
  breakdown: { materials: 100000, total: estimate.buildCost.expected },
  suppliers: [{ Name: 'Test supplier', Type: 'hardware', Miles: 4.2 }],
} };
const accounts = new Set();
const server = await startServer(port);
await mkdir('/tmp/terrasim-auth-storage', { recursive: true });

try {
  await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: [] });
    const page = await context.newPage();
    const errors = [];
    let creates = 0;
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('response', async (res) => {
      if (res.url().includes('accounts:signUp') && res.ok()) { const body = await res.json().catch(() => ({})); if (body.localId) accounts.add(body.localId); }
      if (res.url() === storage + '/api/buildings' && res.request().method() === 'POST' && res.status() === 201) creates++;
    });
    await page.route('**/js/config.js', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace("'http://127.0.0.1:8080'", JSON.stringify(storage)) });
    });
    // Only map imagery is stubbed; all auth and SQL traffic goes to real services.
    await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#1b2639' } }] } }));
    await page.route('https://server.arcgisonline.com/**', (route) => route.fulfill({ status: 404, body: '' }));
    await page.route('https://nominatim.openstreetmap.org/**', (route) => route.fulfill({ json: {} }));
    await page.route('http://design.test/**', async (route) => {
      assert.equal(route.request().headers().authorization, undefined, 'Firebase tokens must not go to the design service');
      const request = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (request) {
        assert.equal(request.schema, 'terrasim.design-request/2');
        generated.requestId = request.id;
      }
      const path = new URL(route.request().url()).pathname;
      const body = request ? { jobId: 'browser-job' }
        : path.includes('/jobs/') ? { status: 'done', designId: generated.id, logTotal: 1,
          log: [{ t: 1, text: 'Drawing the design' }], progress: 1, message: 'Design ready.' }
        : path === `/designs/${generated.id}` ? generated : [];
      await route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : request ? 202 : 200,
        headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
        ...(route.request().method() === 'OPTIONS' ? { body: '' } : { json: body }) });
    });
    const waitApp = async () => page.waitForFunction(() => window.__terrasim?.house, { timeout: 30000 });
    const signIn = async (email, create = false) => {
      await page.click('#account-button');
      if (create) await page.click('[data-toggle]');
      await page.fill('#account-email', email);
      await page.fill('#account-password', 'local-browser-test-password');
      await page.click('[data-auth-form] button[type=submit]');
      await page.waitForFunction(() => !document.querySelector('#dialog').open, { timeout: 15000 });
      assert.equal(await page.locator('#account-button').textContent(), 'Account');
    };
    const signOut = async () => { await page.click('#account-button'); await page.click('[data-signout]'); await page.waitForFunction(() => document.querySelector('#account-button').textContent === 'Sign in'); };
    const stamp = Date.now();
    const alice = `browser-alice-${stamp}@example.test`, bob = `browser-bob-${stamp}@example.test`;
    await page.goto(base + '/?api=http://design.test');
    await waitApp();
    await signIn(alice, true);
    console.log('PASS: browser registration, Firebase token verification, and profile creation');

    await page.evaluate(async ({ ring, totals }) => {
      const { auth } = await import('/js/auth.js');
      const { store } = await import('/js/store.js');
      store.set(`sites:${auth.user.uid}`, [{ id: 'browser-lot', ring, mode: 'dream', status: 'draft', createdAt: new Date().toISOString(), form: {
        housingType: 'house', answers: { designPrompt: 'A bright modern house with quiet rooms and a generous kitchen.', floors: totals.floors, areaM2: totals.finishedAreaM2, bedrooms: totals.bedrooms, bathrooms: totals.bathrooms, unitCount: 1, budgetUSD: 650000 }, advanced: {},
      } }]);
    }, { ring: sample.site.outline, totals: sample.totals });
    await page.click('[data-open=sites]');
    await page.click('[data-drafts] .site-open');
    await page.waitForSelector('[data-send]');
    const savedResponse = page.waitForResponse((res) => res.url() === storage + '/api/buildings' && res.request().method() === 'POST' && res.status() === 201, { timeout: 30000 });
    await page.click('[data-send]');
    const record = await (await savedResponse).json();
    assert.equal(record.data.design.id, generated.id);
    assert.equal(record.data.estimate, null);
    assert.deepEqual(record.data.design.cost, generated.cost);
    assert.equal(record.data.site.id, 'browser-lot');
    await page.waitForSelector('[data-save]', { timeout: 20000 });
    assert.equal(await page.locator('[data-save]').textContent(), 'Save changes');
    const replaced = page.waitForResponse((res) => res.url() === storage + '/api/buildings/' + record.id && res.request().method() === 'PUT');
    await page.click('[data-save]');
    assert.equal((await replaced).status(), 200);
    assert.equal(creates, 1, 'Saving again must not create a duplicate SQL record');
    await page.click('[data-tab=cost]');
    await page.waitForSelector('.tabpanel .range');
    assert.match(await page.locator('.tabpanel').textContent(), /Test supplier/);
    console.log('PASS: Gemma job polling, inline cost renders, SQL auto-save and repeat save updates by SQL ID');

    // Use real pointer drags. Hold the first save response while the house moves
    // again, so the latest placement must queue behind it and use the same SQL ID.
    await page.waitForFunction(() => !window.__terrasim.map.isMoving());
    const dragHouse = async ({ roof = false } = {}) => {
      if (roof) {
        await page.evaluate(() => window.__terrasim.map.jumpTo({ pitch: 70, zoom: 20 }));
        await page.waitForTimeout(2800); // Complete the rise before targeting the visible roof.
      }
      const points = roof ? await roofDragPoints(page) : await page.evaluate(async () => {
        const { map, house } = window.__terrasim;
        const { footprintOutside } = await import('/js/lib/design.js');
        const p = house.placement;
        const candidates = [[0.00001, 0], [-0.00001, 0], [0, 0.00001], [0, -0.00001]];
        const delta = candidates.find(([dx, dy]) => !footprintOutside(p.footprint.map(([x, y]) => [x + dx, y + dy]), house.design.site.outline));
        if (!delta) throw new Error('Fixture land has no room to move the house');
        const center = p.footprint.reduce(([x, y], q) => [x + q[0] / 4, y + q[1] / 4], [0, 0]);
        const from = map.project(center), to = map.project([center[0] + delta[0], center[1] + delta[1]]);
        const rect = map.getCanvas().getBoundingClientRect();
        return { from: [from.x + rect.left, from.y + rect.top], to: [to.x + rect.left, to.y + rect.top] };
      });
      const camera = await page.evaluate(() => window.__terrasim.map.getCenter().toArray());
      if (!(await page.evaluate(() => window.__terrasim.house.selected))) {
        const placement = await page.evaluate(() => structuredClone(window.__terrasim.house.placement));
        await page.mouse.click(...points.from);
        assert.equal(await page.evaluate(() => window.__terrasim.house.selected), true);
        assert.deepEqual(await page.evaluate(() => window.__terrasim.house.placement), placement, 'selection must not move the house');
      }
      await page.mouse.move(...points.from);
      await page.mouse.down();
      await page.mouse.move(...points.to, { steps: 6 });
      await page.mouse.up();
      assert.deepEqual(await page.evaluate(() => window.__terrasim.map.getCenter().toArray()), camera, 'building drags must not pan the map');
      return page.evaluate(() => structuredClone(window.__terrasim.house.placement));
    };
    let releaseFirst, firstReceived;
    let moveWrites = 0;
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    const received = new Promise((resolve) => { firstReceived = resolve; });
    const buildingURL = storage + '/api/buildings/' + record.id;
    await page.route(buildingURL, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      if (++moveWrites === 1) {
        const response = await route.fetch();
        firstReceived();
        await release;
        await route.fulfill({ response });
      } else await route.continue();
    });
    const firstMove = await dragHouse({ roof: true });
    assert.notDeepEqual(firstMove.origin, generated.placement.origin, 'pointer drag must move the house');
    await received;
    const movedPlacement = await dragHouse();
    assert.notDeepEqual(movedPlacement.origin, firstMove.origin);
    assert.equal(moveWrites, 1, 'a newer move must wait for the earlier save');
    const latestSave = page.waitForResponse((res) => res.url() === buildingURL && res.request().method() === 'PUT'
      && JSON.stringify(res.request().postDataJSON().data.placement) === JSON.stringify(movedPlacement));
    releaseFirst();
    const movedRecord = await (await latestSave).json();
    assert.deepEqual(movedRecord.data.placement, movedPlacement);
    assert.deepEqual(movedRecord.data.design.placement, generated.placement, 'original Gemma geometry stays intact');
    assert.equal(moveWrites, 2);
    assert.equal(creates, 1, 'movement updates must not create duplicate buildings');
    await page.unroute(buildingURL);
    console.log('PASS: two pointer drags auto-save in order while the first response is delayed');

    const secondRecord = await page.evaluate(async ({ original, site }) => {
      const { buildings } = await import('/js/api/buildings.js');
      const { savedDocument } = await import('/js/lib/saved-building.js');
      const shift = ([x, y]) => [x - 0.002, y];
      const design = structuredClone(original);
      design.id += '-second'; design.overview.title = 'Second saved house';
      design.site.outline = design.site.outline.map(shift);
      design.placement.origin = shift(design.placement.origin);
      design.placement.footprint = design.placement.footprint.map(shift);
      site.ring = site.ring.map(shift);
      return buildings.save({ name: design.overview.title, data: savedDocument({ design, site, placement: design.placement }) });
    }, { original: generated, site: record.data.site });
    const camera = await page.evaluate(() => {
      const { map, house } = window.__terrasim;
      const [lng, lat] = house.placement.origin;
      map.jumpTo({ center: [lng - 0.001, lat], zoom: 17.2, pitch: 47, bearing: 21 });
      return { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    });
    await page.reload();
    await waitApp();
    await page.waitForFunction(() => document.querySelector('#account-button').textContent === 'Account');
    const waitScene = async (selected) => page.waitForFunction(({ ids, selected }) => {
      const { app, house } = window.__terrasim;
      return app.sceneReady && app.savedBuilding?.id === selected && ids.every((id) => house.entries.some((entry) => entry.id === id));
    }, { ids: [record.id, secondRecord.id], selected }, { timeout: 30000 });
    await waitScene(record.id);
    assert.deepEqual(await page.evaluate(() => window.__terrasim.house.design.cost), generated.cost);
    assert.deepEqual(await page.evaluate(() => window.__terrasim.house.placement), movedPlacement);
    const restoredCamera = await page.evaluate(() => {
      const { map } = window.__terrasim;
      return { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    });
    assert.ok(restoredCamera.center.every((v, i) => Math.abs(v - camera.center[i]) < 1e-8), 'camera center restores within map projection precision');
    for (const key of ['zoom', 'pitch', 'bearing']) assert.ok(Math.abs(restoredCamera[key] - camera[key]) < 1e-8);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.length), 2);
    console.log('PASS: refresh automatically restores both SQL houses, moved placement, selected house and camera without My sites');

    const secondPoint = await page.evaluate((id) => {
      const { map, house } = window.__terrasim;
      const entry = house.entries.find((entry) => entry.id === id);
      const center = entry.placement.footprint.reduce(([x, y], p) => [x + p[0] / 4, y + p[1] / 4], [0, 0]);
      const p = map.project(center), rect = map.getCanvas().getBoundingClientRect();
      return [p.x + rect.left, p.y + rect.top];
    }, secondRecord.id);
    await page.mouse.click(...secondPoint);
    await page.waitForFunction((id) => window.__terrasim.app.savedBuilding?.id === id, secondRecord.id);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.filter((entry) => entry.selected).length), 1, 'only the selected house is highlighted');
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.length), 2, 'selection must keep the other house rendered');
    await page.reload(); await waitApp(); await waitScene(secondRecord.id);
    console.log('PASS: selecting a background house keeps both models and restores the new selection on refresh');

    await page.evaluate(() => {
      const { map, house } = window.__terrasim;
      const center = house.placement.footprint.reduce(([x, y], p) => [x + p[0] / 4, y + p[1] / 4], [0, 0]);
      map.jumpTo({ center, zoom: 19.1 });
    });
    let releaseBackground, backgroundReceived, backgroundWrites = 0;
    const backgroundGate = new Promise((resolve) => { releaseBackground = resolve; });
    const backgroundStarted = new Promise((resolve) => { backgroundReceived = resolve; });
    const secondURL = storage + '/api/buildings/' + secondRecord.id;
    await page.route(secondURL, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      if (++backgroundWrites === 1) {
        const response = await route.fetch(); backgroundReceived();
        await backgroundGate; await route.fulfill({ response });
      } else await route.continue();
    });
    await dragHouse(); await backgroundStarted;
    const backgroundPlacement = await dragHouse();
    await page.click('[data-open=sites]');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    await page.waitForFunction((id) => window.__terrasim.app.savedBuilding?.id === id, record.id);
    const backgroundSaved = page.waitForResponse((res) => res.url() === secondURL && res.request().method() === 'PUT'
      && JSON.stringify(res.request().postDataJSON().data.placement) === JSON.stringify(backgroundPlacement));
    releaseBackground();
    assert.equal((await backgroundSaved).status(), 200);
    assert.equal(backgroundWrites, 2, 'switching selection must not cancel queued position saves');
    assert.equal(await page.evaluate(() => window.__terrasim.app.savedBuilding.id), record.id, 'a background save must not change selection');
    await page.unroute(secondURL);
    await page.waitForFunction(() => !window.__terrasim.map.isMoving());
    await page.reload(); await waitApp(); await waitScene(record.id);
    assert.deepEqual(await page.evaluate((id) => window.__terrasim.house.entries.find((entry) => entry.id === id).placement, secondRecord.id), backgroundPlacement);
    console.log('PASS: queued moves finish after selecting another house and restore on refresh');

    await signOut();
    assert.equal(await page.evaluate(() => window.__terrasim.house.design), null);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.length), 0);
    await signIn(bob, true);
    await page.click('[data-open=sites]');
    await page.waitForSelector('.saved-buildings .empty');
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.length), 0);
    assert.equal(await page.locator('[data-buildings] .site-row').count(), 0);
    const denied = await page.evaluate(async ({ storage, id }) => {
      const { auth } = await import('/js/auth.js');
      return (await fetch(`${storage}/api/buildings/${id}`, { headers: { Authorization: `Bearer ${await auth.token()}` } })).status;
    }, { storage, id: record.id });
    assert.equal(denied, 404);
    console.log('PASS: account switching clears rendered private data and another user cannot read saved buildings');

    await signOut();
    await signIn(alice);
    await waitScene(record.id);
    await page.click('[data-open=sites]');
    await page.waitForSelector('[data-buildings] .site-row');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-buildings] .site-row').filter({ hasText: 'Second saved house' }).getByRole('button', { name: 'Delete saved building' }).click();
    await page.waitForFunction((id) => !window.__terrasim.house.entries.some((entry) => entry.id === id), secondRecord.id);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.length), 1, 'deleting one building must keep the other on the map');
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('[data-buildings] [aria-label="Delete saved building"]');
    await page.waitForSelector('.saved-buildings .empty');
    console.log('PASS: owner can delete a saved building through the UI');

    const imported = { ...generated, id: 'imported-' + stamp, overview: { ...generated.overview, title: 'Imported Gemma design' } };
    await page.locator('[data-file]').setInputFiles({ name: 'gemma-result.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ design: imported, estimate: { ...estimate, designId: imported.id } })) });
    await page.waitForSelector('[data-save]', { timeout: 20000 });
    const importedSave = page.waitForResponse((res) => res.url() === storage + '/api/buildings' && res.request().method() === 'POST');
    await page.click('[data-save]');
    const importedRecord = await (await importedSave).json();
    assert.equal(importedRecord.data.design.id, imported.id);
    await page.screenshot({ path: '/tmp/terrasim-auth-storage/desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#account-button');
    await page.screenshot({ path: '/tmp/terrasim-auth-storage/mobile.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, [], 'No unhandled browser errors');
    console.log('PASS: imported Gemma JSON saves, mobile account UI fits, and browser has no uncaught errors');
    await context.close();
  }, { maxSeconds: 170 });
} finally {
  server.close();
  for (const uid of accounts) {
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-spaceforge/accounts:delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uid }),
    });
    if (!response.ok) throw new Error('Could not clean up an isolated emulator test user.');
  }
}
