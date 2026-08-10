import { getJson } from '../../core/http.js';
import { normalizeIds } from '../../core/types.js';

const LOOKUP_ORDER = Object.freeze([
  'simkl', 'imdb', 'tmdb', 'tvdb', 'mal', 'anidb', 'anilist', 'kitsu',
  'netflix', 'crunchyroll', 'hulu', 'letterboxd', 'traktslug'
]);

function appParams(clientId) {
  const version = chrome.runtime.getManifest().version;
  return new URLSearchParams({
    client_id: clientId,
    'app-name': 'watchbridge',
    'app-version': version
  });
}

async function lookupId(key, value, credentials) {
  if (key === 'title') {
    const year = Number(credentials.lookupYear);
    const query = Number.isInteger(year) && year > 0 ? `${value} ${year}` : value;
    const types = credentials.lookupType === 'movie' ? ['movie'] : ['tv', 'anime'];
    const results = [];
    for (const type of types) {
      const params = appParams(credentials.clientId);
      params.set('q', query);
      params.set('limit', '10');
      params.set('extended', 'full');
      const found = await getJson(`https://api.simkl.com/search/${type}?${params}`, {
        'simkl-api-key': credentials.clientId
      });
      for (const item of Array.isArray(found) ? found : []) {
        results.push({
          ...item,
          type: type === 'movie' ? 'movie' : type,
          ids: { ...item.ids, simkl: item.ids?.simkl ?? item.ids?.simkl_id }
        });
      }
    }
    return results;
  }
  const params = appParams(credentials.clientId);
  params.set(key, value);
  const type = credentials.lookupType;
  if (key === 'tmdb' && type) params.set('type', type);
  return getJson(`https://api.simkl.com/search/id?${params}`, {
    'simkl-api-key': credentials.clientId
  });
}

export function buildResolutionCandidates(event) {
  const ids = normalizeIds(event.ids);
  const candidates = [];
  for (const key of LOOKUP_ORDER) {
    if (ids[key] === undefined || key === 'simkl') continue;
    candidates.push({ key, value: ids[key], role: 'item' });
  }

  const providerKey = event.source;
  const seriesId = event.metadata?.[providerKey]?.seriesId;
  if (event.type === 'episode' && LOOKUP_ORDER.includes(providerKey) && seriesId && String(seriesId) !== ids[providerKey]) {
    candidates.push({ key: providerKey, value: String(seriesId), role: 'series' });
  }
  const resolution = event.metadata?.resolution;
  if (resolution?.requireUniqueMatch && resolution.canonicalTitle) {
    candidates.push({ key: 'title', value: String(resolution.canonicalTitle), role: 'canonical' });
  }
  return candidates;
}

function compatibleType(event, candidate) {
  if (event.type === 'movie') return candidate.type === 'movie';
  return candidate.type === 'tv' || candidate.type === 'anime';
}

function identityRejection(event, candidate) {
  if (!compatibleType(event, candidate)) return 'type_mismatch';
  if (event.type === 'episode' && (!event.season || !event.episode)) return 'missing_episode_coordinates';
  if (candidate.type === 'anime' && event.metadata?.episodeNumbering !== 'season_episode') {
    return 'unsupported_episode_numbering';
  }
  return '';
}

function normalizedTitle(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function canonicalTitleRejection(candidate, result, requestedYear) {
  const titles = [result?.title, result?.title_en, result?.title_romaji, ...(result?.all_titles || [])];
  if (!titles.some(title => normalizedTitle(title) === normalizedTitle(candidate.value))) return 'title_mismatch';
  const year = Number(requestedYear);
  if (Number.isInteger(year) && year > 0 && Number(result?.year) !== year) return 'year_mismatch';
  return '';
}

export function selectResolvedIdentity(event, candidate, strategy) {
  const simkl = Number(candidate?.ids?.simkl ?? candidate?.ids?.simkl_id);
  if (!Number.isSafeInteger(simkl) || simkl <= 0) return null;
  if (identityRejection(event, candidate)) return null;

  return {
    type: candidate.type,
    title: candidate.title || '',
    year: Number(candidate.year) || null,
    season: event.season,
    episode: event.episode,
    episodeNumbering: event.metadata?.episodeNumbering || null,
    ids: { simkl },
    strategy
  };
}

export async function resolveWatchEvent(event, credentials, options = {}) {
  const attempts = [{
    strategy: 'sync_history_primary',
    outcome: 'not_found',
    ids: normalizeIds(event.ids)
  }];

  const existingSimkl = Number(event.ids?.simkl);
  if (Number.isSafeInteger(existingSimkl) && existingSimkl > 0) {
    const identity = selectResolvedIdentity(event, {
      type: event.type === 'movie' ? 'movie' : 'tv',
      ids: { simkl: existingSimkl }
    }, 'existing_simkl_id');
    if (identity) return { identity, attempts, reason: '' };
  }

  const lookup = options.lookup || lookupId;
  for (const candidate of buildResolutionCandidates(event)) {
    const strategy = `${candidate.role}_${candidate.key}_lookup`;
    const lookupCredentials = {
      ...credentials,
      lookupType: event.type === 'movie' ? 'movie' : 'show',
      lookupYear: event.metadata?.resolution?.year || null
    };
    const results = await lookup(candidate.key, candidate.value, lookupCredentials);
    if (!Array.isArray(results) || results.length === 0) {
      attempts.push({ strategy, outcome: 'not_found', id: candidate.value });
      continue;
    }
    const compatibleResults = candidate.key === 'title'
      ? results.filter(result => (
        compatibleType(event, result)
        && !canonicalTitleRejection(candidate, result, lookupCredentials.lookupYear)
      ))
      : results;
    if (compatibleResults.length !== 1) {
      attempts.push({
        strategy,
        outcome: compatibleResults.length ? 'ambiguous' : (results.length ? 'title_mismatch' : 'not_found'),
        id: candidate.value,
        candidates: compatibleResults.length
      });
      continue;
    }

    const identity = selectResolvedIdentity(event, compatibleResults[0], strategy);
    if (!identity) {
      attempts.push({
        strategy,
        outcome: identityRejection(event, compatibleResults[0]) || 'invalid_canonical_identity',
        id: candidate.value,
        resolvedType: compatibleResults[0]?.type || ''
      });
      continue;
    }
    attempts.push({ strategy, outcome: 'resolved', id: candidate.value, simkl: identity.ids.simkl });
    return { identity, attempts, reason: '' };
  }

  return {
    identity: null,
    attempts,
    reason: event.type === 'episode' && (!event.season || !event.episode)
      ? 'No unique stable identity with provider season/episode coordinates was available.'
      : 'No stable ID or canonical title resolved uniquely to a compatible Simkl record.'
  };
}
