import { getSettings, saveSettings, getSimkl, clearSimklToken, getSyncState, getLogs, clearLogs, addLog, getOAuthDraft, recoverInterruptedSyncState } from './core/storage.js';
import { syncProvider, resetCheckpoint } from './core/sync-engine.js';
import { beginOAuth, finishOAuth, redirectUri } from './targets/simkl/oauth.js';
import { getProvider } from './core/provider-registry.js';

const ALARM = 'watchbridge-sync';

async function ensureAlarm() {
  const settings = await getSettings();
  const periodInMinutes = Math.max(1, Number(settings.intervalMinutes || 30));
  const old = await chrome.alarms.get(ALARM);
  if (old) await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { periodInMinutes });
}

async function getState() {
  const [settings, simkl, sync, logs, oauthDraft] = await Promise.all([
    getSettings(), getSimkl(), getSyncState(), getLogs(), getOAuthDraft()
  ]);
  const netflix = getProvider('netflix');
  const netflixPermission = await chrome.permissions.contains({ origins: [netflix.permissionOrigin] });
  const simklPermission = await chrome.permissions.contains({ origins: ['https://api.simkl.com/*'] });
  return {
    settings,
    simkl: { clientId: simkl.clientId, connected: Boolean(simkl.accessToken) },
    oauthDraft,
    sync,
    logs,
    netflixPermission,
    simklPermission,
    redirectUri: redirectUri(),
    extensionId: chrome.runtime.id
  };
}

const startup = recoverInterruptedSyncState().then(ensureAlarm);

chrome.runtime.onInstalled.addListener(async () => {
  await startup;
  await ensureAlarm();
  await addLog('info', `[WatchBridge] Version ${chrome.runtime.getManifest().version} installed.`);
});

chrome.alarms.onAlarm.addListener(async alarm => {
  await startup;
  if (alarm.name !== ALARM) return;
  const settings = await getSettings();
  if (!settings.netflixEnabled) return;
  const simkl = await getSimkl();
  if (!simkl.accessToken) return;
  await syncProvider('netflix');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      await startup;
      switch (message?.type) {
        case 'getState':
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'setNetflixEnabled':
          await saveSettings({ netflixEnabled: Boolean(message.enabled) });
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'setThreshold':
          await saveSettings({ threshold: Math.min(100, Math.max(1, Number(message.value || 70))) });
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'setInterval':
          await saveSettings({ intervalMinutes: Math.max(1, Number(message.value || 30)) });
          await ensureAlarm();
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'beginOAuth':
          await beginOAuth(message.clientId, message.clientSecret);
          sendResponse({ ok: true });
          return;

        case 'finishOAuth':
          await finishOAuth(message);
          sendResponse({ ok: true });
          return;

        case 'disconnectSimkl':
          await clearSimklToken();
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'syncNow':
          // Keep this message event alive for the sync job. The popup may close; the worker continues.
          await addLog('info', '[WatchBridge] Sync Now command received from popup.');
          await syncProvider('netflix');
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'resetCheckpoint':
          await resetCheckpoint();
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'clearLogs':
          await clearLogs();
          sendResponse({ ok: true, state: await getState() });
          return;

        default:
          sendResponse({ ok: false, error: 'Unknown message.' });
      }
    } catch (error) {
      await addLog('error', '[WatchBridge] Background action failed.', { action: message?.type, error: error.message || String(error) });
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();
  return true;
});

startup.catch(() => {});
