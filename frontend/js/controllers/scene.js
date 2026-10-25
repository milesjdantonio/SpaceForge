import { loadSavedScene, sceneCamera } from '../lib/saved-scene.js';

export function createSceneController({ app, auth, store, map, house, buildings, showDesign, clearLands, globePadding, stopSpin, intro, setMode, toast, openSites, location }) {
  // ---- restore the account's saved scene ----------------------------------------------------------
  function remember() {
    const uid = auth.user?.uid;
    if (!uid || !app.sceneReady) return;
    const center = map.getCenter();
    store.set(`scene:${uid}`, {
      selectedID: house.design ? app.savedBuilding?.id ?? null : null,
      selected: house.selected,
      mode: app.mode === 'globe' ? 'globe' : 'map',
      camera: { center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
    });
  }

  function open(id, options = {}) {
    const item = app.records.get(id);
    if (!item) return;
    // A house may have moved since its last response arrived; use its live placement.
    const placement = house.entries.find((entry) => entry.id === id)?.placement ?? item.document.placement;
    const { design, estimate } = item.document;
    showDesign(design, estimate, { ...item.document, placement, selected: true, ...options,
      savedBuilding: { id, uid: auth.user.uid, designID: design.id } });
  }

  async function restore(uid) {
    const sceneVersion = ++app.sceneVersion;
    const displayVersion = app.displayVersion, navigationVersion = app.navigationVersion;
    const previous = store.get(`scene:${uid}`, null);
    const current = () => auth.user?.uid === uid && app.sceneVersion === sceneVersion;
    try {
      const { records, skipped } = await loadSavedScene({ client: buildings, isCurrent: current,
        onRecord: (record, document) => {
          if (app.records.has(record.id) || app.removedRecords.has(record.id)) return; // Preserve edits/deletions made during loading.
          house.add(record.id, document.design, document.placement);
          app.records.set(record.id, { record, document });
        },
      });
      if (!current()) return;
      app.sceneReady = true;
      clearLands();
      if (app.displayVersion === displayVersion && app.navigationVersion === navigationVersion && app.mode === 'globe' && !location.hash) {
        const camera = sceneCamera(previous);
        const newest = records.filter(({ record }) => app.records.has(record.id))
          .sort((a, b) => b.record.created_at.localeCompare(a.record.created_at))[0];
        const id = app.records.has(previous?.selectedID) ? previous.selectedID : newest?.record.id;
        if (camera && previous.mode === 'globe') {
          map.jumpTo({ ...camera, padding: globePadding() });
        } else if (id) {
          open(id, { camera, animate: false, selected: previous?.selected === true });
        } else if (camera) {
          stopSpin(); intro.hidden = true; setMode('explore');
          map.jumpTo({ ...camera, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
        }
      }
      if (skipped) toast(`${skipped} saved building${skipped === 1 ? '' : 's'} couldn’t be drawn. The rest are on the map.`, { kind: 'error', action: { label: 'Open My Builds', run: () => openSites() } });
    } catch (error) {
      if (current()) toast('Your saved buildings couldn’t be loaded right now.', { kind: 'error', action: { label: 'Try again', run: () => restore(uid) } });
    }
  }

  return { remember, open, restore };
}
