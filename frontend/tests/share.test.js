import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { packShare, unpackShare, shareDocument, SHARE_SCHEMA } from '../js/lib/share.js';

const design = JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url)));

test('a shared building survives the round trip through the link', async () => {
  const placement = { ...design.placement, xAxisBearingDeg: 123 };
  const doc = shareDocument({ design, placement, name: 'Our cabin' });
  const packed = await packShare(doc);
  assert.match(packed, /^[A-Za-z0-9_-]+$/, 'safe to put in a URL hash');
  assert.ok(packed.length < JSON.stringify(doc).length / 3, 'compressed well below the raw JSON');
  const back = await unpackShare(packed);
  assert.equal(back.schema, SHARE_SCHEMA);
  assert.equal(back.name, 'Our cabin');
  assert.equal(back.placement.xAxisBearingDeg, 123);
  assert.deepEqual(back.design, design);
});

test('a broken or foreign link is refused with a plain message', async () => {
  await assert.rejects(unpackShare('not-a-real-link'));
  const foreign = await packShare({ schema: 'something/1' });
  await assert.rejects(unpackShare(foreign), /isn’t a TerraSim building/);
});
