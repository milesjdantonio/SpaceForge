import { savedDocument, readSavedBuilding } from '../lib/saved-building.js';
import { createBuildingSaver } from '../lib/building-saver.js';

export function createBuildingStorage({ app, auth, buildings, house, rememberScene, buildingName }) {
  const savers = new Map();
  let saving = null;
  async function persist(design, estimate, site, placement) {
    const uid = auth.user?.uid;
    const version = app.displayVersion;
    if (!uid) throw new Error('Sign in to save your building.');
    const known = app.savedBuilding;
    const id = known?.uid === uid && known?.designID === design.id ? known.id : null;
    let writer = id ? savers.get(id) : null;
    if (!writer && saving?.uid === uid && saving.version === version && saving.designID === design.id) writer = saving;
    if (!writer) {
      const accountVersion = app.sceneVersion;
      writer = { uid, version, designID: design.id, id, save: createBuildingSaver({
        id,
        save: (input) => buildings.save({ ...input, project_id: input.id ? undefined : input.project_id }),
        isCurrent: () => auth.user?.uid === uid && app.sceneVersion === accountVersion && !app.removedRecords.has(writer.id),
        onSaved: (result) => {
          writer.id = result.id;
          savers.set(result.id, writer);
          const document = readSavedBuilding(result);
          app.records.set(result.id, { record: result, document });
          if (app.currentDesignID === design.id && (app.displayVersion === version || app.savedBuilding?.id === result.id)) {
            app.savedBuilding = { id: result.id, uid, designID: design.id };
            house.remember(result.id);
          } else if (!house.entries.some((entry) => entry.id === result.id)) house.add(result.id, document.design, document.placement);
          app.sceneReady = true;
          rememberScene();
        },
      }) };
    }
    saving = writer;
    return writer.save({ name: (buildingName(design) ?? design.overview.title).slice(0, 120),
      project_id: site?.projectId, data: savedDocument({ design, estimate, site, placement }) });
  }

  function adopt(record) {
    const document = readSavedBuilding(record);
    app.records.set(record.id, { record, document });
    app.sceneReady = true;
    return document;
  }
  return { persist, adopt,
    pending: (designID, version) => saving?.uid === auth.user?.uid && saving.version === version && saving.designID === designID,
    forget: (id) => savers.delete(id),
    reset() { savers.clear(); saving = null; },
  };
}
