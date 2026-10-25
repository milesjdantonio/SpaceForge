// The TerraSim API client. Shapes are in contracts/FIELDS.md (request, design, estimate) and the
// endpoints in contracts/STORAGE.md.

import { config } from '../config.js';
import { store } from '../store.js';
import { auth } from '../auth.js';

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
    const err = new Error(`Couldn’t reach the design service at ${config.apiBaseUrl}. Check it’s running and allows requests from this page (CORS).`);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const designKey = () => auth.user ? `designs:${auth.user.uid}` : 'designs';
const localDesigns = () => store.get(designKey(), []);

// Waits for a design job to finish (polling every second), or takes a design that came back at
// once. Resolves with { design, estimate, request }.
async function finishJob(res, { onProgress, signal } = {}) {
  if (res?.jobId && !res.design && !res.designId) {
    const jobId = res.jobId;
    const stop = () => { call(`/designs/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => {}); };
    if (signal?.aborted) { stop(); throw new DOMException('Stopped', 'AbortError'); }
    signal?.addEventListener('abort', stop, { once: true });
    onProgress?.({ status: 'queued', message: 'The design service accepted the request.' });
    const started = Date.now();
    let since = 0;
    for (;;) {
      await sleep(1000);
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      // `since` asks only for log lines not yet seen (services without a log ignore it).
      const job = await call(`/designs/jobs/${encodeURIComponent(res.jobId)}?since=${since}`, { signal });
      if (typeof job.logTotal === 'number') since = job.logTotal;
      onProgress?.(job);
      if (job.status === 'done') { res = job; break; }
      if (job.status === 'cancelled') throw new DOMException('Stopped', 'AbortError');
      if (job.status === 'failed') {
        const err = new Error(job.error || 'The design service couldn’t finish this design.');
        err.code = 'job-failed';
        // Gemma's recommendation for this failure: { summary, recommendation, change, changeLabel }.
        err.advice = job.advice ?? null;
        throw err;
      }
      if (Date.now() - started > 15 * 60 * 1000) {
        const err = new Error('The design is taking longer than 15 minutes. It may still arrive.');
        err.code = 'timeout';
        throw err;
      }
    }
    signal?.removeEventListener('abort', stop);
  }
  // The reply may carry the design whole, nest it under "result", or give only its id.
  const body = res?.result ?? res;
  let design = body?.design ?? (body?.schema === 'terrasim.design/2' || body?.schema === 'terrasim.design/3' ? body : null);
  let estimate = body?.estimate ?? null;
  if (!design && body?.designId) {
    design = await call(`/designs/${encodeURIComponent(body.designId)}`, { signal });
    // The design carries its cost; a separate estimate is only fetched for services that don't.
    if (!design?.cost) {
      try { estimate = await call(`/designs/${encodeURIComponent(body.designId)}/estimate`, { signal }); } catch { estimate = null; }
    }
  }
  if (!design) {
    const err = new Error('The design service answered, but without a design.');
    err.code = 'no-design';
    throw err;
  }
  return { design, estimate, request: body?.request ?? null };
}

export const api = {
  get connected() { return !!config.apiBaseUrl; },
  get baseUrl() { return config.apiBaseUrl; },

  // Sends a request and waits for the finished design. The service may answer with the design
  // itself ({ design, estimate }), with { designId }, or with { jobId } to poll every 2 seconds.
  // Resolves with { design, estimate }. onProgress gets job updates ({ status, progress, message }).
  // Aborting `signal` also asks the service to stop the job, so Gemma isn't left working on it.
  async createDesign(request, { onProgress, signal } = {}) {
    return finishJob(await call('/designs', { method: 'POST', body: request, signal }), { onProgress, signal });
  },

  // A redesign from a change the user wrote: the service turns the change into a new brief and
  // designs it on the same land. `request` is the brief the design was made from, when known.
  // Resolves like createDesign, plus `request`: the brief the change became.
  async editDesign({ design, request = null, change }, { onProgress, signal } = {}) {
    return finishJob(await call('/designs/edit', { method: 'POST', body: { design, request, change }, signal }), { onProgress, signal });
  },


  // Whether the service has site data for a spot: { covered, message }. null when unknown (no
  // service, or one without this endpoint), so nothing is blocked on a guess.
  async coverage([lng, lat]) {
    if (!config.apiBaseUrl) return null;
    try { return await call(`/coverage?lng=${lng}&lat=${lat}`); } catch { return null; }
  },

  // Whether the building the brief describes fits the land, checked by the design service with the
  // code that places the real building. null when there's no service or it can't say.
  async fit(request, { signal } = {}) {
    if (!config.apiBaseUrl) return null;
    try { return await call('/fit', { method: 'POST', body: request, signal }); } catch (e) { if (e.name === 'AbortError') throw e; return null; }
  },

  // Keeps a received design in this browser (the newest 12), so it can be reopened.
  keepLocal(design, estimate) {
    store.update(designKey(), [], (list) => [{ design, estimate }, ...list.filter((x) => x.design?.id !== design.id)].slice(0, 12));
  },

  async design(id) {
    if (id === 'sample-0001') return sample('design');
    const local = localDesigns().find((s) => s.design?.id === id);
    if (local) return local.design;
    return call(`/designs/${encodeURIComponent(id)}`);
  },
  async estimate(id) {
    if (id === 'sample-0001') return sample('estimate');
    const local = localDesigns().find((s) => s.design?.id === id);
    if (local) return local.estimate;
    return call(`/designs/${encodeURIComponent(id)}/estimate`);
  },
};
