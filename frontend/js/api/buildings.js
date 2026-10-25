import { createAccountRequest } from './account.js';
import { config } from '../config.js';
import { auth } from '../auth.js';

export function createBuildingClient({ baseUrl = config.storageBaseUrl, account = auth, fetcher = globalThis.fetch } = {}) {
  const call = createAccountRequest({ baseUrl, account, fetcher });
  return {
    list: (offset = 0) => call(`/api/buildings?limit=20&offset=${offset}`),
    get: (id) => call(`/api/buildings/${encodeURIComponent(id)}`),
    save: ({ id, name, data, project_id }) => call(id ? `/api/buildings/${encodeURIComponent(id)}` : '/api/buildings', { method: id ? 'PUT' : 'POST', body: { name, data, ...(project_id ? { project_id } : {}) } }),
    remove: (id) => call(`/api/buildings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    assignProject: (id, project_id) => call(`/api/buildings/${encodeURIComponent(id)}/project`, { method: 'PUT', body: { project_id } }),
  };
}

export const buildings = createBuildingClient();
