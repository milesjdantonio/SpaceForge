import { createAccountRequest } from './account.js';
import { auth } from '../auth.js';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Stopped', 'AbortError'));
  const abort = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

// Closing the page stops observation; the durable server job keeps running and saving.
export function createDesignClient({ account = auth, call = createAccountRequest({ account }), pause = wait } = {}) {
  async function watch(jobId, { onProgress, signal } = {}) {
    const uid = account.user?.uid;
    if (!uid) throw Object.assign(new Error('Sign in to generate a building.'), { code: 'sign-in-required' });
    for (;;) {
      if (account.user?.uid !== uid) throw Object.assign(new Error('The signed-in account changed.'), { code: 'account-changed' });
      const job = await call(`/api/designs/jobs/${encodeURIComponent(jobId)}`, { signal });
      if (account.user?.uid !== uid) throw Object.assign(new Error('The signed-in account changed.'), { code: 'account-changed' });
      onProgress?.(job);
      if (job.status === 'failed') throw Object.assign(new Error(job.error || 'Generation could not finish.'), { code: 'job-failed', reason: job.error_code });
      if (job.status === 'done') {
        if (!job.building?.data?.design) throw new Error('The completed job has no saved building.');
        return { design: job.building.data.design, estimate: job.building.data.estimate ?? null, building: job.building };
      }
      await pause(1000, signal);
    }
  }
  return {
    async createDesign(request, { site = {}, projectId = null, onProgress, signal } = {}) {
      const accepted = await call('/api/designs', { method: 'POST', signal,
        body: { request, site, request_key: request.id, ...(projectId ? { project_id: projectId } : {}) } });
      return watch(accepted.jobId, { onProgress, signal });
    },
    watch,
    jobs: () => call('/api/designs/jobs?active=1'),
    async coverage([lng, lat]) {
      if (!account.user) return null;
      try { return await call(`/api/coverage?lng=${lng}&lat=${lat}`); } catch { return null; }
    },
  };
}
