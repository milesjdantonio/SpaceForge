// Screenshots pages of the running site (start it first with `npm start`).
//
//   node tools/shot.mjs <path, e.g. "/#/forge"> [--widths 1440,390] [--out dir] [--full] [--wait ms]
//   Prints console errors from the page.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const widths = flag('--widths', '1440,390').split(',').map(Number);
const out = resolve(flag('--out', join(process.env.TEMP || '.', 'terrasim-shots')));
const wait = Number(flag('--wait', '1500'));
const full = has('--full');
const base = flag('--base', 'http://127.0.0.1:5173');
const paths = args.length ? args : ['/'];
mkdirSync(out, { recursive: true });

await withBrowser(async (browser) => {
  for (const w of widths) {
    const page = await browser.newPage({ viewport: { width: w, height: w < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(e.message));
    for (const p of paths) {
      await page.goto(base + p, { waitUntil: 'load' });
      await page.waitForTimeout(wait);
      const name = `${p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}-${w}.png`;
      await page.screenshot({ path: join(out, name), fullPage: full });
      console.log('saved', join(out, name));
    }
    if (logs.length) console.log(`console (${w}):\n  ` + [...new Set(logs)].join('\n  '));
    await page.close();
  }
}, { maxSeconds: 150 });
