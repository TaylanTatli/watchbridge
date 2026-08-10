import { getSettings, saveSettings, saveProviderSettings, getSimkl, clearSimklToken, getSyncState, getLogs, clearLogs, addLog, getOAuthDraft, recoverInterruptedSyncState } from './core/storage.js';
import { syncEnabledProviders, resetCheckpoint } from './core/sync-engine.js';
import { beginOAuth, finishOAuth, redirectUri } from './targets/simkl/oauth.js';
import { getProvider, listProviders } from './core/provider-registry.js';
import { getWatchStates, invalidateWatchStateCache } from './core/watch-state.js';
import { reconcileProviderDecorator, reconcileSiteDecorators, refreshDecoratedTabs } from './core/site-decoration.js';

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
  const providerDefinitions = listProviders();
  const permissions = await Promise.all(providerDefinitions.map(provider => (
    chrome.permissions.contains({ origins: provider.permissionOrigins })
  )));
  const simklPermission = await chrome.permissions.contains({ origins: ['https://api.simkl.com/*'] });
  return {
    protocolVersion: 2,
    settings,
    simkl: { clientId: simkl.clientId, connected: Boolean(simkl.accessToken) },
    oauthDraft,
    sync,
    logs,
    providers: providerDefinitions.map((provider, index) => ({
      ...provider,
      permissionGranted: permissions[index],
      settings: settings.providers[provider.id]
    })),
    netflixPermission: permissions[providerDefinitions.findIndex(provider => provider.id === 'netflix')],
    simklPermission,
    redirectUri: redirectUri(),
    extensionId: chrome.runtime.id
  };
}

async function refreshAllDecoratedTabs() {
  for (const provider of listProviders()) {
    if (provider.capabilities.siteDecoration) await refreshDecoratedTabs(provider.id).catch(() => {});
  }
}

const startup = recoverInterruptedSyncState().then(ensureAlarm).then(reconcileSiteDecorators);

chrome.runtime.onInstalled.addListener(async () => {
  await startup;
  await ensureAlarm();
  await addLog('info', `[WatchBridge] Version ${chrome.runtime.getManifest().version} installed.`);
});

chrome.alarms.onAlarm.addListener(async alarm => {
  await startup;
  if (alarm.name !== ALARM) return;
  const settings = await getSettings();
  if (!Object.values(settings.providers || {}).some(provider => provider.enabled)) return;
  const simkl = await getSimkl();
  if (!simkl.accessToken) return;
  await syncEnabledProviders();
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
          await saveProviderSettings('netflix', { enabled: Boolean(message.enabled) });
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'setThreshold':
          await saveProviderSettings('netflix', { threshold: Math.min(100, Math.max(1, Number(message.value || 70))) });
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'setProviderSettings': {
          const provider = getProvider(message.provider);
          const patch = {};
          if (message.patch?.enabled !== undefined) patch.enabled = Boolean(message.patch.enabled);
          if (message.patch?.dimWatched !== undefined) patch.dimWatched = Boolean(message.patch.dimWatched);
          if (message.patch?.threshold !== undefined) {
            patch.threshold = Math.min(100, Math.max(1, Number(message.patch.threshold || 70)));
          }
          if (message.patch?.profileId !== undefined) patch.profileId = String(message.patch.profileId || '');
          await saveProviderSettings(provider.id, patch);
          await reconcileProviderDecorator(provider.id);
          sendResponse({ ok: true, state: await getState() });
          return;
        }

        case 'refreshProviderProfiles': {
          const provider = getProvider(message.provider);
          if (typeof provider.listProfiles !== 'function') throw new Error(`${provider.label} does not expose profiles.`);
          const profiles = await provider.listProfiles();
          const current = (await getSettings()).providers[provider.id];
          const selected = profiles.find(profile => profile.selected);
          await saveProviderSettings(provider.id, {
            profiles,
            profileId: current.profileId || selected?.id || ''
          });
          sendResponse({ ok: true, state: await getState() });
          return;
        }

        case 'reconcileProviderDecorator':
          await reconcileProviderDecorator(message.provider);
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'getWatchStates': {
          const provider = getProvider(message.provider);
          const origins = provider.permissionOrigins || [provider.permissionOrigin];
          if (!origins.some(origin => sender.tab?.url?.startsWith(origin.replace('*', '')))) {
            throw new Error('Watch-state request did not originate from the provider site.');
          }
          const result = await getWatchStates(provider.id, message.items);
          sendResponse({ ok: true, ...result });
          return;
        }

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
          await invalidateWatchStateCache();
          await refreshAllDecoratedTabs();
          sendResponse({ ok: true });
          return;

        case 'disconnectSimkl':
          await clearSimklToken();
          await invalidateWatchStateCache();
          await refreshAllDecoratedTabs();
          sendResponse({ ok: true, state: await getState() });
          return;

        case 'syncNow':
          // Keep this message event alive for the sync job. The popup may close; the worker continues.
          await addLog('info', '[WatchBridge] Sync Now command received from popup.');
          await syncEnabledProviders();
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

chrome.permissions.onAdded.addListener(() => { reconcileSiteDecorators().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { reconcileSiteDecorators().catch(() => {}); });
