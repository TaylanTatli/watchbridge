export const KEYS = Object.freeze({
  SETTINGS: 'watchbridge.settings',
  SIMKL: 'watchbridge.simkl',
  SYNC: 'watchbridge.sync',
  LOGS: 'watchbridge.logs',
  OAUTH_PENDING: 'watchbridge.oauth.pending',
  OAUTH_DRAFT_CLIENT_ID: 'watchbridge.oauth.draftClientId',
  OAUTH_DRAFT_SECRET: 'watchbridge.oauth.draftSecret'
});

const defaults = {
  settings: { netflixEnabled: false, threshold: 70, intervalMinutes: 30 },
  simkl: { clientId: '', accessToken: '' },
  sync: {
    running: false,
    runningSince: 0,
    phase: 'idle',
    lastCommittedMs: 0,
    queue: [],
    completedKeys: [],
    deadLetters: [],
    unmatchedRecords: [],
    lastStats: null,
    lastError: ''
  }
};

async function getLocal(key, fallback) {
  const value = (await chrome.storage.local.get(key))[key];
  return value ?? structuredClone(fallback);
}

export async function getSettings() {
  return getLocal(KEYS.SETTINGS, defaults.settings);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const value = { ...current, ...patch };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: value });
  return value;
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
    result[key] = /token|secret|authorization/i.test(key) ? '[redacted]' : redactSensitive(child);
  }
  return result;
}

export async function getLogs() {
  return getLocal(KEYS.LOGS, []);
}

export async function clearLogs() {
  await chrome.storage.local.set({ [KEYS.LOGS]: [] });
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
