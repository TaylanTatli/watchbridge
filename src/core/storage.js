export const KEYS = Object.freeze({
  SETTINGS: 'watchbridge.settings',
  SIMKL: 'watchbridge.simkl',
  SYNC: 'watchbridge.sync',
  LOGS: 'watchbridge.logs',
  WATCH_STATE_CACHE: 'watchbridge.watchStateCache',
  OAUTH_PENDING: 'watchbridge.oauth.pending',
  OAUTH_DRAFT_CLIENT_ID: 'watchbridge.oauth.draftClientId',
  OAUTH_DRAFT_SECRET: 'watchbridge.oauth.draftSecret'
});

const defaults = {
  settings: {
    intervalMinutes: 30,
    providers: {
      netflix: { enabled: false, threshold: 70, dimWatched: true },
      crunchyroll: { enabled: false, threshold: 70, dimWatched: true, profileId: '', profiles: [] }
    }
  },
  simkl: { clientId: '', accessToken: '' },
  sync: {
    running: false,
    runningSince: 0,
    phase: 'idle',
    lastCommittedMs: 0,
    providerCheckpoints: {},
    queue: [],
    completedKeys: [],
    deadLetters: [],
    unmatchedRecords: [],
    lastStats: null,
    lastStatsByProvider: {},
    lastError: ''
  }
};

async function getLocal(key, fallback) {
  const value = (await chrome.storage.local.get(key))[key];
  return value ?? structuredClone(fallback);
}

export async function getSettings() {
  const stored = await getLocal(KEYS.SETTINGS, defaults.settings);
  const storedProviders = stored.providers && typeof stored.providers === 'object' ? stored.providers : {};
  return {
    ...stored,
    intervalMinutes: Math.max(1, Number(stored.intervalMinutes || 30)),
    providers: {
      netflix: {
        ...defaults.settings.providers.netflix,
        ...(storedProviders.netflix || {}),
        enabled: Boolean(storedProviders.netflix?.enabled ?? stored.netflixEnabled ?? false),
        threshold: Number(storedProviders.netflix?.threshold ?? stored.threshold ?? 70)
      },
      crunchyroll: {
        ...defaults.settings.providers.crunchyroll,
        ...(storedProviders.crunchyroll || {})
      }
    }
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const value = {
    ...current,
    ...patch,
    providers: patch.providers ? { ...current.providers, ...patch.providers } : current.providers
  };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: value });
  return value;
}

export async function saveProviderSettings(providerId, patch) {
  const current = await getSettings();
  if (!current.providers[providerId]) throw new Error(`Unknown provider settings: ${providerId}`);
  return saveSettings({
    providers: {
      ...current.providers,
      [providerId]: { ...current.providers[providerId], ...patch }
    }
  });
}

export async function getSimkl() {
  return getLocal(KEYS.SIMKL, defaults.simkl);
}

export async function saveSimkl(patch) {
  const current = await getSimkl();
  const value = { ...current, ...patch };
  await chrome.storage.local.set({ [KEYS.SIMKL]: value });
  return value;
}

export async function clearSimklToken() {
  return saveSimkl({ accessToken: '' });
}

export async function getSyncState() {
  const state = await getLocal(KEYS.SYNC, defaults.sync);
  // Additive migrations for state written by earlier extension versions.
  state.queue = Array.isArray(state.queue) ? state.queue : [];
  state.completedKeys = Array.isArray(state.completedKeys) ? state.completedKeys : [];
  state.deadLetters = Array.isArray(state.deadLetters) ? state.deadLetters : [];
  state.unmatchedRecords = Array.isArray(state.unmatchedRecords) ? state.unmatchedRecords : [];
  state.providerCheckpoints = state.providerCheckpoints && typeof state.providerCheckpoints === 'object'
    ? state.providerCheckpoints
    : {};
  // Preserve the original Netflix checkpoint during the additive provider migration.
  if (!state.providerCheckpoints.netflix && Number(state.lastCommittedMs || 0) > 0) {
    state.providerCheckpoints.netflix = Number(state.lastCommittedMs);
  }
  state.lastStatsByProvider = state.lastStatsByProvider && typeof state.lastStatsByProvider === 'object'
    ? state.lastStatsByProvider
    : {};
  // A worker can be killed mid-sync. Do not display a stale lock forever.
  if (state.running && Date.now() - (state.runningSince || 0) > 10 * 60 * 1000) {
    state.running = false;
    state.phase = 'interrupted';
    state.lastError = 'Previous sync was interrupted; the persistent queue will resume.';
    await saveSyncState(state);
  }
  return state;
}

export async function recoverInterruptedSyncState() {
  const state = await getLocal(KEYS.SYNC, defaults.sync);
  if (!state.running) return state;
  state.running = false;
  state.runningSince = 0;
  state.phase = 'interrupted';
  state.lastError = 'Previous sync was interrupted; the persistent queue will resume.';
  await saveSyncState(state);
  await addLog('warn', '[Queue] Previous worker stopped; persistent queued work was preserved.');
  return state;
}

export async function saveSyncState(value) {
  await chrome.storage.local.set({ [KEYS.SYNC]: value });
  return value;
}

export async function patchSyncState(patch) {
  const current = await getSyncState();
  return saveSyncState({ ...current, ...patch });
}

export async function addLog(level, message, data = null) {
  const logs = await getLocal(KEYS.LOGS, []);
  logs.unshift({ at: new Date().toISOString(), level, message, data: redactSensitive(data) });
  logs.splice(100);
  await chrome.storage.local.set({ [KEYS.LOGS]: logs });
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = /token|secret|authorization|cookie|session|password/i.test(key) ? '[redacted]' : redactSensitive(child);
  }
  return result;
}

export async function getLogs() {
  return getLocal(KEYS.LOGS, []);
}

export async function clearLogs() {
  await chrome.storage.local.set({ [KEYS.LOGS]: [] });
}

export async function getWatchStateCache() {
  return getLocal(KEYS.WATCH_STATE_CACHE, {});
}

export async function saveWatchStateCache(value) {
  await chrome.storage.local.set({ [KEYS.WATCH_STATE_CACHE]: value });
  return value;
}


export async function getOAuthDraft() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(KEYS.OAUTH_DRAFT_CLIENT_ID),
    chrome.storage.session.get(KEYS.OAUTH_DRAFT_SECRET)
  ]);
  return {
    clientId: local[KEYS.OAUTH_DRAFT_CLIENT_ID] || '',
    clientSecret: session[KEYS.OAUTH_DRAFT_SECRET] || ''
  };
}

export async function saveOAuthDraft(patch) {
  const jobs = [];
  if (patch.clientId !== undefined) {
    jobs.push(chrome.storage.local.set({ [KEYS.OAUTH_DRAFT_CLIENT_ID]: String(patch.clientId) }));
  }
  if (patch.clientSecret !== undefined) {
    jobs.push(chrome.storage.session.set({ [KEYS.OAUTH_DRAFT_SECRET]: String(patch.clientSecret) }));
  }
  await Promise.all(jobs);
}

export async function clearOAuthSecretDraft() {
  await chrome.storage.session.remove(KEYS.OAUTH_DRAFT_SECRET);
}

export async function setPendingOAuth(value) {
  await chrome.storage.session.set({ [KEYS.OAUTH_PENDING]: value });
}

export async function getPendingOAuth() {
  return (await chrome.storage.session.get(KEYS.OAUTH_PENDING))[KEYS.OAUTH_PENDING] || null;
}

export async function clearPendingOAuth() {
  await chrome.storage.session.remove(KEYS.OAUTH_PENDING);
}
