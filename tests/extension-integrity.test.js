import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function storageArea() {
  const values = new Map();
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: values.get(key) };
      return Object.fromEntries(values);
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
    }
  };
}

test('manifest keeps provider hosts optional and requests no broad host access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'scripting']);
  assert.deepEqual(manifest.optional_host_permissions, [
    'https://www.netflix.com/*',
    'https://www.crunchyroll.com/*',
    'https://api.simkl.com/*'
  ]);
});

test('provider permission request remains the first operation in each generated click handler', async () => {
  const source = await readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(source, /button\.addEventListener\('click', \(\) => \{\s*chrome\.permissions\.request/);
  assert.doesNotMatch(source, /button\.addEventListener\('click', async \(\) => \{\s*chrome\.permissions\.request/);
});

test('stale service workers produce a reload action instead of an empty provider section', async () => {
  const source = await readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!providers\.length\)/);
  assert.match(source, /Reload WatchBridge/);
  assert.match(source, /chrome\.runtime\.reload\(\)/);
});

test('popup errors use an inline readable notice instead of clipped browser alerts', async () => {
  const [source, html] = await Promise.all([
    readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(source, /\balert\s*\(/);
  assert.match(source, /function showNotice/);
  assert.match(html, /id="notice"[^>]*aria-live="polite"/);
});

test('every popup element referenced by ID exists in the HTML', async () => {
  const [source, html] = await Promise.all([
    readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8')
  ]);
  const referenced = [...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual([...new Set(referenced)].filter(id => !ids.has(id)), []);
});

test('fresh settings are disabled and OAuth secret drafts stay session-only', async () => {
  globalThis.chrome = { storage: { local: storageArea(), session: storageArea() } };
  const storage = await import('../src/core/storage.js');

  assert.deepEqual(await storage.getSettings(), {
    intervalMinutes: 30,
    providers: {
      netflix: { enabled: false, threshold: 70, dimWatched: true },
      crunchyroll: { enabled: false, threshold: 70, dimWatched: true, profileId: '', profiles: [] }
    }
  });

  await storage.saveOAuthDraft({ clientId: 'public-client-id', clientSecret: 'temporary-secret' });
  assert.deepEqual(await storage.getOAuthDraft(), {
    clientId: 'public-client-id',
    clientSecret: 'temporary-secret'
  });
  await storage.clearOAuthSecretDraft();
  assert.deepEqual(await storage.getOAuthDraft(), {
    clientId: 'public-client-id',
    clientSecret: ''
  });
});

test('structured log data redacts token and secret fields', async () => {
  globalThis.chrome = { storage: { local: storageArea(), session: storageArea() } };
  const storage = await import('../src/core/storage.js');
  await storage.addLog('info', '[WatchBridge] test', {
    accessToken: 'must-not-survive',
    nested: { clientSecret: 'must-not-survive', sessionCookie: 'must-not-survive' },
    safe: 'visible'
  });
  const [log] = await storage.getLogs();
  assert.equal(log.data.accessToken, '[redacted]');
  assert.equal(log.data.nested.clientSecret, '[redacted]');
  assert.equal(log.data.nested.sessionCookie, '[redacted]');
  assert.equal(log.data.safe, 'visible');
});

test('worker startup recovery clears a stale lock without losing queued work', async () => {
  globalThis.chrome = { storage: { local: storageArea(), session: storageArea() } };
  const storage = await import('../src/core/storage.js');
  const queued = { key: 'netflix:1:2', retries: 1 };
  await storage.saveSyncState({
    running: true,
    runningSince: Date.now(),
    phase: 'sending',
    queue: [queued],
    completedKeys: [],
    deadLetters: [],
    unmatchedRecords: []
  });

  const recovered = await storage.recoverInterruptedSyncState();
  assert.equal(recovered.running, false);
  assert.equal(recovered.phase, 'interrupted');
  assert.deepEqual(recovered.queue, [queued]);
  assert.equal(recovered.queue[0].retries, 1);
});
