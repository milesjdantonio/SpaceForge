import { config } from './config.js';

const rejected = new Set(['INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_ID_TOKEN']);
const messages = {
  EMAIL_EXISTS: 'An account with this email already exists. Sign in instead.',
  INVALID_LOGIN_CREDENTIALS: 'The email or password is incorrect.',
  INVALID_PASSWORD: 'The email or password is incorrect.',
  EMAIL_NOT_FOUND: 'The email or password is incorrect.',
  INVALID_EMAIL: 'Enter a valid email address.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Please try again later.',
};

// Firebase REST keeps the no-build frontend independent of a CDN. Only a refresh
// token is kept in this tab's sessionStorage; passwords and ID tokens stay in memory.
export function createAuth({ settings = config, fetcher = globalThis.fetch, storage = tabStorage() } = {}) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
  if (settings.auth.emulatorUrl && !local && globalThis.location) throw new Error('The Auth emulator is local development only.');
  const key = `terrasim.auth:${settings.storageBaseUrl}:${settings.auth.apiKey}`;
  const identityURL = settings.auth.emulatorUrl
    ? `${settings.auth.emulatorUrl}/identitytoolkit.googleapis.com/v1`
    : 'https://identitytoolkit.googleapis.com/v1';
  const refreshURL = settings.auth.emulatorUrl
    ? `${settings.auth.emulatorUrl}/securetoken.googleapis.com/v1/token`
    : 'https://securetoken.googleapis.com/v1/token';
  let session = null, revision = 0, refreshing = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(session?.user ?? null));
  const persist = () => {
    try {
      if (session) storage?.setItem(key, session.refreshToken);
      else storage?.removeItem(key);
    } catch { /* In-memory login still works when browser storage is unavailable. */ }
  };
  const changed = () => Object.assign(new Error('The signed-in account changed. Please try again.'), { code: 'account-changed' });
  const configured = () => {
    if (!settings.auth.apiKey || !settings.storageBaseUrl) throw new Error('Sign-in is not configured for this site yet.');
  };
  async function parse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = (body.error?.message ?? '').split(' : ')[0];
      const message = messages[code] ?? (code.startsWith('WEAK_PASSWORD') ? 'Use a password with at least six characters.' : 'Sign-in could not be completed. Please try again.');
      throw Object.assign(new Error(message), { code, status: response.status });
    }
    return body;
  }
  async function profile(token) {
    const response = await fetcher(settings.storageBaseUrl.replace(/\/$/, '') + '/api/me', {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? 'Saved buildings are unavailable. Please try signing in again shortly.'), { status: response.status });
    return { uid: body.auth_subject, email: body.email, id: body.id };
  }
  async function refresh(force = false) {
    if (!session) throw Object.assign(new Error('Sign in to save or open your buildings.'), { code: 'sign-in-required' });
    if (!force && session.token && session.expiresAt > Date.now() + 60000) return session.token;
    if (refreshing) return refreshing;
    const current = session, version = revision;
    const work = (async () => {
      try {
        const response = await fetcher(`${refreshURL}?key=${encodeURIComponent(settings.auth.apiKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
        });
        const body = await parse(response);
        if (version !== revision || session !== current) throw changed();
        session = { ...current, token: body.id_token, refreshToken: body.refresh_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
        persist();
        return session.token;
      } catch (error) {
        if (version === revision && (rejected.has(error.code) || error.status === 401)) service.signOut();
        throw error;
      }
    })();
    refreshing = work;
    try { return await work; } finally { if (refreshing === work) refreshing = null; }
  }
  async function signIn(email, password, create = false) {
    configured();
    const version = ++revision;
    session = null; persist(); notify();
    const response = await fetcher(`${identityURL}/accounts:${create ? 'signUp' : 'signInWithPassword'}?key=${encodeURIComponent(settings.auth.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
    });
    const body = await parse(response);
    const user = await profile(body.idToken);
    if (version !== revision) throw changed();
    session = { user, token: body.idToken, refreshToken: body.refreshToken, expiresAt: Date.now() + Number(body.expiresIn) * 1000 };
    persist(); notify();
    return user;
  }
  const service = {
    get user() { return session?.user ?? null; },
    signIn: (email, password) => signIn(email, password),
    signUp: (email, password) => signIn(email, password, true),
    signOut() { ++revision; session = null; refreshing = null; persist(); notify(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async token(force = false) { await service.ready; return refresh(force); },
  };
  service.ready = (async () => {
    let saved;
    try { saved = storage?.getItem(key); } catch { return; }
    if (!saved || !settings.auth.apiKey || !settings.storageBaseUrl) return;
    const version = revision;
    session = { refreshToken: saved, user: null, token: null, expiresAt: 0 };
    try {
      const token = await refresh();
      const user = await profile(token);
      if (revision !== version || !session) return;
      session.user = user; notify();
    } catch {
      if (revision === version) { session = null; persist(); notify(); }
    }
  })();
  return service;
}

function tabStorage() { try { return globalThis.sessionStorage; } catch { return null; } }
export const auth = createAuth();
