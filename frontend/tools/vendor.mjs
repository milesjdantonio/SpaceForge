// Copies the runtime libraries from node_modules into vendor/, so the site has no build step and
// works without a CDN. Run after `npm install` or a version bump: `npm run vendor`.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nm = join(root, 'node_modules');
const out = join(root, 'vendor');

const version = (pkg) => JSON.parse(readFileSync(join(nm, pkg, 'package.json'), 'utf8')).version;

const files = [
  ['@rive-app/canvas/rive.js', 'rive/rive.js'],
  ['@rive-app/canvas/rive.wasm', 'rive/rive.wasm'],
  ['@rive-app/canvas/rive_fallback.wasm', 'rive/rive_fallback.wasm'],
  ['@rive-app/canvas/LICENSE', 'rive/LICENSE', true],
  ['maplibre-gl/dist/maplibre-gl.mjs', 'maplibre/maplibre-gl.mjs'],
  ['maplibre-gl/dist/maplibre-gl-shared.mjs', 'maplibre/maplibre-gl-shared.mjs'],
  ['maplibre-gl/dist/maplibre-gl-worker.mjs', 'maplibre/maplibre-gl-worker.mjs'],
  ['maplibre-gl/dist/maplibre-gl.css', 'maplibre/maplibre-gl.css'],
  ['maplibre-gl/LICENSE.txt', 'maplibre/LICENSE.txt', true],
  ['three/build/three.module.js', 'three/three.module.js'],
  ['three/build/three.core.js', 'three/three.core.js'],
  ['three/examples/jsm/controls/PointerLockControls.js', 'three/addons/PointerLockControls.js'],
  ['three/examples/jsm/utils/BufferGeometryUtils.js', 'three/addons/utils/BufferGeometryUtils.js'],
  ['three/LICENSE', 'three/LICENSE', true],
  ['pmtiles/dist/esm/index.js', 'pmtiles/pmtiles.mjs'],
  ['pmtiles/LICENSE', 'pmtiles/LICENSE', true],
  ['fflate/esm/browser.js', 'fflate/fflate.mjs'], // pmtiles imports it
  ['fflate/LICENSE', 'fflate/LICENSE', true],
  ['motion/dist/motion.js', 'motion/motion.js'],
  ['motion/LICENSE.md', 'motion/LICENSE.md', true],
];

for (const [from, to, optional] of files) {
  mkdirSync(join(out, to, '..'), { recursive: true });
  try {
    cpSync(join(nm, from), join(out, to), { recursive: true });
  } catch (e) {
    if (!optional) throw e;
  }
}

const versions = {
  '@rive-app/canvas': version('@rive-app/canvas'),
  'maplibre-gl': version('maplibre-gl'),
  three: version('three'),
  pmtiles: version('pmtiles'),
  fflate: version('fflate'),
  motion: version('motion'),
};
writeFileSync(join(out, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('vendored', versions);
