import { postJson } from '../../core/http.js';

const API = 'https://api.simkl.com';

function toPayload(event) {
  if (event.type === 'movie') {
    return {
      movies: [{
        watched_at: event.watchedAt,
        country: event.country || '',
        ids: { netflix: Number(event.sourceId) }
      }]
    };
  }

  return {
    episodes: [{
      watched_at: event.watchedAt,
      title_series: event.seriesTitle || '',
      title_episode: event.episodeTitle || event.title || '',
      country: event.country || '',
      ids: { netflix: Number(event.sourceId) }
    }]
  };
}

function notFoundCount(result) {
  const nf = result?.not_found;
  if (!nf) return 0;
  return ['movies', 'episodes', 'shows', 'anime'].reduce((sum, key) => sum + (Array.isArray(nf[key]) ? nf[key].length : 0), 0);
}

export async function sendWatchEvent(event, credentials) {
  if (!credentials?.clientId || !credentials?.accessToken) throw new Error('Simkl is not connected.');
  const version = chrome.runtime.getManifest().version;
  const url = `${API}/sync/history?app-name=watchbridge&app-version=${encodeURIComponent(version)}`;
  const result = await postJson(url, toPayload(event), {
    Authorization: `Bearer ${credentials.accessToken}`,
    'simkl-api-key': credentials.clientId
  });

  return { result, matched: notFoundCount(result) === 0 };
}
