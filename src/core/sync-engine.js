import { getProvider } from './provider-registry.js';
import { getSettings, getSimkl, getSyncState, saveSyncState, addLog } from './storage.js';
import { compactWatchEvent, normalizeIds, watchEventKey } from './types.js';
import { resolveForTarget } from './resolver.js';
import { simklTarget } from '../targets/simkl/index.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_COMPLETED_KEYS = 20000;
const MAX_UNMATCHED_RECORDS = 1000;
let inProcess = false;

function isTransient(error) {
  return !error?.status || error.status === 408 || error.status === 429 || error.status >= 500;
}

function rememberCompleted(state, key) {
  if (!state.completedKeys.includes(key)) state.completedKeys.push(key);
  if (state.completedKeys.length > MAX_COMPLETED_KEYS) {
    state.completedKeys.splice(0, state.completedKeys.length - MAX_COMPLETED_KEYS);
  }
}

function unmatchedRecord(item, resolution, finalReason) {
  const dateMs = Number(item.watchedAtMs || 0);
  return {
    key: item.key,
    source: item.source,
    sourceId: item.sourceId,
    localizedNetflixTitle: item.metadata?.netflix?.localizedTitle || item.title || '',
    seriesTitle: item.seriesTitle || '',
    episodeTitle: item.episodeTitle || '',
    netflixDate: dateMs > 0 ? new Date(dateMs).toISOString() : item.watchedAt,
    candidateIds: normalizeIds(item.ids),
    season: item.season || null,
    episode: item.episode || null,
    attemptedStrategies: resolution.attempts || [],
    finalReason,
    failedAt: Date.now()
  };
}

export function enqueueNewEvents(state, events) {
  const queuedKeys = new Set(state.queue.map(item => item.key));
  const completed = new Set(state.completedKeys || []);
  const deadKeys = new Set((state.deadLetters || []).map(item => item.key));
  const unmatchedKeys = new Set((state.unmatchedRecords || []).map(item => item.key));
  let added = 0;

  for (const event of events) {
    const key = watchEventKey(event);
    if (queuedKeys.has(key) || completed.has(key) || deadKeys.has(key) || unmatchedKeys.has(key)) continue;
    state.queue.push(compactWatchEvent(event));
    queuedKeys.add(key);
    added++;
  }
  return added;
}

export async function syncProvider(providerId = 'netflix') {
  if (inProcess) return;
  inProcess = true;

  let state = await getSyncState();
  const startedAt = Date.now();
  state = {
    ...state,
    running: true,
    runningSince: startedAt,
    phase: 'fetching',
    lastError: ''
  };
  await saveSyncState(state);

  const stats = {
    startedAt: new Date(startedAt).toISOString(),
    provider: providerId,
    scanned: 0,
    eligible: 0,
    queued: 0,
    sent: 0,
    unmatched: 0,
    skippedUnderThreshold: 0,
    errors: 0
  };

  try {
    const settings = await getSettings();
    if (!settings.netflixEnabled) throw new Error('Netflix provider is disabled.');

    const provider = getProvider(providerId);
    const hasPermission = await chrome.permissions.contains({ origins: [provider.permissionOrigin] });
    if (!hasPermission) throw new Error('Netflix site permission is not granted. Click Enable Netflix again.');

    const simkl = await getSimkl();
    if (!simkl.clientId || !simkl.accessToken) throw new Error('Connect Simkl first.');

    const checkpoint = Number(state.lastCommittedMs || 0);
    await addLog('info', '[Netflix] Fetching viewing history.', { checkpoint });
    const fetched = await provider.fetchEvents({ afterMs: checkpoint, threshold: Number(settings.threshold || 70) });
    stats.scanned = fetched.scanned;
    stats.eligible = fetched.events.length;
    stats.skippedUnderThreshold = fetched.skippedUnderThreshold;
    await addLog('info', '[Netflix] History fetched and normalized.', {
      scanned: stats.scanned,
      eligible: stats.eligible,
      skippedUnderThreshold: stats.skippedUnderThreshold
    });

    state = await getSyncState();
    stats.queued = enqueueNewEvents(state, fetched.events);

    state.phase = 'sending';
    await saveSyncState(state);
    await addLog('info', '[Queue] Events ready for delivery.', { added: stats.queued, queueSize: state.queue.length });
    if (state.queue.length) {
      await addLog('info', '[Simkl] Sending queued events to sync history.', { queueSize: state.queue.length });
    }

    while (state.queue.length) {
      const item = state.queue[0];
      try {
        let sent = await simklTarget.sendWatchEvent(item, simkl);
        let resolution = { identity: null, attempts: [], reason: '' };
        if (!sent.matched) {
          await addLog('warn', `[Resolver] Primary Simkl match failed for ${item.seriesTitle || item.title}.`, { key: item.key });
          resolution = await resolveForTarget(item, simklTarget, simkl, sent.result);
          if (resolution.identity) {
            await addLog('info', `[Resolver] Resolved ${item.seriesTitle || item.title} with a stable Simkl identity.`, {
              key: item.key,
              strategy: resolution.identity.strategy,
              simkl: resolution.identity.ids.simkl
            });
            sent = await simklTarget.sendWatchEvent(item, simkl, resolution.identity);
            if (!sent.matched) {
              resolution.attempts.push({ strategy: 'sync_history_resolved_retry', outcome: 'not_found' });
              resolution.reason = 'Simkl rejected the high-confidence resolved identity on retry.';
            }
          }
        }

        if (sent.matched) {
          stats.sent++;
          rememberCompleted(state, item.key);
          await addLog('info', `[Simkl] Synced ${item.type}: ${item.seriesTitle || item.title}`, { key: item.key });
        } else {
          stats.unmatched++;
          const reason = resolution.reason || 'Simkl returned not_found and no safe fallback identity was available.';
          state.unmatchedRecords.unshift(unmatchedRecord(item, resolution, reason));
          state.unmatchedRecords.splice(MAX_UNMATCHED_RECORDS);
          await addLog('warn', `[Resolver] Unmatched ${item.type}: ${item.seriesTitle || item.title}`, {
            key: item.key,
            reason
          });
        }
        state.queue.shift();
        await saveSyncState(state);
        await chrome.runtime.getPlatformInfo(); // reset MV3 idle timer during long first imports
        await sleep(600);
      } catch (error) {
        stats.errors++;
        item.retries = Number(item.retries || 0) + 1;
        item.lastError = error.message || String(error);

        // Authentication/authorization failures are global target failures, not bad media items.
        // Keep the queue intact and stop so we never dead-letter an entire history because a token expired.
        if (error?.status === 401 || error?.status === 403) {
          await saveSyncState(state);
          throw error;
        }

        if (!isTransient(error) || item.retries >= 3) {
          state.deadLetters.unshift({ ...item, failedAt: Date.now(), reason: item.lastError });
          state.deadLetters.splice(1000);
          state.queue.shift();
          await saveSyncState(state);
          await addLog('error', `[Queue] Giving up on ${item.seriesTitle || item.title}`, { error: item.lastError, key: item.key });
          continue;
        }

        await saveSyncState(state);
        throw error; // keep checkpoint unchanged; next sync resumes queue first
      }
    }

    // Only advance the checkpoint after the persistent queue has drained.
    if (fetched.newestMs > checkpoint) state.lastCommittedMs = fetched.newestMs;
    state.phase = 'done';
    state.lastStats = { ...stats, finishedAt: new Date().toISOString() };
    state.lastError = '';
    await saveSyncState(state);
    await addLog('info', '[WatchBridge] Sync completed.', state.lastStats);
  } catch (error) {
    state = await getSyncState();
    state.phase = 'error';
    state.lastError = error.message || String(error);
    state.lastStats = { ...stats, finishedAt: new Date().toISOString() };
    await saveSyncState(state);
    await addLog('error', '[WatchBridge] Sync failed.', { error: state.lastError });
  } finally {
    state = await getSyncState();
    state.running = false;
    state.runningSince = 0;
    await saveSyncState(state);
    inProcess = false;
  }
}

export async function resetCheckpoint() {
  const state = await getSyncState();
  if (state.running) throw new Error('Cannot reset while syncing.');
  state.lastCommittedMs = 0;
  state.queue = [];
  state.deadLetters = [];
  state.unmatchedRecords = [];
  state.lastError = '';
  state.phase = 'idle';
  await saveSyncState(state);
  await addLog('warn', '[WatchBridge] History checkpoint reset. Successful event keys were retained for idempotency.');
}
