import { fetchWithTimeout } from '../../core/http.js';
import { createWatchEvent } from '../../core/types.js';

const ROOT = 'https://www.crunchyroll.com';
const HISTORY_PAGE = `${ROOT}/home/history`;
const TOKEN_ENDPOINT = `${ROOT}/auth/v1/token`;
const PROFILES_ENDPOINT = `${ROOT}/accounts/v1/me/multiprofile`;
const PAGE_SIZE = 100;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function responseItems(body) {
  if (Array.isArray(body)) return body;
  const items = body?.items ?? body?.data?.items ?? body?.data ?? body?.result?.items;
  return Array.isArray(items) ? items : null;
}

async function readResponse(response) {
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`Crunchyroll request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function clientIdFromPage(html) {
  const match = html.match(/accountAuthClientId["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (!match) throw new Error('Could not discover Crunchyroll web session configuration. Crunchyroll may have changed its page format.');
  return match[1];
}

function randomDeviceId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable.');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function normalizeProfiles(body) {
  const items = responseItems(body) || (Array.isArray(body?.profiles) ? body.profiles : []);
  return items.map(profile => {
    const id = profile.profile_id ?? profile.id ?? profile.username ?? '';
    return {
      id: String(id),
      name: String(profile.profile_name ?? profile.display_name ?? profile.username ?? id),
      selected: Boolean(profile.is_selected ?? profile.selected ?? profile.isSelected)
    };
  }).filter(profile => profile.id);
}

export function normalizeCrunchyrollItem(item) {
  const panel = item?.panel || item?.content || {};
  const metadata = panel.episode_metadata || item?.episode_metadata || {};
  const versions = Array.isArray(metadata.versions) ? metadata.versions : [];
  const originalVersion = versions.find(version => version?.original && version?.guid);
  const sourceId = String(originalVersion?.guid ?? item?.id ?? panel?.id ?? '').trim();
  const watchedAt = item?.date_played ?? item?.watched_at ?? item?.last_watched_at;
  if (!sourceId || !watchedAt || !Number.isFinite(Date.parse(watchedAt))) return null;

  const durationSeconds = Number(metadata.duration_ms ?? panel.duration_ms ?? 0) / 1000;
  const playhead = Number(item?.playhead ?? item?.playhead_seconds ?? -1);
  const progress = item?.fully_watched === true
    ? 100
    : durationSeconds > 0 && playhead >= 0 ? playhead * 100 / durationSeconds : null;
  const season = positiveInteger(metadata.season_display_number ?? metadata.season_number);
  const episode = positiveInteger(metadata.episode_number);

  return createWatchEvent({
    source: 'crunchyroll',
    sourceId,
    type: 'episode',
    title: metadata.series_title || panel.title || '',
    seriesTitle: metadata.series_title || '',
    episodeTitle: panel.title || metadata.episode_title || '',
    season,
    episode,
    watchedAt,
    watchedAtMs: Date.parse(watchedAt),
    progress,
    ids: { crunchyroll: sourceId },
    metadata: {
      watchedAtUnit: 'iso_8601',
      episodeNumbering: season && episode ? 'season_episode' : null,
      crunchyroll: {
        seriesId: String(metadata.series_id || ''),
        seasonId: String(metadata.season_id || ''),
        seriesSlug: String(metadata.series_slug_title || '')
      }
    }
  });
}

export function createCrunchyrollClient(fetchImpl = fetch) {
  async function openSession() {
    const pageResponse = await fetchWithTimeout(HISTORY_PAGE, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html' }
    }, 20000, fetchImpl);
    const html = await pageResponse.text();
    if (pageResponse.status === 401 || /log in|login-form/i.test(html)) {
      throw new Error('Crunchyroll is not logged in in this browser profile.');
    }
    if (pageResponse.status === 403) {
      throw new Error('Crunchyroll rejected the browser session (HTTP 403). Open crunchyroll.com in this Chrome profile, sign in or refresh the site, then try again.');
    }
    if (!pageResponse.ok) throw new Error(`Crunchyroll history page failed (HTTP ${pageResponse.status}).`);

    const clientId = clientIdFromPage(html);
    const tokenResponse = await fetchWithTimeout(TOKEN_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${btoa(`${clientId}:`)}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: new URLSearchParams({
        grant_type: 'etp_rt_cookie',
        device_id: randomDeviceId(),
        device_type: 'Chrome on Desktop'
      })
    }, 20000, fetchImpl);
    const tokenBody = await readResponse(tokenResponse);
    const accessToken = tokenBody.access_token;
    const accountId = tokenBody.account_id ?? tokenBody.accountId;
    if (!accessToken || !accountId) throw new Error('Crunchyroll session token response format changed.');

    const profilesResponse = await fetchWithTimeout(PROFILES_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
    }, 20000, fetchImpl);
    const profiles = normalizeProfiles(await readResponse(profilesResponse));
    return { accessToken, accountId: String(accountId), profiles };
  }

  async function fetchHistoryPage(session, page) {
    const url = `${ROOT}/content/v1/watch-history/${encodeURIComponent(session.accountId)}?page_size=${PAGE_SIZE}&page=${page}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` }
    }, 20000, fetchImpl);
    const body = await readResponse(response);
    const items = responseItems(body);
    if (!items) throw new Error('Crunchyroll watch-history response format changed.');
    return items;
  }

  return { openSession, fetchHistoryPage };
}

async function listProfiles({ client = createCrunchyrollClient() } = {}) {
  const session = await client.openSession();
  return session.profiles;
}

async function fetchEvents({ afterMs = 0, threshold = 70, maxPages = 500, profileId = '', client = createCrunchyrollClient() } = {}) {
  const session = await client.openSession();
  const selected = session.profiles.find(profile => profile.selected);
  if (profileId && (!selected || selected.id !== profileId)) {
    throw new Error('The selected WatchBridge Crunchyroll profile is not active. Switch to that profile on Crunchyroll and sync again.');
  }

  const events = [];
  let newestMs = 0;
  let scanned = 0;
  let skippedUnderThreshold = 0;
  let reachedCheckpoint = false;
  let previousFirstId = '';

  for (let page = 1; page <= maxPages; page++) {
    const items = await client.fetchHistoryPage(session, page);
    if (!items.length) break;
    const firstId = String(items[0]?.id || items[0]?.panel?.id || '');
    if (firstId && firstId === previousFirstId) break;
    previousFirstId = firstId;

    for (const item of items) {
      const event = normalizeCrunchyrollItem(item);
      if (!event) continue;
      newestMs = Math.max(newestMs, Number(event.watchedAtMs || 0));
      if (afterMs && event.watchedAtMs <= afterMs) {
        reachedCheckpoint = true;
        break;
      }
      scanned++;
      if (event.progress === null || event.progress < threshold) {
        skippedUnderThreshold++;
        continue;
      }
      events.push(event);
    }
    if (reachedCheckpoint || items.length < PAGE_SIZE) break;
  }

  return {
    events,
    newestMs,
    scanned,
    skippedUnderThreshold,
    profiles: session.profiles,
    selectedProfileId: selected?.id || ''
  };
}

export const crunchyrollProvider = Object.freeze({
  id: 'crunchyroll',
  label: 'Crunchyroll',
  permissionOrigin: 'https://www.crunchyroll.com/*',
  siteAdapter: Object.freeze({
    matches: ['https://www.crunchyroll.com/*'],
    js: ['src/site-adapters/crunchyroll/content.js', 'src/site-adapters/runtime.js'],
    css: ['src/site-adapters/crunchyroll/content.css']
  }),
  capabilities: Object.freeze({
    historyBackfill: true,
    incrementalHistory: true,
    currentPlaybackScrobble: false,
    siteDecoration: true
  }),
  fetchEvents,
  listProfiles
});
