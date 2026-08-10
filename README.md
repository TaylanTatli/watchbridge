# WatchBridge v0.1.3

A small Manifest V3 extension with a modular provider -> normalized event -> target pipeline.
The first provider is Netflix and the first target is Simkl.

## Implemented

- Netflix site access is optional and requested directly from the **Enable Netflix** click.
- Simkl API site access is also optional and requested directly from **Connect Simkl**.
- No hidden 1px window, worker call, or awaited operation occurs before `chrome.permissions.request()`.
- Netflix history comes from the logged-in Netflix session, then `runtime` + `bookmarkPosition` are read separately.
- Default watched threshold: 70%.
- Persistent queue, checkpoint, dead letters, and logs use `chrome.storage.local`.
- Successful deterministic event keys and structured unmatched diagnostics also persist in `chrome.storage.local`.
- Simkl client secret is held only in `chrome.storage.session` during OAuth and deleted after token exchange.
- Automatic sync uses `chrome.alarms` (default 30 minutes).

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `watchbridge` directory.
4. Open WatchBridge.

The manifest has a fixed public key, so the unpacked extension ID should remain:

    enfmmbgafhlkglemjhkcfkaklhddgoan

OAuth redirect URI:

    chrome-extension://enfmmbgafhlkglemjhkcfkaklhddgoan/src/ui/oauth.html

The popup also shows the actual runtime redirect URI. If it differs for any reason, use the popup value.

## Simkl setup

Create your own Simkl application in **Simkl Settings -> Developer**. Do not reuse the official Enhancer extension credentials.
Set its redirect URI to the exact WatchBridge redirect URI above, then enter the app Client ID and Client Secret in WatchBridge and click **Connect Simkl**.

## Netflix permission test

On a fresh install:

1. Click **Enable Netflix**.
2. Chrome should show the site-access permission prompt for `www.netflix.com`.
3. Deny -> provider stays disabled.
4. Allow -> popup shows `Granted · provider enabled`.

This permission flow is intentionally isolated before any sync logic.

## Sync

Be logged into Netflix in the same Chrome profile, then click **Sync now**.
WatchBridge reads viewing activity newest-first, filters entries below the configured threshold, normalizes eligible events, and sends them to Simkl `/sync/history`.

The history checkpoint advances only after the persistent queue drains. An interrupted service worker therefore does not silently skip the unsent portion of the import.

### Normalized watch event

Providers emit a target-neutral event with this contract. Optional fields are populated only when the provider actually supplies them:

```js
{
  source: 'netflix',
  sourceId: 'provider-event-id',
  type: 'movie' | 'episode',
  title: '',
  seriesTitle: '',
  episodeTitle: '',
  season: number | null,
  episode: number | null,
  watchedAt: providerTimestamp,
  watchedAtMs: number | null,
  progress: number | null,
  ids: { netflix?, simkl?, imdb?, tmdb?, tvdb?, mal? },
  metadata: {
    watchedAtUnit: 'unix_seconds',
    episodeNumbering: 'season_episode'
  }
}
```

`source + sourceId + watchedAt` is the deterministic local event identity. WatchBridge never creates a fake watched timestamp. Successful keys are retained (up to 20,000) after a run and across worker restarts. Resetting the history checkpoint intentionally rescans Netflix but keeps those success keys, while clearing unmatched and transport-failure records so failed items can be tried again.

Simkl documents that reposting an already-watched episode is a no-op unless `allow_rewatch=yes` is explicitly enabled. WatchBridge never enables rewatch mode, so a watch that already exists in Simkl is safe at the target boundary as well.

### Resolver and localized titles

The first Simkl write sends every stable identifier available on the normalized event. If Simkl returns `not_found`, the target resolver:

1. Looks up provider/external IDs in strength order; it does not translate or fuzzy-match localized titles.
2. Accepts only one compatible Simkl catalog result.
3. For an episode, also requires real season and episode numbers supplied by Netflix.
4. Retries with the canonical Simkl ID and stable episode coordinates. Resolved anime uses Simkl's `use_tvdb_anime_seasons` mode because Netflix coordinates are per-season.
5. Stores a structured unmatched record when any confidence check fails.

Netflix ID lookup is documented by Simkl as beta. Therefore an entry such as `Kahramanlık Akademim` behaves in one of two explicit ways: if the episode or parent Netflix ID resolves uniquely and Netflix supplied episode coordinates, WatchBridge retries using the returned canonical Simkl ID; otherwise it remains unmatched with attempted strategies and the final reason. The Turkish title is never used to guess the English title.

Detailed unmatched records include the source, source ID, localized title, series/episode titles, Netflix date, available IDs, season/episode coordinates, attempted resolution strategies, and final reason. The popup log shows only a concise `[Resolver]` message.

Provider-native watch timestamps remain unchanged for deterministic event identity. The Simkl target converts them to the API's required ISO-8601 `watched_at` representation only while constructing the outgoing payload.

API references used for this behavior:

- https://api.simkl.org/conventions/standard-media-objects
- https://api.simkl.org/api-reference/simkl/search-by-id
- https://api.simkl.org/api-reference/simkl/add-to-history

## Structure

    src/
      core/
        http.js
        provider-registry.js
        resolver.js
        storage.js
        sync-engine.js
        types.js
      providers/
        netflix/
          index.js
      targets/
        simkl/
          index.js
          oauth.js
          resolver.js
      ui/
        popup.html / popup.js / popup.css
        oauth.html / oauth.js
      background.js

A future provider only needs to implement `fetchEvents()` and return normalized watch events, then be registered in `provider-registry.js`. Resolver orchestration is target-neutral; a future target can expose its own `resolveEvent()` without importing any provider implementation.

## Important

Netflix endpoints used here are private/internal and can change without notice. The point of this architecture is that a Netflix break should be confined to `src/providers/netflix/`.


### OAuth credential drafts

Chrome extension popups close when focus moves to another tab/window. WatchBridge therefore autosaves the Client ID as a local draft and the Client Secret in `chrome.storage.session` on every edit. Reopening the popup restores both fields. The secret draft is cleared after the OAuth token exchange succeeds or fails.

## Validation

Run the local resolver/idempotency tests and JavaScript syntax checks:

    npm test
    find src tests -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

The automated localized-title fixture verifies both the canonical-ID retry and the safe unmatched path. Live Netflix/Simkl validation still requires the user's logged-in Netflix profile and personal Simkl OAuth credentials; see the manual procedure in the release handoff.
