import { postJson } from '../../core/http.js';
import { normalizeIds } from '../../core/types.js';
import { resolveWatchEvent } from './resolver.js';

const API = 'https://api.simkl.com';

export function toPayload(event, identity = null) {
  const ids = normalizeIds(identity?.ids || event.ids || { netflix: event.sourceId });
  if (event.type === 'movie') {
    return {
      movies: [{
        watched_at: event.watchedAt,
        country: event.country || '',
        ids
      }]
    };
  }

  if (identity?.ids?.simkl && event.season && event.episode) {
    return {
      shows: [{
        ids,
        seasons: [{
          number: event.season,
          episodes: [{ number: event.episode, watched_at: event.watchedAt }]
        }]
      }]
    };
  }

  return {
    episodes: [{
      watched_at: event.watchedAt,
      title_series: event.seriesTitle || '',
      title_episode: event.episodeTitle || event.title || '',
      country: event.country || '',
      ids
    }]
  };
}

function notFoundCount(result) {
  const nf = result?.not_found;
  if (!nf) return 0;
  return ['movies', 'episodes', 'shows', 'anime'].reduce((sum, key) => sum + (Array.isArray(nf[key]) ? nf[key].length : 0), 0);
}

export async function sendWatchEvent(event, credentials, identity = null) {
  if (!credentials?.clientId || !credentials?.accessToken) throw new Error('Simkl is not connected.');
  const version = chrome.runtime.getManifest().version;
  const url = `${API}/sync/history?app-name=watchbridge&app-version=${encodeURIComponent(version)}`;
  const result = await postJson(url, toPayload(event, identity), {
    Authorization: `Bearer ${credentials.accessToken}`,
    'simkl-api-key': credentials.clientId
  });

  return { result, matched: notFoundCount(result) === 0, notFoundCount: notFoundCount(result) };
}

export const simklTarget = Object.freeze({
  id: 'simkl',
  sendWatchEvent,
  resolveEvent: resolveWatchEvent
});
