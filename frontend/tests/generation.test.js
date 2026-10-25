import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesignClient } from '../js/api/generation.js';
import { createAccountRequest } from '../js/api/account.js';
import { createGenerationObserver } from '../js/controllers/generation.js';
import { createAccountSession } from '../js/controllers/account-session.js';

const account = () => ({ user: { uid: 'alice' }, ready: Promise.resolve(), token: async () => 'verified' });

test('generation submits once and receives a server-persisted building without a browser save', async () => {
  const calls = [];
  const record = { id: 'sql-id', project_id: 'project', data: { design: { id: 'gemma-id' }, estimate: { total: 42 } } };
  let polls = 0;
  const client = createDesignClient({ account: account(), pause: async () => {}, call: async (path, options) => {
    calls.push({ path, options });
    if (options?.method === 'POST') return { jobId: 'durable-job' };
    return ++polls === 1 ? { status: 'running' } : { status: 'done', building: record };
  } });
  const result = await client.createDesign({ id: 'stable-key' }, { site: { ring: [] }, projectId: 'project' });
  assert.equal(result.building, record);
  assert.equal(calls.filter((c) => c.options?.method === 'POST').length, 1);
  assert.equal(calls[0].options.body.request_key, 'stable-key');
  assert.equal(calls[0].options.body.project_id, 'project');
  assert.ok(calls.every((c) => c.path.startsWith('/api/designs')));
});

test('generation credentials go only to the configured account API', async () => {
  const calls = [];
  const call = createAccountRequest({ account: account(), baseUrl: 'https://account.example', fetcher: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ jobId: 'job' }), { status: 202 });
  } });
  await call('/api/designs', { method: 'POST', body: { request: {} } });
  assert.equal(calls[0].url, 'https://account.example/api/designs');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer verified');
});

test('account change during polling rejects the old result', async () => {
  const auth = account();
  const client = createDesignClient({ account: auth, call: async () => { auth.user = { uid: 'bob' }; return { status: 'done', building: { data: { design: {} } } }; } });
  await assert.rejects(client.watch('alice-job'), { code: 'account-changed' });
});

test('reload resumes accepted jobs and observes their saved SQL records', async () => {
  const auth = account(); const saved = [];
  const observer = createGenerationObserver({ auth, onSaved: (r) => saved.push(r), onFailed: () => assert.fail('unexpected failure'), api: {
    jobs: async () => ({ items: [{ jobId: 'pending', status: 'running' }, { jobId: 'old', status: 'done' }] }),
    watch: async (id) => ({ building: { id } }),
  } });
  await observer.resume('alice'); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, [{ id: 'pending' }]); observer.stop();
});

test('sign-out cancels observation before another account can display its result', async () => {
  let finish;
  const auth = account(); const saved = [];
  const observer = createGenerationObserver({ auth, onSaved: (r) => saved.push(r), onFailed() {}, api: {
    jobs: async () => ({ items: [{ jobId: 'alice-job', status: 'running' }] }),
    watch: () => new Promise((resolve) => { finish = resolve; }),
  } });
  await observer.resume('alice'); observer.stop(); auth.user = { uid: 'bob' };
  finish({ building: { id: 'alice-private' } }); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, []);
});

test('account lifecycle clears old private state before restoring the next account', async () => {
  const auth = account(); const events = []; let change;
  auth.onChange = (fn) => { change = fn; return () => {}; };
  const app = {};
  createAccountSession({ auth, app, store: { set() {} }, panel: { dataset: {}, hidden: true }, openSites() {},
    resetView: () => events.push('reset'), restoreScene: (uid) => events.push(`restore:${uid}`),
    generationObserver: { stop: () => events.push('stop'), resume: (uid) => events.push(`observe:${uid}`) },
  });
  await auth.ready; await new Promise((resolve) => setTimeout(resolve, 0));
  auth.user = { uid: 'bob' }; change(auth.user);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['observe:alice', 'restore:alice', 'stop', 'reset', 'observe:bob', 'restore:bob']);
});
