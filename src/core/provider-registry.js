import { netflixProvider } from '../providers/netflix/index.js';
import { crunchyrollProvider } from '../providers/crunchyroll/index.js';

const providers = new Map([
  [netflixProvider.id, netflixProvider],
  [crunchyrollProvider.id, crunchyrollProvider]
]);

export function getProvider(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function listProviders() {
  return [...providers.values()].map(({ id, label, permissionOrigin, capabilities, siteAdapter }) => ({
    id,
    label,
    permissionOrigin,
    capabilities: { ...capabilities },
    siteAdapter: siteAdapter ? structuredClone(siteAdapter) : null
  }));
}
