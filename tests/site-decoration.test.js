import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

delete globalThis.WatchBridgeSiteAdapterConfig;
await import('../src/site-adapters/runtime.js');
const { createController, uniqueCards } = globalThis.WatchBridgeDecorationCore;

function element() {
  const attributes = new Map();
  return {
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name); },
    hasAttribute(name) { return attributes.has(name); }
  };
}

class FakeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.observing = true; }
  disconnect() { this.observing = false; }
}

test('visible provider IDs are batched and duplicate cards share one lookup', async () => {
  const first = element();
  const duplicate = element();
  const untouched = element();
  const requests = [];
  const documentRef = { body: {}, querySelectorAll: () => [first, duplicate, untouched] };
  const controller = createController({
    provider: 'netflix',
    scan: () => [
      { id: '801', kind: 'title', element: first },
      { id: '801', kind: 'title', element: duplicate },
      { id: '802', kind: 'title', element: untouched }
    ],
    sendMessage: async message => {
      requests.push(message);
      return { ok: true, connected: true, states: { '801:title': true, '802:title': false } };
    },
    documentRef,
    MutationObserverImpl: FakeObserver,
    debounceMs: 5
  });
  await controller.refresh();
  assert.deepEqual(requests[0].items, [{ id: '801', kind: 'title' }, { id: '802', kind: 'title' }]);
  assert.equal(first.getAttribute('data-watchbridge-state'), 'watched');
  assert.equal(duplicate.getAttribute('data-watchbridge-state'), 'watched');
  assert.equal(untouched.hasAttribute('data-watchbridge-state'), false);
});

test('debounced mutation activity does not spam lookups and SPA cards are discovered', async () => {
  const cards = [{ id: 'one', kind: 'title', element: element() }];
  let calls = 0;
  const controller = createController({
    provider: 'netflix',
    scan: () => cards,
    sendMessage: async message => {
      calls++;
      return { ok: true, connected: true, states: Object.fromEntries(message.items.map(item => [`${item.id}:${item.kind}`, true])) };
    },
    documentRef: { body: {}, querySelectorAll: () => cards.map(card => card.element) },
    MutationObserverImpl: FakeObserver,
    debounceMs: 5
  });
  controller.schedule();
  controller.schedule();
  controller.schedule();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  cards.push({ id: 'two', kind: 'episode', element: element() });
  controller.schedule();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  assert.equal(cards[1].element.getAttribute('data-watchbridge-state'), 'watched');
});

test('watch state is applied to replacement cards created during an async lookup', async () => {
  const original = element();
  const replacement = element();
  let activeElement = original;
  const controller = createController({
    provider: 'netflix',
    scan: () => [{ id: '81234567', kind: 'title', element: activeElement }],
    sendMessage: async () => {
      activeElement = replacement;
      return { ok: true, connected: true, states: { '81234567:title': true } };
    },
    documentRef: { body: {}, querySelectorAll: () => [activeElement] },
    MutationObserverImpl: FakeObserver
  });
  await controller.refresh();
  assert.equal(replacement.getAttribute('data-watchbridge-state'), 'watched');
});

test('disabling decoration removes all WatchBridge visual state', async () => {
  const watched = element();
  watched.setAttribute('data-watchbridge-state', 'watched');
  const controller = createController({
    provider: 'netflix',
    scan: () => [],
    sendMessage: async () => ({ ok: true, connected: true, states: {} }),
    documentRef: { body: {}, querySelectorAll: () => [watched] },
    MutationObserverImpl: FakeObserver
  });
  controller.start();
  controller.stop();
  assert.equal(watched.hasAttribute('data-watchbridge-state'), false);
});

test('Netflix and Crunchyroll adapters extract only stable URL identifiers', async () => {
  await import(`../src/site-adapters/netflix/content.js?test=${Date.now()}`);
  assert.deepEqual(globalThis.WatchBridgeSiteAdapterConfig.identityFromHref('/browse?jbv=81234567'), { id: '81234567', kind: 'title' });
  assert.deepEqual(globalThis.WatchBridgeSiteAdapterConfig.identityFromHref('/watch/81234567'), { id: '81234567', kind: 'episode' });
  assert.equal(globalThis.WatchBridgeSiteAdapterConfig.identityFromHref('/browse/my-list'), null);

  await import(`../src/site-adapters/crunchyroll/content.js?test=${Date.now()}`);
  assert.deepEqual(globalThis.WatchBridgeSiteAdapterConfig.identityFromHref('/series/G6NQ5DWZ6/my-hero-academia'), { id: 'G6NQ5DWZ6', kind: 'title' });
  assert.deepEqual(globalThis.WatchBridgeSiteAdapterConfig.identityFromHref('/watch/GWDU8JN2W/episode-1'), { id: 'GWDU8JN2W', kind: 'episode' });
  assert.equal(globalThis.WatchBridgeSiteAdapterConfig.identityFromHref('/search?q=hero'), null);
});

test('decorator CSS fades watched art and hover restores opacity', async () => {
  for (const file of ['netflix/content.css', 'crunchyroll/content.css']) {
    const css = await readFile(new URL(`../src/site-adapters/${file}`, import.meta.url), 'utf8');
    assert.match(css, /opacity:\s*0\.25/);
    assert.match(css, /filter:\s*grayscale\(1\)/);
    assert.match(css, /:hover img\s*\{\s*opacity:\s*1/);
    assert.match(css, /:hover img\s*\{[^}]*filter:\s*grayscale\(0\)/s);
    assert.doesNotMatch(css, /!important/);
  }
});

test('uniqueCards keeps different episode/title meanings separate', () => {
  const cards = uniqueCards([
    { id: 'same', kind: 'title', element: element() },
    { id: 'same', kind: 'episode', element: element() }
  ]);
  assert.equal(cards.length, 2);
});
