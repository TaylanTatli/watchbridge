(() => {
  function identityFromHref(href) {
    const text = String(href || '');
    const jbv = text.match(/[?&]jbv=(\d+)/i);
    if (jbv) return { id: jbv[1], kind: 'title' };
    const route = text.match(/\/(watch|title)\/(\d+)/i);
    return route ? { id: route[2], kind: route[1].toLowerCase() === 'watch' ? 'episode' : 'title' } : null;
  }

  function scan() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const identity = identityFromHref(anchor.getAttribute('href'));
      if (!identity) continue;
      const element = anchor.closest('[data-uia="title-card-container"], [data-uia="standard-card"], .title-card, .slider-item, li') || anchor;
      cards.push({ ...identity, element });
    }
    return cards;
  }

  globalThis.WatchBridgeSiteAdapterConfig = { provider: 'netflix', scan, identityFromHref };
})();
