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

  function cardElement(anchor) {
    const card = anchor.closest('article[data-testid="card"], [data-testid="card"][data-card-title]');
    return card?.closest('li[data-index]') || card || anchor;
  }

  function scan() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="/detail/"]')) {
      const identity = identityFromHref(anchor.getAttribute('href'));
      if (!identity) continue;
      // Prime replaces the inner article during hover expansion. The carousel
      // item survives that transition and still contains the linked artwork.
      cards.push({ ...identity, element: cardElement(anchor) });
    }
    return cards;
  }

  globalThis.WatchBridgeSiteAdapterConfig = { provider: 'primevideo', scan, identityFromHref, cardElement };
})();
