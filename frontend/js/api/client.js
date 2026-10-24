// The TerraSim API client. Shapes are documented in GEMMA.md (design and estimate) and API.md.

import { config } from '../config.js';
import { store } from '../store.js';

export class NotConnectedError extends Error {
  constructor() {
    super('The design service is not connected yet.');
    this.code = 'not-connected';
  }
}

async function call(path, { method = 'GET', body, signal } = {}) {
  if (!config.apiBaseUrl) throw new NotConnectedError();
  let res;
  try {
    res = await fetch(config.apiBaseUrl.replace(/\/$/, '') + path, {
      method,
      signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error('Couldn’t reach the design service. Check your connection and try again.');
    err.code = 'network';
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message ?? ''; } catch {}
    const err = new Error(detail || `The design service answered ${res.status}.`);
    err.code = res.status === 429 ? 'rate-limited' : 'http';
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const sampleCache = {};
async function sample(name) {
  if (!sampleCache[name]) sampleCache[name] = fetch(new URL(`../../fixtures/mock-house/${name}.json`, import.meta.url)).then((r) => r.json());
  return sampleCache[name];
}

export const api = {
  get connected() { return !!config.apiBaseUrl; },

  // Sends a site and brief. Resolves with { jobId } when the service accepts it.
  submitDesign(request, { signal } = {}) {
    return call('/designs', { method: 'POST', body: request, signal });
  },
  // Job status: { status: 'queued'|'running'|'done'|'failed', progress, message, designId, error }
  job(jobId, { signal } = {}) {
    return call(`/designs/jobs/${encodeURIComponent(jobId)}`, { signal });
  },

  async design(id) {
    if (id === 'sample-0001') return sample('design');
    const local = store.get('sheets', []).find((s) => s.design?.id === id);
    if (local) return local.design;
    return call(`/designs/${encodeURIComponent(id)}`);
  },
  async estimate(id) {
    if (id === 'sample-0001') return sample('estimate');
    const local = store.get('sheets', []).find((s) => s.design?.id === id);
    if (local?.estimate) return local.estimate;
    return call(`/designs/${encodeURIComponent(id)}/estimate`);
  },

  // Published listings. Without a backend, only the sample (when enabled).
  async listings() {
    if (!config.apiBaseUrl) return config.showSample ? [{ design: await sample('design'), estimate: await sample('estimate'), builder: { name: 'Sample builder', company: 'Sample listing' } }] : [];
    return call('/listings');
  },

  sendInquiry(designId, message) {
    return call(`/designs/${encodeURIComponent(designId)}/inquiries`, { method: 'POST', body: message });
  },
  publish(designId, attestation) {
    return call(`/designs/${encodeURIComponent(designId)}/publish`, { method: 'POST', body: attestation });
  },
};
