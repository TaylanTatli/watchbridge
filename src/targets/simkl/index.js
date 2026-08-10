import { postJson } from '../../core/http.js';
import { normalizeIds } from '../../core/types.js';
import { resolveWatchEvent } from './resolver.js';

const API = 'https://api.simkl.com';

export function toSimklWatchedAt(event) {
  const value = event?.watchedAt;
  let date;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('WatchEvent watchedAt must be a finite timestamp.');
    const unit = event.metadata?.watchedAtUnit;
    if (unit && unit !== 'unix_seconds' && unit !== 'unix_milliseconds') {
      throw new Error(`Unsupported WatchEvent watchedAt unit: ${unit}`);
    }
    // Legacy queued Netflix events predate watchedAtUnit and store Unix seconds.
    date = new Date(unit === 'unix_milliseconds' ? value : value * 1000);
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value);
  } else {
    throw new Error('WatchEvent watchedAt is required for Simkl history.');
  }

  if (!Number.isFinite(date.getTime())) throw new Error('WatchEvent watchedAt is not a valid timestamp.');
  return date.toISOString();
}

export function toPayload(event, identity = null) {
  const ids = normalizeIds(identity?.ids || event.ids || { netflix: event.sourceId });
  const watchedAt = toSimklWatchedAt(event);
  if (event.type === 'movie') {
    return {
      movies: [{
        watched_at: watchedAt,
        country: event.country || '',
        ids
      }]
    };
  }

  if (identity?.ids?.simkl && event.season && event.episode) {
    if (identity.type === 'anime' && identity.episodeNumbering !== 'season_episode') {
      throw new Error('Resolved anime requires an explicit supported episode numbering scheme.');
    }
    const show = {
      ids,
      seasons: [{
        number: event.season,
        episodes: [{ number: event.episode, watched_at: watchedAt }]
      }]
    };
    if (identity.type === 'anime') show.use_tvdb_anime_seasons = true;
    return {
      shows: [show]
    };
  }

  return {
    episodes: [{
      watched_at: watchedAt,
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
