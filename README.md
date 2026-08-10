# WatchBridge

WatchBridge is a Chrome/Chromium extension that imports watch history from streaming services and synchronizes it with tracking platforms.

```text
Netflix ──────┐
              ├─> normalized WatchEvent ─> persistent sync engine ─> Simkl
Crunchyroll ──┤
Prime Video ──┘
```

The project is built around independent providers and targets. Streaming-site code does not know how Simkl works, and the Simkl target does not depend on any provider's internals.

> [!IMPORTANT]
> WatchBridge is an unofficial project. Netflix, Crunchyroll, and Prime Video history synchronization relies on private web APIs used by their own websites. Those endpoints can change without notice.

## Features

- Netflix, Crunchyroll, and Prime Video history import using the browser's existing signed-in session
- Incremental synchronization with persistent, provider-specific checkpoints
- Configurable watched threshold for providers that expose meaningful playback progress
- Deterministic event identity and duplicate-rescan suppression
- Persistent queue, retries, dead letters, and unmatched diagnostics
- Stable-ID resolution before any title-based fallback
- Correct per-season numbering for resolved Simkl anime
- Optional watched-title dimming on Netflix, Crunchyroll, and safely mapped Prime Video cards
- Per-provider optional host permissions
- Manifest V3 service-worker recovery
- Simkl OAuth with session-only secret drafts and redacted logs

## Supported integrations

| Integration | Role | Current support |
|---|---|---|
| Netflix | Provider | History backfill, incremental sync, site decoration |
| Crunchyroll | Provider | History backfill, incremental sync, site decoration with episode limitations |
| Prime Video | Provider | History backfill, incremental sync, and conditional site decoration; no progress threshold |
| Simkl | Target | OAuth, history writes, identity resolution, authoritative watch-state lookup |

Other streaming services are intentionally not exposed as placeholder providers. See [Future services](#future-services) for the current feasibility notes.

## Installation

WatchBridge is currently installed as an unpacked extension.

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository directory containing `manifest.json`.

After pulling or editing extension files, use **Reload** on the WatchBridge card in `chrome://extensions`. This restarts the service worker and applies manifest changes.

### Simkl setup

WatchBridge does not contain or reuse credentials from Simkl's official extension. Create your own application from **Simkl Settings → Developer**.

The manifest includes a fixed public extension key, so the expected unpacked extension ID is:

```text
enfmmbgafhlkglemjhkcfkaklhddgoan
```

Expected OAuth redirect URI:

```text
chrome-extension://enfmmbgafhlkglemjhkcfkaklhddgoan/src/ui/oauth.html
```

Use the redirect URI displayed in the popup if your runtime ID differs.

### Enabling providers

Provider access is optional and is not granted during installation.

1. Open the WatchBridge popup.
2. Select the provider's **Enable** button.
3. Accept Chrome's native site-access prompt.
4. Configure the options supported by that provider.

The host-permission request is invoked directly by the button click. No worker round trip, hidden window, or awaited operation occurs before `chrome.permissions.request()`.

For Crunchyroll, sign in on `crunchyroll.com` using the same Chrome profile, then select **Refresh** to load available profiles. WatchBridge never persists the short-lived Crunchyroll access token.

For Prime Video, sign in on `primevideo.com` in the same Chrome profile. Prime's watch-history records are treated as watched activity directly, so no Netflix-style progress threshold is applied. Movie entries and child episodes are enriched with English `catalogMetadataV2` metadata when available; season containers are never emitted as watches.

Prime pagination reads the opaque `nextToken` from the `watch-history` widget and sends it unchanged to `getWatchHistorySettingsPage`. Catalog enrichment sends the item's GTI as `entityId` and uses the smallest player-resource request verified for the browser client: an ephemeral 128-bit `deviceID`, Prime's public web `deviceTypeID`, `firmware=1`, `uxLocale=en_US`, and `desiredResources=catalogMetadataV2`. Captured account/session parameters such as `nerid` are not copied, persisted, or required by this request.

## Usage

### Synchronize history

Connect Simkl, enable at least one provider, and select **Sync now**.

WatchBridge will:

1. Read new provider history after the stored checkpoint.
2. Apply playback thresholds only when that provider exposes meaningful progress.
3. Normalize eligible entries into `WatchEvent` objects.
4. Suppress events already queued, completed, unmatched, or dead-lettered.
5. Deliver the persistent queue to Simkl.
6. Resolve `not_found` results only when a unique, stable identity is available.
7. Advance the provider checkpoint only after the queue drains.

Running **Sync now** repeatedly does not blindly enqueue the same historical events. Resetting checkpoints intentionally rescans history while retaining successful event keys.

### Dim watched titles

Enable **Dim watched titles** for a provider to fade completed media cards. Images use `opacity: 0.25` with a grayscale filter, then return to full color and opacity on hover.

Site decorators are registered dynamically only when:

- the provider's host permission is granted; and
- title dimming is enabled for that provider.

Visible IDs are deduplicated and queried in batches. Simkl `/sync/watched` is the authoritative source; local completed keys alone do not classify remote watch state.

WatchBridge does not dim plan-to-watch, watching, on-hold, dropped, unresolved, or unmatched titles. A remote episode lookup requires safe canonical season and episode coordinates, so bare provider episode URLs are not guessed.

Prime decoration extracts stable `/detail/<id>` links and maps them through the persistent GTI metadata cache. Simkl IDs learned during successful resolution are preferred; exact title + year is used when both are available. A previously successful WatchBridge completion is a conservative fallback for older cached entries. Unknown, ambiguous, and unmatched Prime cards remain untouched.

## Architecture

Providers declare a compact capability contract:

```js
capabilities: {
  historyBackfill: boolean,
  incrementalHistory: boolean,
  currentPlaybackScrobble: boolean,
  siteDecoration: boolean
}
```

This allows future integrations to be honest about what they support. A provider may eventually support browser playback scrobbling without claiming it can import watches performed on televisions or mobile devices.

### Normalized event

Providers emit target-neutral events. Optional values are included only when supplied by the source.

```js
{
  source: 'netflix' | 'crunchyroll' | 'primevideo',
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

  ids: {
    netflix?: string,
    crunchyroll?: string,
    simkl?: number,
    imdb?: string,
    tmdb?: string,
    tvdb?: string,
    mal?: string
  },

  metadata: {
    watchedAtUnit: 'unix_seconds' | 'unix_milliseconds' | 'iso_8601',
    episodeNumbering: 'season_episode' | null
  }
}
```

The deterministic local identity is:

```text
source + sourceId + watchedAt
```

Provider timestamps are never synthesized. The Simkl target converts them to ISO-8601 only when constructing the outgoing request.

Prime GTIs and detail IDs remain provider identity in `sourceId` and `metadata.primevideo`; they are deliberately not placed in `ids`, because Simkl does not document them as supported external identifiers.

### Resolver behavior

When Simkl returns `not_found`, WatchBridge:

1. Tries the strongest available provider or external ID.
2. Tries a supplied stable parent-series ID when appropriate.
3. Accepts only one compatible canonical result.
4. Requires real season and episode coordinates for episode retries.
5. Leaves ambiguous or unresolved entries unmatched.

There is no localized-title dictionary or fuzzy guessing. Resolved anime using provider per-season coordinates are sent with Simkl's `use_tvdb_anime_seasons=true`; normal television payloads are unchanged.

### Project layout

```text
src/
  core/
    provider-registry.js
    sync-engine.js
    storage.js
    resolver.js
    watch-state.js
    site-decoration.js
    types.js
  providers/
    netflix/
    crunchyroll/
    primevideo/
  site-adapters/
    netflix/
    crunchyroll/
    runtime.js
  targets/
    simkl/
  ui/
  background.js
```

## Privacy and security

- Streaming-site host access is optional and requested per provider.
- Simkl OAuth uses credentials supplied by the user.
- Client secrets are stored only in `chrome.storage.session` while needed for OAuth.
- OAuth access tokens, client secrets, cookies, and authorization headers are recursively redacted from structured logs.
- Crunchyroll session tokens and generated device IDs are not persisted.
- Prime REMOVE actions, browser session data, and metadata-request device IDs are neither stored nor logged.
- Prime's bounded metadata cache contains only canonical catalog fields and successfully resolved Simkl IDs keyed by GTI.
- The popup never displays the raw Simkl Client ID after connection.
- WatchBridge requests no permissions for unsupported streaming platforms.

## Known limitations

- Netflix, Crunchyroll, and Prime Video history endpoints are private and may change.
- Netflix provider-ID lookup is documented by Simkl as beta.
- WatchBridge does not invoke an unverified Crunchyroll profile-switch endpoint. The selected profile must be active on Crunchyroll.
- Remote episode decoration remains conservative when a visible card does not expose safe canonical coordinates.
- Playback scrobbling is not implemented; current providers import recorded history.
- Prime titles removed from the catalog or unavailable in the current region use cached canonical metadata when present; otherwise they remain unmatched rather than being guessed from a localized title.
- Prime title resolution requires one exact, type-compatible canonical Simkl result. Ambiguous titles remain unmatched, especially when a release year is unavailable.
- Prime decoration is conditional: a card must expose a stable detail ID that maps to cached GTI metadata. Unseen catalog cards are not guessed from DOM text.
- Live integration tests require signed-in provider sessions and personal Simkl OAuth credentials.

## Future services

| Service | History backfill | Browser scrobble | Site decoration | Current status |
|---|---|---|---|---|
| Disney+ | No accessible history source verified | Research possible | Research possible | No permission requested |
| Hulu | No accessible history source verified | Research possible | Research possible | No permission requested |
| Max | No accessible history source verified | Research possible | Research possible | No permission requested |

The next low-risk provider candidate is a CSV importer because it exercises non-browser ingestion without depending on another private streaming API. A second tracking target such as Trakt would test the target abstraction independently.

## Development

Requirements:

- A current Node.js release
- Chrome or Chromium with Manifest V3 support

Run the test suite:

```bash
npm test
```

Check every JavaScript file:

```bash
find src tests -type f -name '*.js' -print0 | xargs -0 -n1 node --check
```

Validate the manifest JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json')); console.log('manifest valid')"
```

The full browser release checklist is in [docs/manual-testing.md](docs/manual-testing.md).

## API references

- [Simkl standard media objects](https://api.simkl.org/conventions/standard-media-objects)
- [Simkl external-ID search](https://api.simkl.org/api-reference/simkl/search-by-id)
- [Simkl add to history](https://api.simkl.org/api-reference/simkl/add-to-history)
- [Simkl watched lookup](https://api.simkl.org/api-reference/simkl/get-watched)
- [Chrome dynamic content scripts](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)

## Contributing

Focused bug reports and pull requests are welcome. For provider issues, include the provider name, concise WatchBridge logs, and whether the relevant site is signed in—never include cookies, OAuth tokens, client secrets, or authorization headers.
