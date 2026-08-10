import { getProvider, listProviders } from './provider-registry.js';
import { getSettings } from './storage.js';

const registrationId = providerId => `watchbridge-decoration-${providerId}`;

async function notifyTabs(provider, message) {
  const tabs = await chrome.tabs.query({ url: provider.siteAdapter.matches });
  await Promise.all(tabs.map(tab => (
    tab.id ? chrome.tabs.sendMessage(tab.id, message).catch(() => {}) : Promise.resolve()
  )));
}

export async function reconcileProviderDecorator(providerId) {
  const provider = getProvider(providerId);
  if (!provider.capabilities?.siteDecoration || !provider.siteAdapter) return;
  const settings = await getSettings();
  const granted = await chrome.permissions.contains({ origins: provider.permissionOrigins || [provider.permissionOrigin] });
  const shouldRegister = granted && Boolean(settings.providers?.[providerId]?.dimWatched);
  const id = registrationId(providerId);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });

  if (shouldRegister && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: provider.siteAdapter.matches,
      js: provider.siteAdapter.js,
      css: provider.siteAdapter.css,
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  } else if (!shouldRegister && registered.length) {
    await notifyTabs(provider, { type: 'watchbridgeDecorationDisabled', provider: providerId });
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  }
}

export async function reconcileSiteDecorators() {
  for (const provider of listProviders()) await reconcileProviderDecorator(provider.id);
}

export async function refreshDecoratedTabs(providerId) {
  const provider = getProvider(providerId);
  if (!provider.siteAdapter) return;
  await notifyTabs(provider, { type: 'watchbridgeWatchStateInvalidated', provider: providerId });
}
