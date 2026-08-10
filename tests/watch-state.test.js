import test from 'node:test';
import assert from 'node:assert/strict';

function storageArea() {
  const values = new Map();
  return {
    async get(key) { return { [key]: values.get(key) }; },
    async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); }
  };
}

test('Simkl watched lookup is authoritative, batched, cached, and conservative', async () => {
  const local = storageArea();
  globalThis.chrome = {
    storage: { local, session: storageArea() },
    runtime: { getManifest: () => ({ version: '0.1.3' }) }
  };
  await local.set({
    'watchbridge.simkl': { clientId: 'public-client', accessToken: 'private-token' }
  });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.length, 4);
    return {
      ok: true,
      async text() {
        return JSON.stringify([
          { result: true, list: 'completed', last_watched_at: '2026-01-01T00:00:00Z' },
          { result: true, list: 'watching', last_watched_at: '2026-01-01T00:00:00Z' },
          { result: true, list: 'watching', last_watched_at: '2026-01-01T00:00:00Z' },
          { result: 'not_found' }
        ]);
      }
    };
  };
  const { getWatchStates } = await import(`../src/core/watch-state.js?test=${Date.now()}`);
  const items = [
    { id: 'completed', kind: 'title' },
    { id: 'watching-series', kind: 'title' },
    { id: 'watched-episode', kind: 'episode' },
    { id: 'unresolved', kind: 'title' },
    { id: 'completed', kind: 'title' }
  ];
  const first = await getWatchStates('netflix', items, 1_000_000);
  assert.equal(first.connected, true);
  assert.deepEqual(first.states, {
    'completed:title': true,
    'watching-series:title': false,
    'watched-episode:episode': false,
    'unresolved:title': false
  });
  await getWatchStates('netflix', items, 1_000_001);
  assert.equal(calls, 1);

  await local.set({ 'watchbridge.simkl': { clientId: '', accessToken: '' } });
  const disconnected = await getWatchStates('netflix', items, 1_000_002);
  assert.deepEqual(disconnected, { connected: false, states: {} });
});

test('large visible sets are split into bounded Simkl batches', async () => {
  const local = storageArea();
  globalThis.chrome = {
    storage: { local, session: storageArea() },
    runtime: { getManifest: () => ({ version: '0.1.3' }) }
  };
  await local.set({ 'watchbridge.simkl': { clientId: 'public-client', accessToken: 'private-token' } });
  const batchSizes = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    batchSizes.push(request.length);
    return {
      ok: true,
      async text() {
        return JSON.stringify(request.map(() => ({ result: true, list: 'completed', last_watched_at: '2026-01-01T00:00:00Z' })));
      }
    };
  };
  const { getWatchStates } = await import(`../src/core/watch-state.js?batch=${Date.now()}`);
  const items = Array.from({ length: 201 }, (_, index) => ({ id: String(index), kind: 'title' }));
  const result = await getWatchStates('netflix', items, 2_000_000);
  assert.deepEqual(batchSizes, [100, 100, 1]);
  assert.equal(Object.keys(result.states).length, 201);
});

test('Prime decoration maps stable detail IDs and only dims genuinely watched media', async () => {
  const local = storageArea();
  globalThis.chrome = {
    storage: { local, session: storageArea() },
    runtime: { getManifest: () => ({ version: '0.1.3' }) }
  };
  await local.set({
    'watchbridge.simkl': { clientId: 'public-client', accessToken: 'private-token' },
    'watchbridge.primeMetadataCache': {
      'amzn1.dv.gti.movie': {
        gti: 'amzn1.dv.gti.movie', detailId: 'MOVIE', type: 'movie',
        title: 'Miracle in Cell No. 7', year: 2019, fetchedAt: 1
      },
      'amzn1.dv.gti.episode': {
        gti: 'amzn1.dv.gti.episode', detailId: 'EPISODE', type: 'episode',
        title: 'Episode Six', seriesTitle: 'Gen V', season: 1, episode: 6,
        simklId: 1234, fetchedAt: 1
      },
      'amzn1.dv.gti.local': {
        gti: 'amzn1.dv.gti.local', detailId: 'LOCAL', type: 'movie',
        title: 'No Safe Remote Identity', year: null, fetchedAt: 1
      }
    },
    'watchbridge.sync': {
      running: false, providerCheckpoints: {}, queue: [], deadLetters: [], unmatchedRecords: [],
      completedKeys: ['primevideo:amzn1.dv.gti.local:1749153345820'], lastStatsByProvider: {}
    }
  });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request, [
      { title: 'Miracle in Cell No. 7', year: 2019, type: 'movie' },
      { ids: { simkl: 1234 }, title: 'Gen V', type: 'show', season: 1, episode: 6 }
    ]);
    return {
      ok: true,
      async text() {
        return JSON.stringify([
          { result: true, list: 'completed', last_watched_at: '2026-01-01T00:00:00Z' },
          { result: true, list: 'watching', last_watched_at: '2026-01-02T00:00:00Z' }
        ]);
      }
    };
  };
  const { getWatchStates } = await import(`../src/core/watch-state.js?prime=${Date.now()}`);
  const result = await getWatchStates('primevideo', [
    { id: 'MOVIE', kind: 'title' },
    { id: 'EPISODE', kind: 'title' },
    { id: 'LOCAL', kind: 'title' },
    { id: 'UNKNOWN', kind: 'title' }
  ], 3_000_000);
  assert.deepEqual(result.states, {
    'MOVIE:title': true,
    'EPISODE:title': true,
    'LOCAL:title': true,
    'UNKNOWN:title': false
  });
});
