import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingSaver } from '../js/lib/building-saver.js';

const input = (x) => ({ name: 'House', data: { placement: { origin: [x, 37] } } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('moves during initial creation queue as updates on the returned SQL ID', async () => {
  const calls = [], pending = [], records = [];
  const save = createBuildingSaver({ isCurrent: () => true, onSaved: (record) => records.push(record),
    save: (body) => { calls.push(body); return new Promise((resolve) => pending.push(resolve)); } });
  const first = save(input(1));
  assert.equal(save(input(1)), first, 'identical overlapping saves share creation');
  await tick();
  const moved = input(2);
  const second = save(moved);
  moved.data.placement.origin[0] = 99;
  const third = save(input(3));
  assert.equal(calls.length, 1, 'later moves must wait for creation');
  pending.shift()({ id: 'sql-id' });
  await first; await tick();
  assert.equal(calls[1].id, 'sql-id');
  assert.equal(calls[1].data.placement.origin[0], 2, 'queued data is a snapshot');
  pending.shift()({ id: 'sql-id' });
  await second; await tick();
  assert.equal(calls[2].id, 'sql-id');
  assert.equal(calls[2].data.placement.origin[0], 3);
  pending.shift()({ id: 'sql-id' });
  await third;
  assert.equal(records.length, 3);
});

test('a failed position save can be retried without blocking later changes', async () => {
  let calls = 0;
  const save = createBuildingSaver({ id: 'sql-id', isCurrent: () => true, onSaved: () => {},
    save: async (body) => {
      assert.equal(body.id, 'sql-id');
      if (++calls === 1) throw new Error('Network unavailable');
      return { id: body.id, data: body.data };
    } });
  await assert.rejects(save(input(1)), /Network unavailable/);
  const record = await save(input(1));
  assert.equal(record.data.placement.origin[0], 1);
  assert.equal(calls, 2);
});

test('invalidating the account or building cancels queued saves and stale callbacks', async () => {
  let current = true, finish, calls = 0, saved = 0;
  const save = createBuildingSaver({ id: 'sql-id', isCurrent: () => current, onSaved: () => saved++,
    save: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = assert.rejects(save(input(1)), { code: 'view-changed' });
  await tick();
  const queued = assert.rejects(save(input(2)), { code: 'view-changed' });
  current = false;
  finish({ id: 'sql-id' });
  await Promise.all([first, queued]);
  assert.equal(calls, 1, 'queued private data must never be sent after a context change');
  assert.equal(saved, 0);
});
