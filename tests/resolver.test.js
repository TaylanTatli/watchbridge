import test from 'node:test';
import assert from 'node:assert/strict';

import { createWatchEvent, watchEventKey } from '../src/core/types.js';
import { enqueueNewEvents } from '../src/core/sync-engine.js';
import { resolveWatchEvent } from '../src/targets/simkl/resolver.js';
import { toPayload } from '../src/targets/simkl/index.js';

function localizedEpisode(patch = {}) {
  return createWatchEvent({
    source: 'netflix',
    sourceId: '81234567',
    type: 'episode',
    title: 'Kahramanlık Akademim',
    seriesTitle: 'Kahramanlık Akademim',
    episodeTitle: 'Başlangıç',
    season: 1,
    episode: 1,
    watchedAt: 1767225600,
    watchedAtMs: 1767225600000,
    progress: 92,
    ids: { netflix: '81234567' },
    metadata: {
      watchedAtUnit: 'unix_seconds',
      episodeNumbering: 'season_episode',
      netflix: { seriesId: '80135674', localizedTitle: 'Kahramanlık Akademim' }
    },
    ...patch
  });
}

test('event identity is stable provider id plus the real watched timestamp', () => {
  const event = localizedEpisode();
  const key = watchEventKey(event);
  const payload = toPayload(event);
  assert.equal(key, 'netflix:81234567:1767225600');
  assert.equal(payload.episodes[0].watched_at, '2026-01-01T00:00:00.000Z');
  assert.equal(watchEventKey(event), key);
});

test('serialized queue and completed keys prevent duplicate rescans after worker restart', () => {
  const event = localizedEpisode();
  const state = { queue: [], completedKeys: [], deadLetters: [], unmatchedRecords: [] };
  assert.equal(enqueueNewEvents(state, [event]), 1);
  assert.equal(enqueueNewEvents(state, [event]), 0);

  const delivered = state.queue.shift();
  state.completedKeys.push(delivered.key);
  const afterWorkerRestart = JSON.parse(JSON.stringify(state));
  assert.equal(enqueueNewEvents(afterWorkerRestart, [event]), 0);
  assert.deepEqual(afterWorkerRestart.completedKeys, ['netflix:81234567:1767225600']);
});

test('resolved anime S01E01 uses Simkl per-season anime numbering', async () => {
  const event = localizedEpisode();
  const lookup = async (_key, value) => value === '80135674'
    ? [{ type: 'anime', title: 'My Hero Academia', year: 2016, ids: { simkl: 54757 } }]
    : [];

  const resolution = await resolveWatchEvent(event, { clientId: 'test' }, { lookup });
  assert.equal(resolution.identity.ids.simkl, 54757);
  assert.equal(resolution.identity.strategy, 'series_netflix_lookup');

  const payload = toPayload(event, resolution.identity);
  assert.deepEqual(payload, {
    shows: [{
      ids: { simkl: 54757 },
      seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2026-01-01T00:00:00.000Z' }] }],
      use_tvdb_anime_seasons: true
    }]
  });
  assert.equal(JSON.stringify(payload).includes('Kahramanlık'), false);
});

test('resolved anime S02E01 uses Simkl per-season anime numbering', () => {
  const event = localizedEpisode({ season: 2, episode: 1 });
  const payload = toPayload(event, {
    type: 'anime',
    ids: { simkl: 54757 },
    episodeNumbering: 'season_episode'
  });

  assert.deepEqual(payload, {
    shows: [{
      ids: { simkl: 54757 },
      seasons: [{ number: 2, episodes: [{ number: 1, watched_at: '2026-01-01T00:00:00.000Z' }] }],
      use_tvdb_anime_seasons: true
    }]
  });
});

test('resolved normal TV S02E01 keeps the normal TV payload shape', () => {
  const event = localizedEpisode({ season: 2, episode: 1 });
  const payload = toPayload(event, {
    type: 'tv',
    ids: { simkl: 12345 },
    episodeNumbering: 'season_episode'
  });

  assert.deepEqual(payload, {
    shows: [{
      ids: { simkl: 12345 },
      seasons: [{ number: 2, episodes: [{ number: 1, watched_at: '2026-01-01T00:00:00.000Z' }] }]
    }]
  });
  assert.equal('use_tvdb_anime_seasons' in payload.shows[0], false);
});

test('resolver does not retry anime when the provider numbering scheme is unknown', async () => {
  const event = localizedEpisode({
    metadata: {
      watchedAtUnit: 'unix_seconds',
      netflix: { seriesId: '80135674', localizedTitle: 'Kahramanlık Akademim' }
    }
  });
  const lookup = async () => [{ type: 'anime', title: 'My Hero Academia', ids: { simkl: 54757 } }];
  const resolution = await resolveWatchEvent(event, { clientId: 'test' }, { lookup });

  assert.equal(resolution.identity, null);
  assert.ok(resolution.attempts.some(attempt => attempt.outcome === 'unsupported_episode_numbering'));
});

test('resolver leaves a localized episode unmatched when coordinates are unavailable', async () => {
  const event = localizedEpisode({ season: null, episode: null });
  const lookup = async () => [{ type: 'anime', title: 'My Hero Academia', ids: { simkl: 54757 } }];
  const resolution = await resolveWatchEvent(event, { clientId: 'test' }, { lookup });

  assert.equal(resolution.identity, null);
  assert.match(resolution.reason, /season\/episode coordinates/);
  assert.ok(resolution.attempts.some(attempt => attempt.outcome === 'missing_episode_coordinates'));
});

test('resolver never guesses when a provider ID lookup is ambiguous', async () => {
  const resolution = await resolveWatchEvent(localizedEpisode(), { clientId: 'test' }, {
    lookup: async () => [
      { type: 'anime', ids: { simkl: 1 } },
      { type: 'tv', ids: { simkl: 2 } }
    ]
  });

  assert.equal(resolution.identity, null);
  assert.ok(resolution.attempts.some(attempt => attempt.outcome === 'ambiguous'));
});
