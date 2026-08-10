import test from 'node:test';
import assert from 'node:assert/strict';

function storageArea() {
  const values = new Map();
  return {
    async get(key) { return { [key]: values.get(key) }; },
    async set(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); }
  };
}

test('provider capabilities represent Netflix, Crunchyroll, and Prime Video honestly', async () => {
  const { listProviders } = await import('../src/core/provider-registry.js');
  const providers = Object.fromEntries(listProviders().map(provider => [provider.id, provider]));
  for (const id of ['netflix', 'crunchyroll']) {
    assert.deepEqual(providers[id].capabilities, {
      historyBackfill: true,
      incrementalHistory: true,
      currentPlaybackScrobble: false,
      siteDecoration: true
    });
  }
  assert.deepEqual(providers.primevideo.capabilities, {
    historyBackfill: true,
    incrementalHistory: true,
    currentPlaybackScrobble: false,
    siteDecoration: false
  });
  assert.equal(providers.primevideo.usesWatchedThreshold, false);
});

test('Netflix, Crunchyroll, and Prime Video can be enabled independently', async () => {
  globalThis.chrome = { storage: { local: storageArea(), session: storageArea() } };
  const storage = await import(`../src/core/storage.js?providers=${Date.now()}`);
  await storage.saveProviderSettings('netflix', { enabled: true });
  let settings = await storage.getSettings();
  assert.equal(settings.providers.netflix.enabled, true);
  assert.equal(settings.providers.crunchyroll.enabled, false);

  await storage.saveProviderSettings('crunchyroll', { enabled: true });
  await storage.saveProviderSettings('netflix', { enabled: false });
  settings = await storage.getSettings();
  assert.equal(settings.providers.netflix.enabled, false);
  assert.equal(settings.providers.crunchyroll.enabled, true);
  assert.equal(settings.providers.primevideo.enabled, false);

  await storage.saveProviderSettings('primevideo', { enabled: true });
  await storage.saveProviderSettings('crunchyroll', { enabled: false });
  settings = await storage.getSettings();
  assert.equal(settings.providers.primevideo.enabled, true);
  assert.equal(settings.providers.crunchyroll.enabled, false);
});

test('decorator registration restores after worker startup and unregisters on revoke', async () => {
  const local = storageArea();
  let granted = true;
  let registered = [];
  const tabMessages = [];
  globalThis.chrome = {
    storage: { local, session: storageArea() },
    permissions: { async contains() { return granted; } },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return registered.filter(script => ids.includes(script.id)); },
      async registerContentScripts(scripts) { registered.push(...scripts); },
      async unregisterContentScripts({ ids }) { registered = registered.filter(script => !ids.includes(script.id)); }
    },
    tabs: {
      async query() { return [{ id: 7 }]; },
      async sendMessage(id, message) { tabMessages.push({ id, message }); }
    }
  };
  const storage = await import(`../src/core/storage.js?decorators=${Date.now()}`);
  await storage.saveProviderSettings('netflix', { dimWatched: true });
  const decoration = await import(`../src/core/site-decoration.js?decorators=${Date.now()}`);
  await decoration.reconcileProviderDecorator('netflix');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].persistAcrossSessions, true);
  assert.deepEqual(registered[0].js, ['src/site-adapters/netflix/content.js', 'src/site-adapters/runtime.js']);

  granted = false;
  await decoration.reconcileProviderDecorator('netflix');
  assert.equal(registered.length, 0);
  assert.equal(tabMessages.at(-1).message.type, 'watchbridgeDecorationDisabled');
});
