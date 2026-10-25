import { createAccountRequest } from './account.js';

export function createProjectClient(options) {
  const call = createAccountRequest(options);
  return {
    list: (offset = 0) => call(`/api/projects?offset=${offset}`),
    get: (id) => call(`/api/projects/${encodeURIComponent(id)}`),
    create: (name, land = {}) => call('/api/projects', { method: 'POST', body: { name, land } }),
    update: (id, name, land) => call(`/api/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: { name, land } }),
    remove: (id) => call(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}
export const projects = createProjectClient();
