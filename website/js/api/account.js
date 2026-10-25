import { config } from '../config.js';
import { auth } from '../auth.js';

// Tokens are sent only to the configured account API, never a URL from a query string.
export function createAccountRequest({ baseUrl = config.storageBaseUrl, account = auth, fetcher = globalThis.fetch } = {}) {
  async function call(path, { method = 'GET', body, signal } = {}) {
    await account.ready;
    const uid = account.user?.uid;
    if (!uid) throw Object.assign(new Error('Sign in to generate, save or open your buildings.'), { code: 'sign-in-required' });
    if (!baseUrl) throw new Error('The account service is not connected yet.');
    const unchanged = () => {
      if (account.user?.uid !== uid) throw Object.assign(new Error('The signed-in account changed. Please try again.'), { code: 'account-changed' });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await account.token(attempt > 0);
      unchanged();
      const response = await fetcher(baseUrl.replace(/\/$/, '') + path, {
        method, signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      unchanged();
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 401) account.signOut();
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw Object.assign(new Error(result.error?.message ?? `Saved buildings are unavailable (${response.status}).`), { status: response.status, code: result.error?.code });
      }
      const result = response.status === 204 ? null : await response.json();
      unchanged();
      return result;
    }
  }
  return call;
}
