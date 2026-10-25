// The TerraSim API client. Shapes are in contracts/FIELDS.md (request, design, estimate) and the
// endpoints in contracts/STORAGE.md.

import { config } from '../config.js';
import { store } from '../store.js';
import { auth } from '../auth.js';
import { createAccountRequest } from './account.js';
import { createDesignClient } from './generation.js';
const call = (path, options) => createAccountRequest()(`/api${path}`, options);

const sampleCache = {};
async function sample(name) {
  if (!sampleCache[name]) sampleCache[name] = fetch(new URL(`../../fixtures/mock-house/${name}.json`, import.meta.url)).then((r) => r.json());
  return sampleCache[name];
}

const designKey = () => auth.user ? `designs:${auth.user.uid}` : 'designs';
const localDesigns = () => store.get(designKey(), []);

export const api = {
  get connected() { return !!config.apiBaseUrl; },
  get baseUrl() { return config.apiBaseUrl; },

  ...createDesignClient(),

  // Keeps a received design in this browser (the newest 12), so it can be reopened.
  keepLocal(design, estimate) {
    store.update(designKey(), [], (list) => [{ design, estimate }, ...list.filter((x) => x.design?.id !== design.id)].slice(0, 12));
  },

  async design(id) {
    if (id === 'sample-0001') return sample('design');
    const local = localDesigns().find((s) => s.design?.id === id);
    if (local) return local.design;
    return call(`/designs/${encodeURIComponent(id)}`);
  },
  async estimate(id) {
    if (id === 'sample-0001') return sample('estimate');
    const local = localDesigns().find((s) => s.design?.id === id);
    if (local) return local.estimate;
    return call(`/designs/${encodeURIComponent(id)}/estimate`);
  },
};
