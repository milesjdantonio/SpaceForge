import { config } from '../config.js';
import { auth } from '../auth.js';

export function createBuildingClient({ baseUrl = config.storageBaseUrl, account = auth, fetcher = globalThis.fetch } = {}) {
  async function call(path, { method = 'GET', body } = {}) {
    await account.ready;
    const uid = account.user?.uid;
    if (!uid) throw Object.assign(new Error('Sign in to save or open your buildings.'), { code: 'sign-in-required' });
    if (!baseUrl) throw new Error('Saved buildings are not connected yet.');
    const unchanged = () => {
      if (account.user?.uid !== uid) throw Object.assign(new Error('The signed-in account changed. Please try again.'), { code: 'account-changed' });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await account.token(attempt > 0);
      unchanged();
      const response = await fetcher(baseUrl.replace(/\/$/, '') + path, {
        method, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      unchanged();
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 401) account.signOut();
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw Object.assign(new Error(result.error?.message ?? `Saved buildings are unavailable (${response.status}).`), { status: response.status });
      }
      const result = response.status === 204 ? null : await response.json();
      unchanged();
      return result;
    }
  }
  return {
    list: (offset = 0) => call(`/api/buildings?limit=20&offset=${offset}`),
    get: (id) => call(`/api/buildings/${encodeURIComponent(id)}`),
    save: ({ id, name, data }) => call(id ? `/api/buildings/${encodeURIComponent(id)}` : '/api/buildings', { method: id ? 'PUT' : 'POST', body: { name, data } }),
    remove: (id) => call(`/api/buildings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

export const buildings = createBuildingClient();
