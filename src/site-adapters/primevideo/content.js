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
    return anchor.closest('article[data-testid="card"], [data-testid="card"][data-card-title]') || anchor;
  }

  function scan() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="/detail/"]')) {
      const identity = identityFromHref(anchor.getAttribute('href'));
      if (!identity) continue;
      // Prime keeps the detail link and packshot as siblings inside its stable
      // card container, so styling the link itself cannot reach the image.
      cards.push({ ...identity, element: cardElement(anchor) });
    }
    return cards;
  }

  globalThis.WatchBridgeSiteAdapterConfig = { provider: 'primevideo', scan, identityFromHref, cardElement };
})();
