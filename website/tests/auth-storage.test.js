import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuth } from '../js/auth.js';
import { createBuildingClient } from '../js/api/buildings.js';
import { savedDocument, readSavedBuilding } from '../js/lib/saved-building.js';

const settings = { storageBaseUrl: 'https://storage.example', auth: { apiKey: 'public-test-key', emulatorUrl: '' } };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const memory = () => { const values = new Map(); return { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k), values }; };
const profile = { id: 'local-user', auth_subject: 'alice', email: 'alice@example.test' };

test('Firebase login verifies the profile and keeps only the refresh token in tab storage', async () => {
  const storage = memory();
  const calls = [];
  const account = createAuth({ settings, storage, fetcher: async (url, options) => {
    calls.push({ url, options });
    return url.includes('signInWithPassword') ? response({ idToken: 'id-token', refreshToken: 'refresh-token', expiresIn: '3600' }) : response(profile);
  } });
  await account.signIn(' alice@example.test ', 'private-password');
  assert.equal(account.user.uid, 'alice');
  assert.equal(await account.token(), 'id-token');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer id-token');
  assert.deepEqual([...storage.values.values()], ['refresh-token']);
  account.signOut();
  assert.equal(account.user, null);
  assert.equal(storage.values.size, 0);
});

test('reload restores a session by refreshing and verifying with the Go backend', async () => {
  const storage = memory();
  storage.setItem(`terrasim.auth:${settings.storageBaseUrl}:${settings.auth.apiKey}`, 'saved-refresh');
  const account = createAuth({ settings, storage, fetcher: async (url) => url.includes('/token?')
    ? response({ id_token: 'renewed-token', refresh_token: 'renewed-refresh', expires_in: '3600' }) : response(profile) });
  await account.ready;
  assert.equal(account.user.uid, 'alice');
  assert.equal(await account.token(), 'renewed-token');
});

test('concurrent storage calls share one token refresh', async () => {
  let count = 0;
  const account = createAuth({ settings, storage: memory(), fetcher: async (url) => {
    if (url.includes('signInWithPassword')) return response({ idToken: 'expired', refreshToken: 'refresh', expiresIn: '0' });
    if (url.includes('/token?')) { count++; await new Promise((resolve) => setTimeout(resolve, 5)); return response({ id_token: 'fresh', refresh_token: 'refresh', expires_in: '3600' }); }
    return response(profile);
  } });
  await account.signIn('alice@example.test', 'password');
  assert.deepEqual(await Promise.all([account.token(), account.token()]), ['fresh', 'fresh']);
  assert.equal(count, 1);
});

test('signing out during refresh cannot restore the old session', async () => {
  let finish;
  const account = createAuth({ settings, storage: memory(), fetcher: async (url) => {
    if (url.includes('signInWithPassword')) return response({ idToken: 'expired', refreshToken: 'refresh', expiresIn: '0' });
    if (url.includes('/token?')) return new Promise((resolve) => { finish = resolve; });
    return response(profile);
  } });
  await account.signIn('alice@example.test', 'password');
  const token = account.token();
  await new Promise((resolve) => setTimeout(resolve, 0));
  account.signOut();
  finish(response({ id_token: 'fresh', refresh_token: 'refresh', expires_in: '3600' }));
  await assert.rejects(token, { code: 'account-changed' });
  assert.equal(account.user, null);
});

test('Firebase rejects bad credentials without creating a local signed-in session', async () => {
  const account = createAuth({ settings, storage: memory(), fetcher: async () => response({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, 400) });
  await assert.rejects(account.signIn('alice@example.test', 'wrong'), /email or password is incorrect/);
  assert.equal(account.user, null);
});

test('building calls attach tokens only to the storage URL and PUT an existing SQL ID', async () => {
  const calls = [];
  const account = { user: { uid: 'alice' }, ready: Promise.resolve(), token: async () => 'verified-token' };
  const client = createBuildingClient({ baseUrl: 'https://storage.example', account, fetcher: async (url, options) => {
    calls.push({ url, options }); return response({ id: 'sql-uuid' });
  } });
  await client.save({ name: 'House', data: { design: { id: 'gemma-id' } } });
  await client.save({ id: 'sql-uuid', name: 'House', data: {} });
  assert.equal(calls[0].url, 'https://storage.example/api/buildings');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer verified-token');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].url, 'https://storage.example/api/buildings/sql-uuid');
});

test('storage retries a 401 with a refreshed token', async () => {
  const tokens = [];
  let count = 0;
  const account = { user: { uid: 'alice' }, ready: Promise.resolve(), token: async (force) => { tokens.push(force); return force ? 'fresh' : 'stale'; }, signOut() { this.user = null; } };
  const client = createBuildingClient({ baseUrl: 'https://storage.example', account, fetcher: async () => ++count === 1 ? response({}, 401) : response({ items: [] }) });
  await client.list();
  assert.deepEqual(tokens, [false, true]);
});

test('account changes cannot display another user’s delayed SQL response', async () => {
  let finish;
  const account = { user: { uid: 'alice' }, ready: Promise.resolve(), token: async () => 'alice-token' };
  const client = createBuildingClient({ baseUrl: 'https://storage.example', account, fetcher: () => new Promise((resolve) => { finish = resolve; }) });
  const result = client.list();
  await new Promise((resolve) => setTimeout(resolve, 0));
  account.user = { uid: 'bob' };
  finish(response({ items: [{ name: 'Private Alice building' }] }));
  await assert.rejects(result, { code: 'account-changed' });
});

test('Gemma design, estimate, site and preview placement survive the storage wrapper unchanged', async () => {
  const design = JSON.parse(await readFile(new URL('../fixtures/mock-house/design.json', import.meta.url)));
  const estimate = JSON.parse(await readFile(new URL('../fixtures/mock-house/estimate.json', import.meta.url)));
  const site = { ring: design.site.outline, form: { housingType: 'house' } };
  const original = structuredClone(design);
  const placement = { ...design.placement, origin: design.placement.origin.map((v) => v + 0.00001),
    footprint: design.placement.footprint.map((p) => p.map((v) => v + 0.00001)) };
  const data = savedDocument({ design, estimate, site, placement });
  const loaded = readSavedBuilding(JSON.parse(JSON.stringify({ id: 'sql-uuid', data })));
  assert.deepEqual(loaded.design, original);
  assert.deepEqual(loaded.estimate, estimate);
  assert.deepEqual(loaded.site, site);
  assert.deepEqual(loaded.placement, placement);
  assert.notDeepEqual(loaded.placement, loaded.design.placement);
  assert.deepEqual(design, original);
  assert.throws(() => readSavedBuilding({ data: { unrelated: true } }), /cannot be drawn/);
});
