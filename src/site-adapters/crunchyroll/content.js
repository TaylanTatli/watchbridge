(() => {
  function identityFromHref(href) {
    const match = String(href || '').match(/\/(watch|series)\/([A-Z0-9]+)/i);
    return match ? { id: match[2], kind: match[1].toLowerCase() === 'watch' ? 'episode' : 'title' } : null;
  }

  function scan() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const identity = identityFromHref(anchor.getAttribute('href'));
      if (!identity) continue;
      const element = anchor.closest('article, li, [data-t*="card"], [class*="card"]') || anchor;
      cards.push({ ...identity, element });
    }
    return cards;
  }

  globalThis.WatchBridgeSiteAdapterConfig = { provider: 'crunchyroll', scan, identityFromHref };
})();
