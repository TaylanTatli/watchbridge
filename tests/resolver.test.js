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
    metadata: { netflix: { seriesId: '80135674', localizedTitle: 'Kahramanlık Akademim' } },
    ...patch
  });
}

test('event identity is stable provider id plus the real watched timestamp', () => {
  assert.equal(watchEventKey(localizedEpisode()), 'netflix:81234567:1767225600');
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

test('localized title is retried only after a unique provider-ID resolution', async () => {
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
      seasons: [{ number: 1, episodes: [{ number: 1, watched_at: 1767225600 }] }]
    }]
  });
  assert.equal(JSON.stringify(payload).includes('Kahramanlık'), false);
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
