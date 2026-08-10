import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeCrunchyrollItem, crunchyrollProvider, createCrunchyrollClient } from '../src/providers/crunchyroll/index.js';
import { enqueueNewEvents } from '../src/core/sync-engine.js';
import { watchEventKey } from '../src/core/types.js';
import { toPayload } from '../src/targets/simkl/index.js';
import { resolveWatchEvent } from '../src/targets/simkl/resolver.js';

function historyItem(patch = {}) {
  return {
    id: 'fallback-guid',
    date_played: '2026-07-04T12:34:56Z',
    playhead: 1320,
    fully_watched: false,
    panel: {
      id: 'panel-guid',
      title: 'The Boy Born with Everything',
      episode_metadata: {
        series_id: 'G6NQ5DWZ6',
        season_id: 'GYQ4MW246',
        series_title: 'My Hero Academia',
        series_slug_title: 'my-hero-academia',
        season_display_number: 2,
        episode_number: 4,
        duration_ms: 1_440_000,
        versions: [{ guid: 'G31UXW1QK', original: true }]
      }
    },
    ...patch
  };
}

test('Crunchyroll normalizes a real provider episode identity and progress', () => {
  const event = normalizeCrunchyrollItem(historyItem());
  assert.equal(event.source, 'crunchyroll');
  assert.equal(event.sourceId, 'G31UXW1QK');
  assert.equal(event.ids.crunchyroll, 'G31UXW1QK');
  assert.equal(event.seriesTitle, 'My Hero Academia');
  assert.equal(event.episodeTitle, 'The Boy Born with Everything');
  assert.equal(event.season, 2);
  assert.equal(event.episode, 4);
  assert.equal(Math.round(event.progress), 92);
  assert.equal(event.watchedAt, '2026-07-04T12:34:56Z');
  assert.equal(event.metadata.episodeNumbering, 'season_episode');
});

test('Crunchyroll never invents missing season or episode coordinates', () => {
  const item = historyItem();
  delete item.panel.episode_metadata.season_display_number;
  delete item.panel.episode_metadata.episode_number;
  const event = normalizeCrunchyrollItem(item);
  assert.equal(event.season, null);
  assert.equal(event.episode, null);
  assert.equal(event.metadata.episodeNumbering, null);
});

test('Crunchyroll pagination, threshold, and checkpoint are provider-scoped', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => historyItem({
    id: `item-${index}`,
    date_played: new Date(Date.UTC(2026, 6, 4, 12, 34, 56 - index)).toISOString(),
    playhead: index === 0 ? 100 : 1400,
    panel: {
      ...historyItem().panel,
      episode_metadata: {
        ...historyItem().panel.episode_metadata,
        versions: [{ guid: `GUID-${index}`, original: true }]
      }
    }
  }));
  const checkpoint = Date.parse(firstPage[50].date_played);
  const pages = [];
  const client = {
    async openSession() {
      return { accessToken: 'ephemeral', accountId: 'account', profiles: [{ id: 'main', name: 'Main', selected: true }] };
    },
    async fetchHistoryPage(_session, page) {
      pages.push(page);
      return page === 1 ? firstPage : [];
    }
  };

  const result = await crunchyrollProvider.fetchEvents({ afterMs: checkpoint, threshold: 70, client });
  assert.deepEqual(pages, [1]);
  assert.equal(result.scanned, 50);
  assert.equal(result.skippedUnderThreshold, 1);
  assert.equal(result.events.length, 49);
  assert.equal(result.newestMs, Date.parse(firstPage[0].date_played));
  assert.equal(result.selectedProfileId, 'main');
});

test('Crunchyroll event keys are deterministic and duplicate rescans stay suppressed', () => {
  const event = normalizeCrunchyrollItem(historyItem());
  assert.equal(watchEventKey(event), 'crunchyroll:G31UXW1QK:2026-07-04T12:34:56Z');
  const state = { queue: [], completedKeys: [], deadLetters: [], unmatchedRecords: [] };
  assert.equal(enqueueNewEvents(state, [event]), 1);
  assert.equal(enqueueNewEvents(state, [event]), 0);
  const queued = state.queue.shift();
  state.completedKeys.push(queued.key);
  assert.equal(enqueueNewEvents(JSON.parse(JSON.stringify(state)), [event]), 0);
});

test('resolved Crunchyroll anime preserves per-season numbering', () => {
  const event = normalizeCrunchyrollItem(historyItem());
  const payload = toPayload(event, {
    type: 'anime',
    ids: { simkl: 54757 },
    episodeNumbering: event.metadata.episodeNumbering
  });
  assert.deepEqual(payload.shows, [{
    ids: { simkl: 54757 },
    seasons: [{ number: 2, episodes: [{ number: 4, watched_at: '2026-07-04T12:34:56.000Z' }] }],
    use_tvdb_anime_seasons: true
  }]);
  assert.equal(watchEventKey(event), 'crunchyroll:G31UXW1QK:2026-07-04T12:34:56Z');
});

test('resolver falls back from Crunchyroll episode ID to its stable series ID', async () => {
  const event = normalizeCrunchyrollItem(historyItem());
  const attempted = [];
  const resolution = await resolveWatchEvent(event, { clientId: 'public' }, {
    lookup: async (key, value) => {
      attempted.push([key, value]);
      return value === 'G6NQ5DWZ6'
        ? [{ type: 'anime', title: 'My Hero Academia', ids: { simkl: 54757 } }]
        : [];
    }
  });
  assert.deepEqual(attempted, [
    ['crunchyroll', 'G31UXW1QK'],
    ['crunchyroll', 'G6NQ5DWZ6']
  ]);
  assert.equal(resolution.identity.ids.simkl, 54757);
  assert.equal(resolution.identity.strategy, 'series_crunchyroll_lookup');
  assert.equal(resolution.identity.episodeNumbering, 'season_episode');
});

test('queued Crunchyroll work survives serialized worker state', () => {
  const event = normalizeCrunchyrollItem(historyItem());
  const state = { queue: [], completedKeys: [], deadLetters: [], unmatchedRecords: [] };
  enqueueNewEvents(state, [event]);
  state.queue[0].retries = 1;
  const restarted = JSON.parse(JSON.stringify(state));
  assert.equal(restarted.queue[0].key, watchEventKey(event));
  assert.equal(restarted.queue[0].retries, 1);
});

test('Crunchyroll session token stays inside the ephemeral client session', async () => {
  const requests = [];
  const responses = [
    { ok: true, status: 200, async text() { return '<script>accountAuthClientId:"web-client"</script>'; } },
    { ok: true, status: 200, async text() { return JSON.stringify({ access_token: 'private-session-token', account_id: 'account-1' }); } },
    { ok: true, status: 200, async text() { return JSON.stringify({ data: [{ profile_id: 'main', profile_name: 'Main', is_selected: true }] }); } }
  ];
  const client = createCrunchyrollClient(async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  });
  const session = await client.openSession();
  assert.equal(session.accountId, 'account-1');
  assert.equal(session.accessToken, 'private-session-token');
  assert.deepEqual(session.profiles, [{ id: 'main', name: 'Main', selected: true }]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.headers.Authorization, 'Bearer private-session-token');
  const source = await readFile(new URL('../src/providers/crunchyroll/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.|chrome\.storage/);
});
