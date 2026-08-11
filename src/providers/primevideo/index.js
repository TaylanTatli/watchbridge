import { fetchWithTimeout } from '../../core/http.js';
import { getPrimeMetadataCache, savePrimeMetadataCache } from '../../core/storage.js';
import { createWatchEvent } from '../../core/types.js';

const ROOT = 'https://www.primevideo.com';
const HISTORY_PAGE = `${ROOT}/settings/watch-history`;
const HISTORY_API = `${ROOT}/api/getWatchHistorySettingsPage`;
const METADATA_API = 'https://atv-ps-eu.primevideo.com/cdp/lumina/playerChromeResources/v1';
// Prime's public browser application device type, not an account credential.
const WEB_DEVICE_TYPE_ID = 'AOAGZA014O5RE';
const MAX_CACHE_ENTRIES = 3000;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseJsonScripts(html) {
  const values = [];
  for (const match of String(html || '').matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { values.push(JSON.parse(match[1])); } catch {}
  }
  return values;
}

function findWatchHistoryContent(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (value.widgetType === 'watch-history') {
    const content = value.content?.content ?? value.content;
    if (content && Array.isArray(content.titles)) return content;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'actions') continue;
    const found = findWatchHistoryContent(child, seen);
    if (found) return found;
  }
  return null;
}

function findStringValue(value, wantedKey, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === wantedKey && typeof child === 'string' && child.trim()) return child.trim();
    const found = findStringValue(child, wantedKey, seen);
    if (found) return found;
  }
  return '';
}

export function extractPrimeDetailId(href) {
  const match = String(href || '').match(/\/detail\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function cleanHistoryTitle(item) {
  return {
    gti: String(item?.gti || '').trim(),
    time: Number(item?.time),
    titleType: String(item?.titleType || '').toLowerCase(),
    title: {
      href: String(item?.title?.href || ''),
      text: String(item?.title?.text || '')
    },
    children: Array.isArray(item?.children) ? item.children.map(cleanHistoryTitle) : []
  };
}

function flattenHistoryTitles(nodes, output = []) {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    const item = cleanHistoryTitle(raw);
    if (item.titleType === 'movie' || item.titleType === 'episode') output.push(item);
    else if (item.titleType === 'season') {
      for (const child of item.children) if (child.titleType === 'episode') output.push(child);
    } else if (item.children.length) flattenHistoryTitles(item.children, output);
    if (Array.isArray(raw?.titles)) flattenHistoryTitles(raw.titles, output);
  }
  return output;
}

export function parsePrimeHistoryResponse(body) {
  const content = findWatchHistoryContent(body);
  if (!content) throw new Error('Prime Video watch-history response format changed.');
  return {
    items: flattenHistoryTitles(content.titles),
    nextToken: typeof content.nextToken === 'string' && content.nextToken ? content.nextToken : null
  };
}

export function normalizePrimeCatalogResponse(body, gti, detailId = '') {
  const catalog = body?.resources?.catalogMetadataV2?.catalog;
  if (!catalog || typeof catalog !== 'object') return null;
  const type = String(catalog.type || '').toUpperCase();
  if (type !== 'MOVIE' && type !== 'EPISODE') return null;
  const title = String(catalog.title || '').trim();
  const seriesTitle = String(catalog.seriesTitle || '').trim();
  const season = positiveInteger(catalog.seasonNumber);
  const episode = positiveInteger(catalog.episodeNumber);
  if (!title || (type === 'EPISODE' && (!seriesTitle || !season || !episode))) return null;
  return {
    gti: String(gti),
    detailId: String(detailId || ''),
    type: type.toLowerCase(),
    title,
    seriesTitle,
    season,
    episode,
    year: positiveInteger(catalog.releaseYear ?? catalog.year),
    originalLanguages: Array.isArray(catalog.originalLanguages)
      ? catalog.originalLanguages.map(String).slice(0, 10)
      : [],
    fetchedAt: Date.now()
  };
}

export function normalizePrimeHistoryItem(item, canonical = null) {
  const gti = String(item?.gti || '').trim();
  const detailId = extractPrimeDetailId(item?.title?.href);
  const sourceId = gti || detailId;
  const watchedAt = Number(item?.time);
  const historyType = String(item?.titleType || '').toLowerCase();
  if (!['movie', 'episode'].includes(historyType)) return null;
  const type = historyType;
  if (canonical?.type !== type) canonical = null;
  if (!sourceId || !Number.isFinite(watchedAt) || watchedAt <= 0) return null;

  const canonicalTitle = type === 'movie' ? canonical?.title : canonical?.seriesTitle;
  return createWatchEvent({
    source: 'primevideo',
    sourceId,
    type,
    title: canonicalTitle || canonical?.title || item?.title?.text || '',
    seriesTitle: type === 'episode' ? canonical?.seriesTitle || '' : '',
    episodeTitle: type === 'episode' ? canonical?.title || item?.title?.text || '' : '',
    season: type === 'episode' ? canonical?.season : null,
    episode: type === 'episode' ? canonical?.episode : null,
    watchedAt,
    watchedAtMs: watchedAt,
    progress: null,
    ids: {},
    metadata: {
      watchedAtUnit: 'unix_milliseconds',
      episodeNumbering: type === 'episode' && canonical?.season && canonical?.episode ? 'season_episode' : null,
      resolution: {
        requireUniqueMatch: true,
        canonicalTitle: String(canonicalTitle || ''),
        canonicalLocale: canonical ? 'en_US' : '',
        year: positiveInteger(canonical?.year)
      },
      primevideo: {
        gti,
        detailId,
        localizedTitle: String(item?.title?.text || ''),
        metadataSource: canonical ? 'catalogMetadataV2' : 'unavailable'
      }
    }
  });
}

function randomDeviceId() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable.');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function readJson(response, label) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (response.status === 401 || response.status === 403 || /\/auth-redirect|\/signin/i.test(response.url || '')) {
    throw new Error('Prime Video is not logged in in this browser profile.');
  }
  if (!response.ok) {
    const error = new Error(`${label} failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!body) throw new Error(`${label} returned malformed JSON.`);
  return body;
}

export function createPrimeVideoClient(fetchImpl = fetch) {
  let deviceId = '';
  let deviceTypeId = WEB_DEVICE_TYPE_ID;
  async function fetchHistoryPage(nextToken = undefined) {
    const url = new URL(HISTORY_API);
    if (nextToken !== undefined) url.searchParams.set('widgetArgs', JSON.stringify({ nextToken }));
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }
    }, 20000, fetchImpl);
    return parsePrimeHistoryResponse(await readJson(response, 'Prime Video watch history'));
  }

  async function openSession() {
    const response = await fetchWithTimeout(HISTORY_PAGE, {
      method: 'GET', credentials: 'include', headers: { Accept: 'text/html' }
    }, 20000, fetchImpl);
    const html = await response.text();
    if (response.status === 401 || response.status === 403 || /\/auth-redirect|\/signin/i.test(response.url || '')) {
      throw new Error('Prime Video is not logged in in this browser profile.');
    }
    if (!response.ok) throw new Error(`Prime Video watch-history page failed (HTTP ${response.status}).`);
    const pageData = parseJsonScripts(html);
    deviceId = pageData.map(value => findStringValue(value, 'deviceID')).find(Boolean) || deviceId;
    deviceTypeId = pageData.map(value => findStringValue(value, 'deviceTypeID')).find(Boolean) || deviceTypeId;
    const embedded = pageData.map(value => findWatchHistoryContent(value)).find(Boolean);
    return { firstPage: embedded ? parsePrimeHistoryResponse({ widgetType: 'watch-history', content: { content: embedded } }) : null };
  }

  async function fetchMetadata(gti, detailId = '') {
    const params = new URLSearchParams({
      entityId: gti,
      deviceID: deviceId || (deviceId = randomDeviceId()),
      deviceTypeID: deviceTypeId,
      firmware: '1',
      uxLocale: 'en_US',
      desiredResources: 'catalogMetadataV2'
    });
    const response = await fetchWithTimeout(`${METADATA_API}?${params}`, {
      method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }
    }, 20000, fetchImpl);
    const body = await readJson(response, 'Prime Video catalog metadata');
    return normalizePrimeCatalogResponse(body, gti, detailId);
  }

  return { openSession, fetchHistoryPage, fetchMetadata };
}

function pruneCache(cache) {
  const entries = Object.entries(cache).sort((a, b) => Number(b[1]?.fetchedAt || 0) - Number(a[1]?.fetchedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
}

async function fetchEvents({ afterMs = 0, maxPages = 500, client = createPrimeVideoClient() } = {}) {
  const session = await client.openSession();
  const cache = await getPrimeMetadataCache();
  const events = [];
  const seenTokens = new Set();
  let page = session.firstPage || await client.fetchHistoryPage();
  let newestMs = 0;
  let scanned = 0;
  let cacheChanged = false;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    if (!page || !Array.isArray(page.items)) throw new Error('Prime Video watch-history response format changed.');
    let pageHasCheckpointOverlap = false;
    for (const item of page.items) {
      const watchedAt = Number(item.time);
      if (!Number.isFinite(watchedAt) || watchedAt <= 0) continue;
      newestMs = Math.max(newestMs, watchedAt);
      if (!afterMs || watchedAt >= afterMs) pageHasCheckpointOverlap = true;
      // Include the checkpoint boundary. Local completedKeys suppress already
      // handled events, while distinct watches sharing the timestamp are kept.
      if (afterMs && watchedAt < afterMs) continue;
      scanned++;

      const gti = String(item.gti || '').trim();
      const detailId = extractPrimeDetailId(item.title?.href);
      let canonical = gti ? cache[gti] || null : null;
      if (canonical && canonical.type !== item.titleType) canonical = null;
      if (!canonical && gti) {
        try {
          canonical = await client.fetchMetadata(gti, detailId);
          if (canonical) {
            cache[gti] = canonical;
            cacheChanged = true;
          }
        } catch {}
      }
      const event = normalizePrimeHistoryItem(item, canonical);
      if (event) events.push(event);
    }

    if (cacheChanged) {
      await savePrimeMetadataCache(pruneCache(cache));
      cacheChanged = false;
    }

    if (afterMs && page.items.length && !pageHasCheckpointOverlap) break;
    const nextToken = page.nextToken;
    if (!nextToken) break;
    if (seenTokens.has(nextToken)) break;
    seenTokens.add(nextToken);
    page = await client.fetchHistoryPage(nextToken);
  }

  return { events, newestMs, scanned, skippedUnderThreshold: 0 };
}

export const primeVideoProvider = Object.freeze({
  id: 'primevideo',
  label: 'Prime Video',
  permissionOrigins: Object.freeze([
    'https://www.primevideo.com/*',
    'https://atv-ps-eu.primevideo.com/*'
  ]),
  usesWatchedThreshold: false,
  capabilities: Object.freeze({
    historyBackfill: true,
    incrementalHistory: true,
    currentPlaybackScrobble: false,
    siteDecoration: false
  }),
  fetchEvents
});
