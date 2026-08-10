(() => {
  function setWatched(element, watched) {
    if (watched) element.setAttribute('data-watchbridge-state', 'watched');
    else element.removeAttribute('data-watchbridge-state');
  }

  function uniqueCards(cards) {
    const items = new Map();
    for (const card of cards || []) {
      const id = String(card?.id || '').trim();
      if (!id || !card.element) continue;
      const kind = card.kind === 'episode' ? 'episode' : 'title';
      const key = `${id}:${kind}`;
      if (!items.has(key)) items.set(key, { id, kind, elements: [] });
      items.get(key).elements.push(card.element);
    }
    return [...items.values()];
  }

  function createController({ provider, scan, sendMessage, documentRef, MutationObserverImpl, debounceMs = 250 }) {
    const cache = new Map();
    let observer = null;
    let timer = null;
    let stopped = false;
    let inFlight = false;
    let rerun = false;

    const apply = cards => {
      for (const card of cards) {
        const key = `${card.id}:${card.kind}`;
        if (!cache.has(key)) continue;
        for (const element of card.elements) setWatched(element, cache.get(key));
      }
    };

    async function refresh(force = false) {
      if (stopped) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      try {
        const cards = uniqueCards(scan());
        if (force) cache.clear();
        apply(cards);
        const missing = cards.filter(card => !cache.has(`${card.id}:${card.kind}`));
        if (!missing.length) return;
        const response = await sendMessage({
          type: 'getWatchStates',
          provider,
          items: missing.map(({ id, kind }) => ({ id, kind }))
        });
        if (!response?.ok || !response.connected) {
          for (const card of cards) for (const element of card.elements) setWatched(element, false);
          return;
        }
        for (const card of missing) {
          const key = `${card.id}:${card.kind}`;
          cache.set(key, Boolean(response.states?.[key]));
        }
        apply(cards);
      } finally {
        inFlight = false;
        if (rerun) {
          rerun = false;
          schedule();
        }
      }
    }

    function schedule() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refresh().catch(() => {});
      }, debounceMs);
    }

    function start() {
      refresh().catch(() => {});
      observer = new MutationObserverImpl(schedule);
      observer.observe(documentRef.body || documentRef.documentElement, { childList: true, subtree: true });
    }

    function stop() {
      stopped = true;
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      for (const element of documentRef.querySelectorAll('[data-watchbridge-state]')) setWatched(element, false);
    }

    return { start, stop, refresh, schedule, cache };
  }

  globalThis.WatchBridgeDecorationCore = { createController, uniqueCards, setWatched };

  const config = globalThis.WatchBridgeSiteAdapterConfig;
  if (!config || !globalThis.document || !globalThis.chrome?.runtime) return;
  globalThis.__watchbridgeDecorationController?.stop?.();
  const controller = createController({
    provider: config.provider,
    scan: config.scan,
    sendMessage: message => chrome.runtime.sendMessage(message),
    documentRef: document,
    MutationObserverImpl: MutationObserver
  });
  globalThis.__watchbridgeDecorationController = controller;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.provider !== config.provider) return;
    if (message.type === 'watchbridgeDecorationDisabled') controller.stop();
    if (message.type === 'watchbridgeWatchStateInvalidated') controller.refresh(true).catch(() => {});
  });
  controller.start();
})();
