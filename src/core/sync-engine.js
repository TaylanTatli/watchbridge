import { getProvider, listProviders } from './provider-registry.js';
import { getSettings, getSimkl, getSyncState, saveSyncState, saveProviderSettings, addLog } from './storage.js';
import { compactWatchEvent, normalizeIds, watchEventKey } from './types.js';
import { resolveForTarget } from './resolver.js';
import { simklTarget } from '../targets/simkl/index.js';
import { invalidateWatchStateCache, rememberSyncedWatch } from './watch-state.js';
import { refreshDecoratedTabs } from './site-decoration.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_COMPLETED_KEYS = 20000;
const MAX_UNMATCHED_RECORDS = 1000;
let inProcess = false;
let providerBatchInProcess = false;

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
  const providerDate = dateMs > 0 ? new Date(dateMs).toISOString() : item.watchedAt;
  return {
    key: item.key,
    source: item.source,
    sourceId: item.sourceId,
    localizedTitle: item.metadata?.[item.source]?.localizedTitle || item.title || '',
    localizedNetflixTitle: item.metadata?.netflix?.localizedTitle || '',
    seriesTitle: item.seriesTitle || '',
    episodeTitle: item.episodeTitle || '',
    providerDate,
    netflixDate: item.source === 'netflix' ? providerDate : null,
    candidateIds: normalizeIds(item.ids),
    providerIdentity: {
      gti: item.metadata?.[item.source]?.gti || '',
      detailId: item.metadata?.[item.source]?.detailId || '',
      seriesId: item.metadata?.[item.source]?.seriesId || ''
    },
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
  const syncedProviders = new Set();

  try {
    const settings = await getSettings();
    const provider = getProvider(providerId);
    const providerSettings = settings.providers?.[providerId];
    if (!provider.capabilities?.historyBackfill) throw new Error(`${provider.label} does not support history backfill.`);
    if (!providerSettings?.enabled) throw new Error(`${provider.label} provider is disabled.`);

    const origins = provider.permissionOrigins || [provider.permissionOrigin];
    const hasPermission = await chrome.permissions.contains({ origins });
    if (!hasPermission) throw new Error(`${provider.label} site permission is not granted. Click Enable ${provider.label} again.`);

    const simkl = await getSimkl();
    if (!simkl.clientId || !simkl.accessToken) throw new Error('Connect Simkl first.');

    const requestedCheckpointKey = providerSettings.profileId
      ? `${providerId}:${providerSettings.profileId}`
      : providerId;
    const checkpoint = Number(state.providerCheckpoints?.[requestedCheckpointKey] || 0);
    await addLog('info', `[${provider.label}] Fetching viewing history.`, { checkpoint });
    const fetched = await provider.fetchEvents({
      afterMs: checkpoint,
      threshold: Number(providerSettings.threshold || 70),
      profileId: providerSettings.profileId || ''
    });
    if (Array.isArray(fetched.profiles)) {
      await saveProviderSettings(providerId, {
        profiles: fetched.profiles,
        profileId: providerSettings.profileId || fetched.selectedProfileId || ''
      });
    }
    stats.scanned = fetched.scanned;
    stats.eligible = fetched.events.length;
    stats.skippedUnderThreshold = fetched.skippedUnderThreshold;
    await addLog('info', `[${provider.label}] History fetched and normalized.`, {
      scanned: stats.scanned,
      eligible: stats.eligible,
      skippedUnderThreshold: stats.skippedUnderThreshold
    });

    state = await getSyncState();
    stats.queued = enqueueNewEvents(state, fetched.events);

    state.phase = 'sending';
    await saveSyncState(state);
    await addLog('info', `[Queue] ${provider.label} events ready for delivery.`, { added: stats.queued, queueSize: state.queue.length });
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
          syncedProviders.add(item.source);
          rememberCompleted(state, item.key);
          await rememberSyncedWatch(item.source, item.sourceId, item.type).catch(() => {});
          await addLog('info', `[Simkl] Synced ${item.source} ${item.type}: ${item.seriesTitle || item.title}`, { key: item.key });
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
    if (fetched.newestMs > checkpoint) {
      const committedCheckpointKey = fetched.selectedProfileId
        ? `${providerId}:${fetched.selectedProfileId}`
        : requestedCheckpointKey;
      state.providerCheckpoints = { ...(state.providerCheckpoints || {}), [committedCheckpointKey]: fetched.newestMs };
      if (providerId === 'netflix') state.lastCommittedMs = fetched.newestMs;
    }
    state.phase = 'done';
    state.lastStats = { ...stats, finishedAt: new Date().toISOString() };
    state.lastStatsByProvider = { ...(state.lastStatsByProvider || {}), [providerId]: state.lastStats };
    state.lastError = '';
    await saveSyncState(state);
    await addLog('info', `[${provider.label}] Sync completed.`, state.lastStats);
    for (const syncedProviderId of syncedProviders) {
      await invalidateWatchStateCache(syncedProviderId).catch(() => {});
      await refreshDecoratedTabs(syncedProviderId).catch(async error => {
        await addLog('warn', `[${provider.label}] Site decoration refresh failed.`, { error: error.message || String(error) });
      });
    }
  } catch (error) {
    state = await getSyncState();
    state.phase = 'error';
    state.lastError = error.message || String(error);
    state.lastStats = { ...stats, finishedAt: new Date().toISOString() };
    await saveSyncState(state);
    const label = (() => { try { return getProvider(providerId).label; } catch { return providerId; } })();
    await addLog('error', `[${label}] Sync failed: ${state.lastError}`, { error: state.lastError });
  } finally {
    state = await getSyncState();
    state.running = false;
    state.runningSince = 0;
    await saveSyncState(state);
    inProcess = false;
  }
}

export async function syncEnabledProviders() {
  if (providerBatchInProcess) return;
  providerBatchInProcess = true;
  try {
    const settings = await getSettings();
    const enabled = listProviders().filter(provider => (
      provider.capabilities.historyBackfill && settings.providers?.[provider.id]?.enabled
    ));
    if (!enabled.length) {
      await addLog('warn', '[WatchBridge] Sync skipped because no historical provider is enabled.');
      return;
    }
    for (const provider of enabled) await syncProvider(provider.id);
  } finally {
    providerBatchInProcess = false;
  }
}

export async function resetCheckpoint() {
  const state = await getSyncState();
  if (state.running) throw new Error('Cannot reset while syncing.');
  state.lastCommittedMs = 0;
  state.providerCheckpoints = {};
  state.queue = [];
  state.deadLetters = [];
  state.unmatchedRecords = [];
  state.lastError = '';
  state.phase = 'idle';
  await saveSyncState(state);
  await addLog('warn', '[WatchBridge] History checkpoint reset. Successful event keys were retained for idempotency.');
}
