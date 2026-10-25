// Run by backend's opt-in browser integration test with real isolated SQL and
// offline Firebase/model stand-ins. No production endpoints or live AI are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from './serve.mjs';
import { withBrowser } from './browser.mjs';

const apiURL = process.env.TEST_STORAGE_URL;
assert.ok(apiURL, 'Run through TestBrowserGenerationAndProjects in backend/');
const server = await startServer(5196);
const base = 'http://127.0.0.1:5196';
const sample = JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url)));
try {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    let browserBuildingCreates = 0;
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('request', (req) => {
      if (req.url() === `${apiURL}/api/buildings` && req.method() === 'POST') browserBuildingCreates++;
    });
    await page.route('**/js/config.js', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace("'http://127.0.0.1:8080'", JSON.stringify(apiURL)) });
    });
    // Firebase's REST transport is stubbed; profile, auth middleware, projects,
    // jobs and building writes still go through the actual Go API and PostgreSQL.
    await page.route('http://127.0.0.1:9099/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Headers': 'content-type' } });
      const refresh = req.url().includes('/token?');
      const uid = refresh ? new URLSearchParams(req.postData()).get('refresh_token') : req.postDataJSON().email;
      await route.fulfill({ json: refresh ? { id_token: uid, refresh_token: uid, expires_in: '3600' } : { idToken: uid, refreshToken: uid, expiresIn: '3600' }, headers: { 'Access-Control-Allow-Origin': base } });
    });
    await page.route('https://tiles.openfreemap.org/**', (r) => r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#1b2639' } }] } }));
    await page.route('https://server.arcgisonline.com/**', (r) => r.fulfill({ status: 404, body: '' }));
    await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ json: {} }));
    await page.route('https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/**', (r) => r.fulfill({ status: 404, body: '' }));
    await page.route('https://s3.amazonaws.com/elevation-tiles-prod/**', (r) => r.fulfill({ status: 404, body: '' }));
    await page.route('http://untrusted-design.test/**', () => assert.fail('Query-string provider override was used'));
    await page.goto(`${base}/?api=http://untrusted-design.test`);
    await page.waitForFunction(() => window.__terrasim?.house);
    await page.evaluate(async () => {
      const { auth } = await import('/js/auth.js');
      await auth.signIn('browser-alice', 'fixture-only-password');
    });
    await page.evaluate(async ({ ring, totals }) => {
      const { auth } = await import('/js/auth.js');
      const { store } = await import('/js/store.js');
      store.set(`sites:${auth.user.uid}`, [{ id: 'browser-lot', ring, mode: 'dream', status: 'draft', createdAt: new Date().toISOString(), form: {
        housingType: 'house', answers: { designPrompt: 'A bright house with quiet rooms.', floors: totals.floors, areaM2: totals.finishedAreaM2, bedrooms: totals.bedrooms, bathrooms: totals.bathrooms, unitCount: 1, budgetUSD: 650000 }, advanced: {},
      } }]);
    }, { ring: sample.site.outline, totals: sample.totals });
    await page.click('[data-open=sites]');
    await page.click('[data-drafts] .site-open');
    await page.waitForSelector('[data-send]');
    const submitted = page.waitForResponse((r) => r.url() === `${apiURL}/api/designs` && r.request().method() === 'POST' && r.status() === 202);
    await page.click('[data-send]');
    const job = await (await submitted).json();
    await page.reload();
    await page.waitForFunction(() => window.__terrasim?.app.sceneReady);
    await page.waitForFunction(() => window.__terrasim.house.entries.length === 1, { timeout: 30000 });
    assert.equal(browserBuildingCreates, 0, 'Generation required a browser POST to save');
    const record = await page.evaluate(async (jobId) => {
      const { createAccountRequest } = await import('/js/api/account.js');
      const task = await createAccountRequest()(`/api/designs/jobs/${jobId}`);
      return task.building;
    }, job.jobId);
    assert.ok(record?.id); assert.equal(record.project_id, job.projectId);
    console.log('PASS: generation survives reload and saves without a browser building POST');

    await page.click('[data-open=sites]');
    await page.waitForSelector('[data-buildings] .site-row');
    page.once('dialog', (dialog) => dialog.accept('Grouped project'));
    await page.click('[data-new-project]');
    await page.waitForFunction(() => [...document.querySelector('[data-project-filter]').options].some((o) => o.textContent === 'Grouped project'));
    const projectID = await page.locator('[data-project-filter] option').evaluateAll((options) => options.find((o) => o.textContent === 'Grouped project').value);
    const membershipWrite = page.waitForResponse((r) => r.url() === `${apiURL}/api/buildings/${record.id}/project` && r.request().method() === 'PUT' && r.status() === 200);
    await page.locator('[data-buildings] select').selectOption(projectID);
    await membershipWrite;
    await page.locator('[data-project-filter]').selectOption(projectID);
    assert.equal(await page.locator('[data-buildings] .site-row').count(), 1);
    console.log('PASS: project creation, membership changes and project filtering use private SQL records');

    await page.reload();
    await page.waitForFunction(() => window.__terrasim?.house.entries.length === 1);
    await page.evaluate(async () => {
      const { auth } = await import('/js/auth.js'); auth.signOut();
      await auth.signIn('browser-bob', 'fixture-only-password');
    });
    await page.waitForFunction(() => window.__terrasim.app.sceneReady);
    assert.equal(await page.evaluate(() => window.__terrasim.house.entries.length), 0);
    await page.click('[data-open=sites]');
    await page.waitForSelector('.saved-buildings .empty');
    assert.equal(await page.locator('[data-buildings] .site-row').count(), 0);
    assert.equal(await page.locator('[data-project-filter] option').count(), 1);
    await page.evaluate(async ({ ring, totals }) => {
      const { auth } = await import('/js/auth.js');
      const { store } = await import('/js/store.js');
      store.set(`sites:${auth.user.uid}`, [{ id: 'failure-lot', ring, mode: 'dream', status: 'draft', createdAt: new Date().toISOString(), form: {
        housingType: 'house', answers: { designPrompt: 'An oversized building for failure regression.', floors: totals.floors, areaM2: totals.finishedAreaM2, bedrooms: totals.bedrooms, bathrooms: totals.bathrooms, unitCount: 1, budgetUSD: 650000 }, advanced: {},
      } }]);
    }, { ring: sample.site.outline, totals: sample.totals });
    await page.click('[data-open=sites]');
    await page.click('[data-drafts] .site-open');
    await page.waitForSelector('[data-send]');
    await page.click('[data-send]');
    await page.waitForSelector('.fail-card', { timeout: 30000 });
    assert.match(await page.locator('.fail-card').innerText(), /building does not fit/i);
    assert.match(await page.locator('.fail-card').innerText(), /setbacks/i);
    assert.equal(await page.locator('[data-a=edit]').count(), 1);
    console.log('PASS: an unbuildable footprint shows an actionable error and edit controls instead of waiting indefinitely');
    assert.deepEqual(errors, []);
    console.log('PASS: account switching clears private models, projects and delayed results without browser errors');
    await page.close();
  }, { maxSeconds: 120 });
} finally { await new Promise((resolve) => server.close(resolve)); }
