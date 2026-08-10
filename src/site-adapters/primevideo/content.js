(() => {
  function identityFromHref(href) {
    const match = String(href || '').match(/\/detail\/([^/?#]+)/i);
    if (!match) return null;
    try {
      return { id: decodeURIComponent(match[1]), kind: 'title' };
    } catch {
      return null;
    }
  }

  function scan() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="/detail/"]')) {
      const identity = identityFromHref(anchor.getAttribute('href'));
      if (!identity) continue;
      // Keep the visual state on the link itself. Prime's generated card class
      // names change often, while the linked image remains inside this anchor.
      cards.push({ ...identity, element: anchor });
    }
    return cards;
  }

  globalThis.WatchBridgeSiteAdapterConfig = { provider: 'primevideo', scan, identityFromHref };
})();
