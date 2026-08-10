const EXTERNAL_ID_KEYS = Object.freeze([
  'netflix', 'imdb', 'tmdb', 'tvdb', 'mal', 'anidb', 'anilist', 'kitsu',
  'crunchyroll', 'hulu', 'letterboxd', 'traktslug'
]);

export function normalizeIds(ids = {}) {
  const normalized = {};
  const simkl = Number(ids.simkl ?? ids.simkl_id);
  if (Number.isSafeInteger(simkl) && simkl > 0) normalized.simkl = simkl;

  for (const key of EXTERNAL_ID_KEYS) {
    const value = ids[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    normalized[key] = String(value).trim();
  }
  return normalized;
}

function optionalPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Normalized provider -> core event contract. watchedAt is the provider's real
 * timestamp; callers must not synthesize one for matching or deduplication.
 */
export function createWatchEvent(input) {
  if (!input?.source || !input?.sourceId) throw new Error('WatchEvent requires source and sourceId.');
  if (input.type !== 'movie' && input.type !== 'episode') throw new Error('WatchEvent type must be movie or episode.');
  if (input.watchedAt === undefined || input.watchedAt === null || input.watchedAt === '') {
    throw new Error('WatchEvent requires the provider watched timestamp.');
  }

  return {
    source: String(input.source),
    sourceId: String(input.sourceId),
    type: input.type,
    title: String(input.title || ''),
    seriesTitle: String(input.seriesTitle || ''),
    episodeTitle: String(input.episodeTitle || ''),
    season: optionalPositiveInteger(input.season),
    episode: optionalPositiveInteger(input.episode),
    watchedAt: input.watchedAt,
    watchedAtMs: Number(input.watchedAtMs || 0) || null,
    progress: Number.isFinite(Number(input.progress)) ? Number(input.progress) : null,
    country: String(input.country || ''),
    ids: normalizeIds(input.ids),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  };
}

export function watchEventKey(event) {
  if (!event?.source || !event?.sourceId || event.watchedAt === undefined || event.watchedAt === null) {
    throw new Error('Cannot create an event key without source, sourceId, and watchedAt.');
  }
  return `${event.source}:${event.sourceId}:${event.watchedAt}`;
}

export function compactWatchEvent(event) {
  const { raw: _raw, ...rest } = event;
  return { ...rest, key: watchEventKey(event), retries: 0 };
}
