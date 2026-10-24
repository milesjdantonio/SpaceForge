// Drives the main flow in a headless browser and screenshots each step.
//   node tools/flow.mjs [--out dir]
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = resolve(oi >= 0 ? args[oi + 1] : join(process.env.TEMP || '.', 'terrasim-flow'));
const mobile = args.includes('--mobile');
const VW = mobile ? 390 : 1440, VH = mobile ? 844 : 900;
mkdirSync(out, { recursive: true });
const base = 'http://127.0.0.1:5173';

await withBrowser(async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, hasTouch: mobile, isMobile: mobile, geolocation: { latitude: 35.6402, longitude: -82.5925 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  const shot = async (name) => { await page.screenshot({ path: join(out, (mobile ? 'm-' : '') + name + '.png') }); console.log('shot', name); };
  await page.goto(base + '/');
  await page.waitForTimeout(5000);
  await shot('01-globe');
  // The location marker flies home; a click anywhere else on the globe would fly there instead.
  await page.click('.you');
  await page.waitForTimeout(9000);
  await shot('02-arrived');
  await page.click('[data-act="outline"]');
  await page.waitForTimeout(1200);
  // A lot around the map centre.
  const pts = mobile ? [[110, 420], [280, 410], [300, 580], [120, 590]] : [[620, 420], [820, 400], [860, 560], [640, 590]];
  for (const [x, y] of pts) { await page.mouse.click(x, y); await page.waitForTimeout(250); }
  await shot('03-drawing');
  if (mobile) await page.click('[data-h="finish"]'); else await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await shot('04-brief');
  // The brief: a house, described in words, with every required box filled.
  await page.click('.type-option:has(input[value=house])');
  await page.fill('#q-designPrompt', 'A bright modern farmhouse that opens to the view, with a big kitchen at its heart.');
  for (const [f, v] of [['floors', '2'], ['areaM2', '2200'], ['bedrooms', '3'], ['bathrooms', '2.5'], ['budgetUSD', '650000']]) await page.fill(`#q-${f}`, v);
  await shot('04b-brief-filled');
  await page.click('[data-send]');
  await page.waitForTimeout(4500);
  await shot('05-not-sent');
  await page.click('[data-a="preview"]');
  await page.waitForTimeout(3500);
  await shot('06-house-rising');
  await page.waitForTimeout(3500);
  await shot('07-house-panel');
  await page.click('[data-tab="plans"]');
  await page.waitForTimeout(500);
  await shot('08-plans');
  await page.click('[data-tab="cost"]');
  await page.waitForTimeout(400);
  await shot('09-cost');
  await page.click('[data-tab="time"]');
  await page.waitForTimeout(400);
  await shot('10-time');
  await page.click('[data-walk]');
  await page.waitForTimeout(2500);
  await shot('11-walk');
  if (logs.length) console.log('console:\n  ' + [...new Set(logs)].join('\n  '));
}, { maxSeconds: 170 });
