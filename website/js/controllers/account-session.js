// Account changes invalidate private state before restoring the next account.
export function createAccountSession({ auth, store, app, resetView, restoreScene, panel, openSites, generationObserver }) {
  let previousUser;
  function accountChanged(user) {
    const uid = user?.uid ?? null;
    if (uid === previousUser) return;
    if (previousUser) {
      generationObserver.stop();
      store.set(`designs:${previousUser}`, []);
      store.set(`sites:${previousUser}`, []);
      store.set(`builder:${previousUser}`, null);
      store.set(`lastForm:${previousUser}`, null);
      app.generation?.abort();
      resetView();
    }
    previousUser = uid;
    if (uid) {
      // Observe accepted work before listing buildings. A completion between the
      // two reads is then covered either by its watcher or by scene restoration.
      Promise.resolve(generationObserver.resume(uid)).then(() => {
        if (auth.user?.uid === uid) restoreScene(uid);
      });
    }
    if (panel.dataset.view === 'sites' && !panel.hidden) openSites();
  }

  const unsubscribe = auth.onChange(accountChanged);
  auth.ready.then(() => accountChanged(auth.user));
  return unsubscribe;
}
