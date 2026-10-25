import { readSavedBuilding } from '../lib/saved-building.js';
import { measure } from '../lib/place.js';
import { renderSites } from '../panels/lists.js';

export function createLibraryController({ app, auth, buildings, projects, storage, house, map, outliner, panel, store, scopeKey, account, leaveGlobe, closePanel, openPanel, openBrief, openDesignFile, openSceneBuilding, clearLands, setMode, rememberScene, toast }) {
  async function open() {
    await auth.ready;
    const version = ++app.libraryVersion;
    leaveGlobe();
    const uid = auth.user?.uid ?? null;
    let items = [], projectItems = [], selectedProject = '', nextOffset = null, loading = !!uid, error = '';
    const current = () => auth.user?.uid === uid && version === app.libraryVersion;
    const render = () => renderSites(panel, {
      account: auth.user, buildings: items.filter((b) => !selectedProject || b.project_id === selectedProject), nextOffset, loading, error,
      projects: projectItems, projectID: selectedProject,
      onProjectChange: (id) => { selectedProject = id; render(); },
      onCreateProject: async () => {
        const name = prompt('Project name');
        if (!name?.trim()) return;
        try { const project = await projects.create(name.trim()); if (!current()) return; projectItems.unshift(project); render(); }
        catch (err) { if (current()) { error = err.message; render(); } }
      },
      onMoveBuilding: async (summary, projectID) => {
        const result = await buildings.assignProject(summary.id, projectID);
        if (!current()) return;
        storage.adopt(result);
        items = items.map((b) => b.id === result.id ? result : b);
        if (app.savedBuilding?.id === result.id && app.site) app.site.projectId = result.project_id;
        render();
      },
      sites: store.get(scopeKey('sites'), []),
      onOpen: (s) => {
        closePanel();
        app.site = s;
        outliner.load(s.ring);
        const c = measure(s.ring).centroid;
        map.flyTo({ center: c, zoom: 18, pitch: 55, duration: 3500, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
        map.once('moveend', () => openBrief());
      },
      onDelete: (s) => store.update(scopeKey('sites'), [], (list) => list.filter((x) => x.id !== s.id)),
      onOpenFile: (file) => openDesignFile(file),
      onSignIn: async () => { if (await account.require()) open(); },
      onOpenBuilding: async (summary) => {
        try {
          const record = await buildings.get(summary.id);
          const document = readSavedBuilding(record);
          if (auth.user?.uid !== uid) return;
          app.records.set(record.id, { record, document });
          app.sceneReady = true;
          openSceneBuilding(record.id);
        } catch (err) {
          toast(`“${summary.name}” couldn’t be opened. ${err.message || ''}`.trim(), { kind: 'error', action: { label: 'Back to My Builds', run: () => open() } });
        }
      },
      onDeleteBuilding: async (record) => {
        app.removedRecords.add(record.id);
        try { await buildings.remove(record.id); }
        catch (error) { if (auth.user?.uid === uid) app.removedRecords.delete(record.id); throw error; }
        if (auth.user?.uid !== uid) return;
        items = items.filter((item) => item.id !== record.id);
        storage.forget(record.id);
        house.remove(record.id); app.records.delete(record.id); clearLands();
        if (app.savedBuilding?.id === record.id) {
          app.savedBuilding = null; app.currentDesignID = null; ++app.displayVersion;
          outliner.clear(); setMode('explore');
        }
        rememberScene();
        toast('Building deleted.');
        if (!items.length && panel.dataset.view === 'sites') render();
      },
      onMore: () => load(nextOffset),
      onRetry: () => load(items.length ? nextOffset ?? 0 : 0),
    });
    async function load(offset = 0) {
      if (version !== app.libraryVersion) return;
      loading = true; error = ''; render();
      try {
        const page = await buildings.list(offset);
        if (auth.user?.uid !== uid || panel.dataset.view !== 'sites' || version !== app.libraryVersion) return;
        items = offset ? [...items, ...page.items] : page.items;
        nextOffset = page.next_offset;
      } catch (err) { error = `Your saved buildings couldn’t be loaded. ${err.message || ''}`.trim(); }
      finally { loading = false; if ((auth.user?.uid ?? null) === uid && panel.dataset.view === 'sites' && version === app.libraryVersion) render(); }
    }
    openPanel(render, 'sites');
    if (uid) {
      try {
        let offset = 0;
        do {
          const page = await projects.list(offset);
          if (!current()) return;
          projectItems.push(...page.items);
          offset = page.next_offset;
        } while (offset != null);
      } catch (err) { if (current()) { error = err.message; loading = false; render(); } return; }
      await load();
    }
  }

  return { open };
}
