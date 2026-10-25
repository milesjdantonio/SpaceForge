// Resume observation after reload. Accepted tasks continue on the server independently.
export function createGenerationObserver({ api, auth, onSaved, onFailed }) {
  let observing = null;
  return {
    stop() { observing?.abort(); observing = null; },
    async resume(uid) {
      observing?.abort();
      const controller = observing = new AbortController();
      const current = () => !controller.signal.aborted && auth.user?.uid === uid;
      try {
        const page = await api.jobs();
        if (!current()) return;
        for (const task of page.items.filter((j) => ['queued', 'running'].includes(j.status))) {
          api.watch(task.jobId, { signal: controller.signal }).then(({ building }) => {
            if (current()) onSaved(building);
          }).catch((error) => { if (current() && error.code === 'job-failed') onFailed(task); });
        }
      } catch { /* Saved buildings remain usable when job status is temporarily unavailable. */ }
    },
  };
}
