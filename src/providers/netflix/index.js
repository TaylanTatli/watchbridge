import { getText, postFormJson } from '../../core/http.js';
import { createWatchEvent } from '../../core/types.js';

const VIEWING_ACTIVITY = 'https://www.netflix.com/WiViewingActivity';
const HISTORY_ENDPOINT = 'https://www.netflix.com/api/aui/pathEvaluator/web/^2.0.0';
const PROGRESS_ENDPOINT = 'https://www.netflix.com/nq/website/memberapi/release/pathEvaluator?original_path=%2Fshakti%2Fmre%2FpathEvaluator';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getProfileGuid() {
  const html = await getText(VIEWING_ACTIVITY);
  if (/login-submit-button|\/Login\?nextpage=/i.test(html)) {
    throw new Error('Netflix is not logged in in this browser profile.');
  }

  const match = html.match(/"userGuid"\s*:\s*"([^"]+)"/i);
  if (!match) throw new Error('Could not find Netflix profile GUID. Netflix may have changed its page format.');
  return match[1];
}

async function fetchHistoryPage(guid, page) {
  const callPath = JSON.stringify(['aui', 'viewingActivity', page, 50]);
  const url = `${HISTORY_ENDPOINT}?method=call&callPath=${encodeURIComponent(callPath)}`;
  return postFormJson(
    url,
    { param: JSON.stringify({ guid }) },
    { 'x-netflix.request.routing': '{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}' }
  );
}

async function fetchProgress(ids) {
  if (!ids.length) return {};
  const raw = await postFormJson(PROGRESS_ENDPOINT, {
    path: JSON.stringify(['videos', ids.map(String), [
      'summary', 'runtime', 'bookmarkPosition', 'seasonNumber', 'episodeNumber'
    ]])
  });

  const result = {};
  const videos = raw?.jsonGraph?.videos || {};
  for (const id of ids.map(String)) {
    const video = videos[id];
    if (!video) continue;
    const summary = video.summary?.value || {};
    result[id] = {
      runtime: Number(video.runtime?.value || 0),
      bookmark: Number(video.bookmarkPosition?.value ?? -1),
      season: positiveInteger(video.seasonNumber?.value ?? summary.seasonNumber),
      episode: positiveInteger(video.episodeNumber?.value ?? summary.episodeNumber)
    };
  }
  return result;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalize(item, progress) {
  const runtime = Number(progress.runtime || 0);
  const bookmark = Number(progress.bookmark ?? -1);
  const percent = runtime > 0 && bookmark >= 0 ? (bookmark * 100 / runtime) : 0;
  const isMovie = !item.series;

  const sourceId = String(item.movieID);
  return createWatchEvent({
    source: 'netflix',
    sourceId,
    type: isMovie ? 'movie' : 'episode',
    title: item.title || item.episodeTitle || '',
    seriesTitle: item.seriesTitle || '',
    episodeTitle: item.episodeTitle || '',
    country: item.country || '',
    watchedAt: Math.round(Number(item.date) / 1000),
    watchedAtMs: Number(item.date),
    progress: percent,
    // Do not treat Netflix season/episode catalog IDs as ordinal numbers.
    season: positiveInteger(item.seasonNumber ?? progress.season),
    episode: positiveInteger(item.episodeNumber ?? progress.episode),
    ids: { netflix: sourceId },
    metadata: {
      netflix: {
        seriesId: item.series ? String(item.series) : '',
        localizedTitle: item.title || item.seriesTitle || ''
      }
    }
  });
}

async function fetchEvents({ afterMs = 0, threshold = 70, maxPages = 500 } = {}) {
  const guid = await getProfileGuid();
  const events = [];
  let newestMs = 0;
  let scanned = 0;
  let skippedUnderThreshold = 0;
  let lastFirstId = null;
  let reachedCheckpoint = false;

  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchHistoryPage(guid, page);
    const value = raw?.jsonGraph?.aui?.viewingActivity?.value;
    const items = value?.viewedItems;
    if (!Array.isArray(items)) throw new Error('Netflix viewingActivity response format changed.');
    if (!items.length) break;

    const firstId = String(items[0]?.movieID || '');
    if (firstId && firstId === lastFirstId) break;
    lastFirstId = firstId;

    newestMs ||= Number(items[0]?.date || 0);

    const pageItems = [];
    for (const item of items) {
      const itemMs = Number(item.date || 0);
      if (afterMs && itemMs <= afterMs) {
        reachedCheckpoint = true;
        break;
      }
      pageItems.push(item);
    }

    scanned += pageItems.length;
    const progress = await fetchProgress(pageItems.map(item => item.movieID));

    for (const item of pageItems) {
      const event = normalize(item, progress[String(item.movieID)] || {});
      if (event.progress < threshold) {
        skippedUnderThreshold++;
        continue;
      }
      events.push(event);
    }

    if (reachedCheckpoint) break;
    await sleep(250);
  }

  return { events, newestMs, scanned, skippedUnderThreshold, profileGuid: guid };
}

export const netflixProvider = Object.freeze({
  id: 'netflix',
  label: 'Netflix',
  permissionOrigin: 'https://www.netflix.com/*',
  fetchEvents
});
