import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPrimeDetailId,
  normalizePrimeCatalogResponse,
  normalizePrimeHistoryItem,
  parsePrimeHistoryResponse,
  primeVideoProvider,
  createPrimeVideoClient
} from '../src/providers/primevideo/index.js';
import { enqueueNewEvents } from '../src/core/sync-engine.js';
import { watchEventKey } from '../src/core/types.js';
import { resolveWatchEvent } from '../src/targets/simkl/resolver.js';
import { sendWatchEvent, toPayload } from '../src/targets/simkl/index.js';

function storageArea(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return { [key]: values.get(key) }; },
    async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
    values
  };
}

function movie(patch = {}) {
  return {
    gti: 'amzn1.dv.gti.movie', time: 1749153345820, titleType: 'movie',
    title: { href: '/detail/MOVIE123?ref_=atv', text: 'Yıldızlararası' }, children: [],
    actions: { REMOVE: { query: { token: 'REMOVE-SECRET', titleIds: 'private' } } }, ...patch
  };
}

function episode(id, time, number) {
  return {
    gti: `amzn1.dv.gti.episode-${id}`, time, titleType: 'episode',
    title: { href: `/detail/EPISODE${id}`, text: `${number}. Bölüm` }
  };
}

function season(children = [episode('A', 1748119218481, 1)]) {
  return {
    gti: 'amzn1.dv.gti.season', time: 1749000000000, titleType: 'season',
    title: { href: '/detail/SEASON123', text: 'Zaman Çarkı - 3. Sezon' }, children
  };
}

function historyBody(titles, nextToken = null) {
  return { widgets: [{ widgetType: 'watch-history', content: { content: { titles, nextToken } } }] };
}

function episodeCatalog(gti = 'amzn1.dv.gti.episode-A') {
  return normalizePrimeCatalogResponse({ resources: { catalogMetadataV2: { catalog: {
    type: 'EPISODE', entityType: 'TV Show', title: 'He Who Comes With The Dawn',
    seriesTitle: 'The Wheel of Time', episodeNumber: 8, seasonNumber: 3,
    originalLanguages: ['en_US']
  } } } }, gti, 'EPISODEA');
}

function movieCatalog() {
  return normalizePrimeCatalogResponse({ resources: { catalogMetadataV2: { catalog: {
    type: 'MOVIE', entityType: 'Movie', title: 'Interstellar', originalLanguages: ['en_US']
  } } } }, 'amzn1.dv.gti.movie', 'MOVIE123');
}

test('Prime history emits movies and child episodes, never season containers', () => {
  const page = parsePrimeHistoryResponse(historyBody([
    { date: 'June', children: [movie()] },
    { date: 'May', children: [season([episode('A', 1748119218481, 1), episode('B', 1748119218482, 2)])] }
  ], 'opaque-next'));
  assert.equal(page.nextToken, 'opaque-next');
  assert.deepEqual(page.items.map(item => item.titleType), ['movie', 'episode', 'episode']);
  assert.deepEqual(page.items.map(item => item.time), [1749153345820, 1748119218481, 1748119218482]);
  assert.ok(page.items.every(item => !('actions' in item)));
});

test('Prime detail ID and GTI are preserved without becoming fake Simkl IDs', () => {
  assert.equal(extractPrimeDetailId('/detail/0N0F0I1VSVSFT6K6MIE9K5XIRB?ref_=x'), '0N0F0I1VSVSFT6K6MIE9K5XIRB');
  const event = normalizePrimeHistoryItem(movie(), movieCatalog());
  assert.equal(event.sourceId, 'amzn1.dv.gti.movie');
  assert.deepEqual(event.ids, {});
  assert.equal(event.metadata.primevideo.detailId, 'MOVIE123');
  assert.equal(event.metadata.primevideo.gti, 'amzn1.dv.gti.movie');
  assert.equal(event.title, 'Interstellar');
  assert.equal(event.watchedAt, 1749153345820);
});

test('Prime EPISODE enrichment uses en_US structured coordinates and anime numbering remains safe', () => {
  const item = episode('A', 1748119218481, 8);
  const event = normalizePrimeHistoryItem(item, episodeCatalog());
  assert.equal(event.seriesTitle, 'The Wheel of Time');
  assert.equal(event.episodeTitle, 'He Who Comes With The Dawn');
  assert.equal(event.season, 3);
  assert.equal(event.episode, 8);
  assert.equal(event.metadata.episodeNumbering, 'season_episode');
  const payload = toPayload(event, { type: 'anime', ids: { simkl: 999 }, episodeNumbering: 'season_episode' });
  assert.equal(payload.shows[0].use_tvdb_anime_seasons, true);
  assert.equal(payload.shows[0].seasons[0].number, 3);
  assert.equal(payload.shows[0].seasons[0].episodes[0].number, 8);
  assert.equal(payload.shows[0].seasons[0].episodes[0].watched_at, '2025-05-24T20:40:18.481Z');
});

test('Prime keys use stable GTI plus exact provider milliseconds', () => {
  const event = normalizePrimeHistoryItem(movie(), movieCatalog());
  assert.equal(watchEventKey(event), 'primevideo:amzn1.dv.gti.movie:1749153345820');
  const before = watchEventKey(event);
  assert.equal(toPayload(event, { type: 'movie', ids: { simkl: 1 } }).movies[0].watched_at, '2025-06-05T19:55:45.820Z');
  assert.equal(watchEventKey(event), before);
});

test('Prime paginates opaque tokens, suppresses duplicate rescans, and breaks repeated-token loops', async () => {
  const local = storageArea();
  globalThis.chrome = { storage: { local, session: storageArea() } };
  const calls = [];
  const client = {
    async openSession() { return { firstPage: { items: [movie()], nextToken: 'opaque' } }; },
    async fetchHistoryPage(token) {
      calls.push(token);
      return { items: [episode('A', 1748119218481, 8)], nextToken: 'opaque' };
    },
    async fetchMetadata(gti) { return gti.includes('movie') ? movieCatalog() : episodeCatalog(gti); }
  };
  const result = await primeVideoProvider.fetchEvents({ client });
  assert.deepEqual(calls, ['opaque']);
  assert.equal(result.events.length, 2);
  assert.deepEqual(Object.keys(local.values.get('watchbridge.primeMetadataCache')).sort(), [
    'amzn1.dv.gti.episode-A', 'amzn1.dv.gti.movie'
  ]);
  const state = { queue: [], completedKeys: [], deadLetters: [], unmatchedRecords: [] };
  assert.equal(enqueueNewEvents(state, result.events), 2);
  assert.equal(enqueueNewEvents(state, result.events), 0);
  const restarted = JSON.parse(JSON.stringify(state));
  assert.equal(restarted.queue.length, 2);
  assert.equal(enqueueNewEvents(restarted, result.events), 0);
});

test('Prime incremental scan evaluates the whole checkpoint page', async () => {
  globalThis.chrome = { storage: { local: storageArea(), session: storageArea() } };
  const checkpoint = 1748119218481;
  const client = {
    async openSession() { return { firstPage: { items: [episode('old', checkpoint, 1), episode('new', checkpoint + 1, 2)], nextToken: null } }; },
    async fetchHistoryPage() { throw new Error('page entirely crossed checkpoint'); },
    async fetchMetadata(gti) { return episodeCatalog(gti); }
  };
  const result = await primeVideoProvider.fetchEvents({ client, afterMs: checkpoint });
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map(event => event.watchedAt), [checkpoint, checkpoint + 1]);
});

test('Prime persistent metadata cache avoids enrichment and survives unavailable catalog data', async () => {
  const cached = episodeCatalog();
  const local = storageArea({ 'watchbridge.primeMetadataCache': { [cached.gti]: cached } });
  globalThis.chrome = { storage: { local, session: storageArea() } };
  let enrichments = 0;
  const client = {
    async openSession() { return { firstPage: { items: [episode('A', 1748119218481, 8)], nextToken: null } }; },
    async fetchMetadata() { enrichments++; return null; }
  };
  const result = await primeVideoProvider.fetchEvents({ client });
  assert.equal(enrichments, 0);
  assert.equal(result.events[0].seriesTitle, 'The Wheel of Time');
  assert.equal(result.events[0].metadata.primevideo.metadataSource, 'catalogMetadataV2');
});

test('unavailable Prime metadata without a cache stays safely unresolved', async () => {
  globalThis.chrome = { storage: { local: storageArea(), session: storageArea() } };
  const client = {
    async openSession() { return { firstPage: { items: [movie()], nextToken: null } }; },
    async fetchMetadata() { return null; }
  };
  const result = await primeVideoProvider.fetchEvents({ client });
  const event = result.events[0];
  assert.equal(event.title, 'Yıldızlararası');
  assert.equal(event.metadata.resolution.canonicalTitle, '');
  const primary = await sendWatchEvent(event, { clientId: 'public', accessToken: 'fake-test-token' });
  assert.equal(primary.matched, false);
  assert.equal(primary.deferred, true);
  const resolution = await resolveWatchEvent(event, { clientId: 'public' }, { lookup: async () => assert.fail('localized title must not be searched') });
  assert.equal(resolution.identity, null);
});

test('canonical Prime lookup only resolves one exact compatible Simkl candidate', async () => {
  const event = normalizePrimeHistoryItem(movie(), movieCatalog());
  const attempted = [];
  const resolved = await resolveWatchEvent(event, { clientId: 'public' }, {
    lookup: async (key, value, credentials) => {
      attempted.push([key, value, credentials.lookupType]);
      return [{ type: 'movie', title: 'Interstellar', ids: { simkl: 123 } }];
    }
  });
  assert.deepEqual(attempted, [['title', 'Interstellar', 'movie']]);
  assert.equal(resolved.identity.ids.simkl, 123);
  const ambiguous = await resolveWatchEvent(event, { clientId: 'public' }, { lookup: async () => [
    { type: 'movie', ids: { simkl: 1 } }, { type: 'movie', ids: { simkl: 2 } }
  ] });
  assert.equal(ambiguous.identity, null);
  const wrongTitle = await resolveWatchEvent(event, { clientId: 'public' }, { lookup: async () => [
    { type: 'movie', title: 'Interstellar Wars', ids: { simkl: 3 } }
  ] });
  assert.equal(wrongTitle.identity, null);
  assert.ok(wrongTitle.attempts.some(attempt => attempt.outcome === 'title_mismatch'));
});

test('malformed Prime history is rejected and REMOVE values never reach events', () => {
  assert.throws(() => parsePrimeHistoryResponse({ widgets: [] }), /format changed/);
  const serialized = JSON.stringify(normalizePrimeHistoryItem(movie(), movieCatalog()));
  assert.doesNotMatch(serialized, /REMOVE-SECRET|titleIds|actions/);
});

test('Prime client sends opaque pagination and the verified minimal metadata parameters', async () => {
  const urls = [];
  const responses = [
    historyBody([movie()], null),
    { resources: { catalogMetadataV2: { catalog: { type: 'MOVIE', title: 'Interstellar' } } } }
  ];
  const client = createPrimeVideoClient(async (url, options) => {
    urls.push({ url: String(url), options });
    const body = responses.shift();
    return { ok: true, status: 200, url: String(url), async text() { return JSON.stringify(body); } };
  });
  await client.fetchHistoryPage('opaque+/= token');
  await client.fetchMetadata('amzn1.dv.gti.movie', 'MOVIE123');

  const historyUrl = new URL(urls[0].url);
  assert.deepEqual(JSON.parse(historyUrl.searchParams.get('widgetArgs')), { nextToken: 'opaque+/= token' });
  const metadataUrl = new URL(urls[1].url);
  assert.equal(metadataUrl.searchParams.get('entityId'), 'amzn1.dv.gti.movie');
  assert.equal(metadataUrl.searchParams.get('desiredResources'), 'catalogMetadataV2');
  assert.equal(metadataUrl.searchParams.get('uxLocale'), 'en_US');
  assert.equal(metadataUrl.searchParams.get('deviceTypeID'), 'AOAGZA014O5RE');
  assert.equal(metadataUrl.searchParams.get('firmware'), '1');
  assert.match(metadataUrl.searchParams.get('deviceID'), /^[a-f0-9]{32}$/);
  for (const omitted of ['nerid', 'widgetScheme', 'gascEnabled', 'excludeProfileLockRestrictions']) {
    assert.equal(metadataUrl.searchParams.has(omitted), false);
  }
  assert.equal(urls[1].options.credentials, 'include');
});

test('Prime session bootstrap reads embedded first-page history and detects login redirects', async () => {
  const embedded = JSON.stringify(historyBody([movie()], 'next-page'));
  const client = createPrimeVideoClient(async url => ({
    ok: true, status: 200, url: String(url),
    async text() { return `<html><script type="application/json">${embedded}</script></html>`; }
  }));
  const session = await client.openSession();
  assert.equal(session.firstPage.items.length, 1);
  assert.equal(session.firstPage.nextToken, 'next-page');

  const loggedOut = createPrimeVideoClient(async () => ({
    ok: true, status: 200, url: 'https://www.primevideo.com/auth-redirect?signin=1',
    async text() { return '<html>Please sign in</html>'; }
  }));
  await assert.rejects(loggedOut.openSession(), /not logged in/);
});
