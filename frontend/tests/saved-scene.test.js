import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadSavedScene, sceneCamera } from '../js/lib/saved-scene.js';

const design = JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url)));
const record = (id) => ({ id, data: { schema: 'terrasim.saved-building/1', design } });

test('scene restoration loads all pages with bounded document concurrency', async () => {
  const offsets = [], loaded = [];
  let active = 0, peak = 0;
  const client = {
    list: async (offset) => {
      offsets.push(offset);
      return offset === 0 ? { items: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })), next_offset: 5 }
        : { items: [{ id: 'f' }], next_offset: null };
    },
    get: async (id) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      --active;
      return record(id);
    },
  };
  const result = await loadSavedScene({ client, isCurrent: () => true, onRecord: (r) => loaded.push(r.id) });
  assert.deepEqual(offsets, [0, 5]);
  assert.deepEqual(loaded.sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(result.records.length, 6);
  assert.equal(result.skipped, 0);
  assert.ok(peak <= 4);
});

test('deleted or invalid documents do not prevent valid houses from loading', async () => {
  const loaded = [];
  const result = await loadSavedScene({ isCurrent: () => true, onRecord: (r) => loaded.push(r.id), client: {
    list: async () => ({ items: [{ id: 'gone' }, { id: 'invalid' }, { id: 'valid' }] }),
    get: async (id) => {
      if (id === 'gone') throw Object.assign(new Error('Deleted'), { status: 404 });
      return id === 'invalid' ? { id, data: {} } : record(id);
    },
  } });
  assert.deepEqual(loaded, ['valid']);
  assert.equal(result.skipped, 2);
});

test('a delayed document cannot populate the scene after an account change', async () => {
  let current = true, finish;
  const loaded = [];
  const work = loadSavedScene({ isCurrent: () => current, onRecord: (r) => loaded.push(r.id), client: {
    list: async () => ({ items: [{ id: 'alice-house' }] }),
    get: () => new Promise((resolve) => { finish = resolve; }),
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  current = false;
  finish(record('alice-house'));
  await assert.rejects(work, { code: 'account-changed' });
  assert.deepEqual(loaded, []);
});

test('camera restoration validates stored coordinates and view settings', () => {
  const camera = { center: [-80, 37], zoom: 17.5, pitch: 55, bearing: -20 };
  assert.deepEqual(sceneCamera({ camera }), camera);
  assert.equal(sceneCamera(null), null);
  assert.equal(sceneCamera({ camera: { ...camera, center: [0, 95] } }), null);
  assert.equal(sceneCamera({ camera: { ...camera, zoom: Infinity } }), null);
  assert.equal(sceneCamera({ camera: { ...camera, pitch: 90 } }), null);
});
