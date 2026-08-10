import { getSimkl, getWatchStateCache, saveWatchStateCache } from './storage.js';
import { simklTarget } from '../targets/simkl/index.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;
const MAX_BATCH_SIZE = 100;
const MAX_VISIBLE_ITEMS = 500;

function normalizedItems(provider, items) {
  const unique = new Map();
  for (const item of items || []) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    const kind = item.kind === 'episode' ? 'episode' : 'title';
    unique.set(`${id}:${kind}`, { id, kind, ids: { [provider]: id } });
  }
  return [...unique.values()].slice(0, MAX_VISIBLE_ITEMS);
}

function cacheKey(provider, item) {
  return `${provider}:${item.id}:${item.kind}`;
}

export async function getWatchStates(provider, items, now = Date.now()) {
  const simkl = await getSimkl();
  if (!simkl.clientId || !simkl.accessToken) return { connected: false, states: {} };

  const requested = normalizedItems(provider, items);
  const cache = await getWatchStateCache();
  const states = {};
  const missing = [];
  for (const item of requested) {
    const key = cacheKey(provider, item);
    const cached = cache[key];
    if (cached && now - Number(cached.fetchedAt || 0) < CACHE_TTL_MS) {
      states[`${item.id}:${item.kind}`] = Boolean(cached.watched);
    } else {
      missing.push(item);
    }
  }

  if (missing.length) {
    for (let offset = 0; offset < missing.length; offset += MAX_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + MAX_BATCH_SIZE);
      const results = await simklTarget.getWatchStates(batch, simkl);
      results.forEach((result, index) => {
        const item = batch[index];
        if (!item) return;
        states[`${item.id}:${item.kind}`] = Boolean(result.watched);
        cache[cacheKey(provider, item)] = {
          watched: Boolean(result.watched),
          resolved: Boolean(result.resolved),
          fetchedAt: now
        };
      });
    }
    const entries = Object.entries(cache).sort((left, right) => (
      Number(right[1]?.fetchedAt || 0) - Number(left[1]?.fetchedAt || 0)
    )).slice(0, MAX_CACHE_ENTRIES);
    await saveWatchStateCache(Object.fromEntries(entries));
  }

  return { connected: true, states };
}

export async function rememberSyncedWatch(provider, providerId, eventType, now = Date.now()) {
  const id = String(providerId || '').trim();
  if (!id) return;
  const cache = await getWatchStateCache();
  const kind = eventType === 'episode' ? 'episode' : 'title';
  cache[cacheKey(provider, { id, kind })] = { watched: true, resolved: true, fetchedAt: now };
  await saveWatchStateCache(cache);
}

export async function invalidateWatchStateCache(provider = '') {
  if (!provider) return saveWatchStateCache({});
  const cache = await getWatchStateCache();
  for (const key of Object.keys(cache)) {
    if (key.startsWith(`${provider}:`)) delete cache[key];
  }
  return saveWatchStateCache(cache);
}
