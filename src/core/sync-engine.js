import { getProvider } from './provider-registry.js';
import { getSettings, getSimkl, getSyncState, saveSyncState, addLog } from './storage.js';
import { sendWatchEvent } from '../targets/simkl/index.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let inProcess = false;

function keyFor(event) {
  return `${event.source}:${event.sourceId}:${event.watchedAt}`;
}

function compactEvent(event) {
  const { raw, watchedAtMs, ...rest } = event;
  return { ...rest, watchedAtMs, key: keyFor(event), retries: 0 };
}

function isTransient(error) {
  return !error?.status || error.status === 408 || error.status === 429 || error.status >= 500;
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
    const fetched = await provider.fetchEvents({ afterMs: checkpoint, threshold: Number(settings.threshold || 70) });
    stats.scanned = fetched.scanned;
    stats.eligible = fetched.events.length;
    stats.skippedUnderThreshold = fetched.skippedUnderThreshold;

    state = await getSyncState();
    const queuedKeys = new Set(state.queue.map(item => item.key));
    const completed = new Set(state.completedKeys || []);
    const deadKeys = new Set((state.deadLetters || []).map(item => item.key));

    for (const event of fetched.events) {
      const key = keyFor(event);
      if (queuedKeys.has(key) || completed.has(key) || deadKeys.has(key)) continue;
      state.queue.push(compactEvent(event));
      queuedKeys.add(key);
      stats.queued++;
    }

    state.phase = 'sending';
    await saveSyncState(state);

    while (state.queue.length) {
      const item = state.queue[0];
      try {
        const sent = await sendWatchEvent(item, simkl);
        if (sent.matched) {
          stats.sent++;
          state.completedKeys.push(item.key);
          await addLog('info', `Synced ${item.type}: ${item.seriesTitle || item.title}`, { key: item.key });
        } else {
          stats.unmatched++;
          state.deadLetters.unshift({ ...item, failedAt: Date.now(), reason: 'Simkl not_found' });
          state.deadLetters.splice(1000);
          await addLog('warn', `Simkl could not match ${item.seriesTitle || item.title}`, { key: item.key });
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
          await addLog('error', `Giving up on ${item.seriesTitle || item.title}`, { error: item.lastError, key: item.key });
          continue;
        }

        await saveSyncState(state);
        throw error; // keep checkpoint unchanged; next sync resumes queue first
      }
    }

    // Only advance the checkpoint after the persistent queue has drained.
    if (fetched.newestMs > checkpoint) state.lastCommittedMs = fetched.newestMs;
    state.completedKeys = [];
    state.phase = 'done';
    state.lastStats = { ...stats, finishedAt: new Date().toISOString() };
    state.lastError = '';
    await saveSyncState(state);
    await addLog('info', 'Sync completed.', state.lastStats);
  } catch (error) {
    state = await getSyncState();
    state.phase = 'error';
    state.lastError = error.message || String(error);
    state.lastStats = { ...stats, finishedAt: new Date().toISOString() };
    await saveSyncState(state);
    await addLog('error', 'Sync failed.', { error: state.lastError });
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
  state.completedKeys = [];
  state.deadLetters = [];
  state.lastError = '';
  state.phase = 'idle';
  await saveSyncState(state);
  await addLog('warn', 'Sync checkpoint reset. Next sync will re-read full Netflix history.');
}
