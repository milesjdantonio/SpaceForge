// Loads each .riv file in the Rive lab with the real Rive web runtime and reports whether it
// loaded, what it contains, and any console errors. Screenshots go to the output folder.
//
//   node tools/rive/check.mjs [name,name] [--out dir] [--drive]
//   --drive   also steps every state-machine input and screenshots the frames

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer } from '../serve.mjs';
import { withBrowser } from '../browser.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const out = resolve(flag('--out') || join(process.env.TEMP || '.', 'terrasim-rive-check'));
const drive = has('--drive');
const names = args[0] ? args[0].split(',') : null;
mkdirSync(out, { recursive: true });

const port = 5199;
const server = await startServer(port);
let failed = 0;
try {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    const q = names ? `?file=${names.join(',')}` : '';
    await page.goto(`http://127.0.0.1:${port}/lab/rive.html${q}`);
    await page.waitForFunction(() => Object.values(window.__rive || {}).length && Object.values(window.__rive).every((r) => r.loaded || r.error), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const reports = await page.evaluate(() => Object.values(window.__rive).map(({ instance, ...r }) => r));
    for (const r of reports) {
      if (!r.loaded) failed++;
      console.log(`${r.loaded ? 'OK  ' : 'FAIL'} ${r.name}: ${r.error || `${r.animations.length} animations [${r.animations.join(', ')}]; ${r.stateMachines.map((s) => `${s.name}(${s.inputs.map((i) => i.name).join(',')})`).join(' ')}`}`);
    }
    await page.screenshot({ path: join(out, 'lab.png'), fullPage: true });
    if (drive) {
      for (const r of reports.filter((x) => x.loaded)) {
        const sections = await page.$$('section');
        const idx = reports.indexOf(r);
        const sec = sections[idx];
        await sec.screenshot({ path: join(out, `${r.name}-0.png`) });
        const inputs = await sec.$$('.controls input, .controls button');
        let step = 1;
        for (const el of inputs) {
          const tag = await el.evaluate((e) => e.type || e.tagName);
          if (tag === 'range') {
            const max = Number(await el.evaluate((e) => e.max));
            const values = max <= 10 ? Array.from({ length: max }, (_, k) => k + 1) : [Math.round(max * 0.25), max];
            for (const v of values) {
              await el.evaluate((e, val) => { e.value = val; e.dispatchEvent(new Event('input')); }, v);
              await page.waitForTimeout(1500);
              await sec.screenshot({ path: join(out, `${r.name}-${step++}.png`) });
            }
            continue;
          }
          await el.click();
          await page.waitForTimeout(1600);
          await sec.screenshot({ path: join(out, `${r.name}-${step++}.png`) });
        }
      }
    }
    if (logs.length) console.log('console:\n  ' + [...new Set(logs)].join('\n  '));
    console.log(`screenshots: ${out}`);
  }, { maxSeconds: 150 });
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);
