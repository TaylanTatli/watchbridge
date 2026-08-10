import { netflixProvider } from '../providers/netflix/index.js';
import { crunchyrollProvider } from '../providers/crunchyroll/index.js';
import { primeVideoProvider } from '../providers/primevideo/index.js';

const providers = new Map([
  [netflixProvider.id, netflixProvider],
  [crunchyrollProvider.id, crunchyrollProvider],
  [primeVideoProvider.id, primeVideoProvider]
]);

export function getProvider(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function listProviders() {
  return [...providers.values()].map(({ id, label, permissionOrigin, permissionOrigins, usesWatchedThreshold = true, capabilities, siteAdapter }) => ({
    id,
    label,
    permissionOrigin,
    permissionOrigins: permissionOrigins ? [...permissionOrigins] : [permissionOrigin],
    usesWatchedThreshold,
    capabilities: { ...capabilities },
    siteAdapter: siteAdapter ? structuredClone(siteAdapter) : null
  }));
}
