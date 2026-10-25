import { readSavedBuilding } from './saved-building.js';

// Fetch every page, with a small number of full documents in flight at once.
// Old/deleted/invalid records do not prevent the other houses from appearing.
export async function loadSavedScene({ client, isCurrent, onRecord }) {
  const records = [];
  let offset = 0, skipped = 0;
  const check = () => {
    if (!isCurrent()) throw Object.assign(new Error('The signed-in account changed.'), { code: 'account-changed' });
  };
  for (;;) {
    check();
    const page = await client.list(offset);
    check();
    for (let i = 0; i < page.items.length; i += 4) {
      await Promise.all(page.items.slice(i, i + 4).map(async ({ id }) => {
        check();
        let record, document;
        try {
          record = await client.get(id);
          check();
          document = readSavedBuilding(record);
        } catch (error) {
          check();
          if (error.code === 'account-changed' || error.status === 401) throw error;
          skipped++; return;
        }
        check();
        records.push({ record, document });
        onRecord(record, document);
      }));
    }
    if (page.next_offset == null) break;
    if (!Number.isInteger(page.next_offset) || page.next_offset <= offset) throw new Error('Saved buildings returned an invalid page.');
    offset = page.next_offset;
  }
  return { records, skipped };
}

export function sceneCamera(value) {
  const camera = value?.camera;
  if (!camera || !Array.isArray(camera.center) || camera.center.length !== 2 || !camera.center.every(Number.isFinite)) return null;
  if (camera.center[0] < -180 || camera.center[0] > 180 || Math.abs(camera.center[1]) > 85) return null;
  if (![camera.zoom, camera.pitch, camera.bearing].every(Number.isFinite) || camera.zoom < 0 || camera.zoom > 22 || camera.pitch < 0 || camera.pitch > 75) return null;
  return { center: camera.center, zoom: camera.zoom, pitch: camera.pitch, bearing: camera.bearing };
}
