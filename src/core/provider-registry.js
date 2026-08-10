import { netflixProvider } from '../providers/netflix/index.js';

const providers = new Map([
  [netflixProvider.id, netflixProvider]
]);

export function getProvider(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function listProviders() {
  return [...providers.values()].map(({ id, label, permissionOrigin }) => ({ id, label, permissionOrigin }));
}
