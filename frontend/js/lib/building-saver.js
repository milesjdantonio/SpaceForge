// One writer per building. Queue changes so a slower earlier response
// cannot overwrite a newer placement, and reuse the SQL ID returned by creation.
export function createBuildingSaver({ save, isCurrent, onSaved, id = null }) {
  let recordID = id;
  let tail = Promise.resolve();
  let latest = null;
  const assertCurrent = () => {
    if (!isCurrent()) throw Object.assign(new Error('The building or signed-in account changed. Please try again.'), { code: 'view-changed' });
  };

  return (input) => {
    const snapshot = structuredClone(input);
    const signature = JSON.stringify(snapshot);
    if (latest?.signature === signature) return latest.work;
    const entry = { signature };
    entry.work = tail.catch(() => {}).then(async () => {
      assertCurrent();
      const result = await save({ ...snapshot, id: recordID });
      assertCurrent();
      recordID = result.id;
      onSaved(result);
      return result;
    }).finally(() => { if (latest === entry) latest = null; });
    tail = entry.work;
    latest = entry;
    return entry.work;
  };
}
