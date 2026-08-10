# WatchBridge v0.1.3

WatchBridge is a Manifest V3 watch-history bridge:

    Netflix / Crunchyroll -> normalized WatchEvent -> persistent sync engine -> Simkl

Providers and targets exchange only normalized events. Site decoration is a separate adapter layer and never puts streaming-site DOM selectors in the sync engine.

## Implemented

- Netflix and Crunchyroll history backfill through the user's existing logged-in browser sessions.
- Optional, per-site host access requested directly from each provider's **Enable** click.
- Per-provider enablement, watched threshold, history checkpoint, profile configuration, and **Dim watched titles** setting.
- Persistent queue, completed event keys, retries, dead letters, unmatched diagnostics, and stale worker-lock recovery in `chrome.storage.local`.
- Simkl OAuth using the user's own developer application. No official Enhancer credentials are included or used.
- Stable-ID resolver fallback, ISO-8601 conversion at the Simkl boundary, and safe per-season anime numbering.
- Dynamically registered Netflix and Crunchyroll site decorators with debounced SPA observation.
- Batched Simkl `/sync/watched` lookups with a ten-minute local cache.
- Automatic sync through `chrome.alarms` (default 30 minutes).

## Provider capabilities

Every registered provider declares only four capabilities:

```js
capabilities: {
  historyBackfill: boolean,
  incrementalHistory: boolean,
  currentPlaybackScrobble: boolean,
  siteDecoration: boolean
}
```

| Provider | History backfill | Incremental history | Playback scrobble | Site decoration |
|---|---:|---:|---:|---:|
| Netflix | yes | yes | no | yes |
| Crunchyroll | yes | yes | no | yes, with the episode limitation below |

This contract allows a future browser-playback-only provider without pretending it can import viewing performed on televisions or mobile devices.

## Install and Simkl setup

1. Open `chrome://extensions`, enable **Developer mode**, and load this directory unpacked.
2. Create your own application in **Simkl Settings -> Developer**. Never reuse credentials from Simkl's official extension.
3. Configure the redirect URI shown in the popup and connect Simkl.
4. Enable Netflix and/or Crunchyroll from the popup.

The repository manifest has a fixed public extension key. Its expected unpacked ID is:

    enfmmbgafhlkglemjhkcfkaklhddgoan

Expected OAuth redirect URI:

    chrome-extension://enfmmbgafhlkglemjhkcfkaklhddgoan/src/ui/oauth.html

The Client ID draft persists locally so popup closure does not lose it. The Client Secret draft uses `chrome.storage.session` and is cleared after OAuth. Access tokens and secrets are recursively redacted from structured logs and are never displayed after connection.

## Optional permissions

Netflix, Crunchyroll, and Simkl API access are `optional_host_permissions`; neither streaming site is accessible at install time. The provider enable handler calls `chrome.permissions.request()` directly from the click, before any await, worker round trip, or hidden window.

The regular `scripting` permission is used only to register a provider's decorator after both conditions are true:

- that provider's optional host permission is granted;
- **Dim watched titles** is enabled for that provider.

Revoking site access removes the registration and existing WatchBridge visual state. Startup reconciliation restores required persistent registrations after a service-worker restart.

## Crunchyroll history flow

The provider uses the current logged-in `www.crunchyroll.com` browser session and the same private web API lineage used by Crunchyroll's web client:

1. Load `/home/history` and discover the web client's `accountAuthClientId` from page configuration.
2. Exchange the existing `etp_rt_cookie` session for a short-lived access token at `/auth/v1/token`.
3. Fetch `/accounts/v1/me/multiprofile` and expose non-sensitive profile names/IDs in the popup.
4. Fetch paginated `/content/v1/watch-history/{accountId}` records.
5. Calculate progress from `fully_watched`, `playhead`, and `duration_ms`; apply the provider threshold.
6. Preserve `date_played`, the original version GUID, and supplied season/episode coordinates in a normalized event.

The Crunchyroll token, session cookie, account authentication client ID, and generated device ID are not persisted or logged. Only the selected profile ID and the non-sensitive discovered profile list persist. WatchBridge does not call an unverified private profile-switch endpoint: if the configured profile is not currently active on Crunchyroll, sync stops with instructions to switch profiles on the site rather than importing the wrong profile.

These endpoints are private and can change without notice. Response parsing accepts the known current/legacy wrappers but fails with a concise format-change error when required fields are absent. Authenticated live validation is still required after any Crunchyroll site release.

## Normalized WatchEvent

Optional fields are populated only when the provider actually supplies them:

```js
{
  source: 'netflix' | 'crunchyroll',
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
  ids: { netflix?, crunchyroll?, simkl?, imdb?, tmdb?, tvdb?, mal? },
  metadata: {
    watchedAtUnit: 'unix_seconds' | 'iso_8601',
    episodeNumbering: 'season_episode' | null,
    netflix?: {},
    crunchyroll?: {}
  }
}
```

`source + sourceId + watchedAt` is the deterministic local identity. WatchBridge never manufactures a watched timestamp. The Simkl target converts the provider-native value to ISO-8601 only while building the outgoing payload, leaving `watchEventKey` stable.

Checkpoints are provider-specific and Crunchyroll checkpoints are profile-specific. They advance only after the persistent queue drains. Resetting checkpoints intentionally rescans enabled providers but retains successful event keys, preventing a blind duplicate queue explosion across worker restarts.

## Resolver and anime numbering

The first Simkl history write sends every real stable ID on the event. On `not_found`, the resolver tries the item provider ID and then a supplied stable parent-series provider ID. It accepts only one compatible canonical result. There is no translation dictionary or fuzzy title guessing.

An episode retry also requires real provider season/episode coordinates. When the canonical result is anime and `metadata.episodeNumbering` is `season_episode`, the Simkl payload adds `use_tvdb_anime_seasons=true`. Normal TV payloads remain unchanged. A Netflix `S02E01` or Crunchyroll `S02E04` therefore cannot silently become AniDB-style flat episode numbering.

Unresolved and ambiguous entries remain unmatched with source, provider ID, localized title, series/episode title, provider date, candidate IDs, coordinates, attempted strategies, and final reason. Popup logs stay concise.

For `Kahramanlık Akademim`, a unique Netflix episode or parent-series ID match can resolve to the canonical My Hero Academia Simkl ID and retry safely. If those IDs do not resolve uniquely, it remains unmatched; the Turkish title is never used to guess an English one.

## Site decoration

Provider adapters extract only stable IDs from visible links:

- Netflix: `jbv`, `/title/{id}`, and `/watch/{id}` numeric IDs.
- Crunchyroll: `/series/{GUID}` and `/watch/{GUID}` IDs.

The content runtime deduplicates visible IDs, sends one background batch, observes SPA mutations with debounce, and applies only `data-watchbridge-state="watched"`. CSS lightly fades images to `opacity: 0.58` and restores opacity on hover. It does not alter layout, click targets, labels, or dimensions.

Simkl is authoritative through `POST /sync/watched`; `completedKeys` alone never decides remote state. A title card is dimmed only when Simkl reports `list: "completed"`. `watching`, plan-to-watch, dropped, on-hold, `false`, and `not_found` are left untouched.

Simkl documents that a guaranteed episode lookup requires canonical identification plus explicit `season` and `episode`. Visible provider `/watch/{id}` links do not expose those coordinates reliably, so WatchBridge does not guess a remote episode state from the ID alone. An episode card can be updated immediately after WatchBridge successfully syncs that exact provider event. A future metadata cache can safely extend manual-episode decoration once it can supply canonical coordinates.

## Streaming-service feasibility

| Service | History backfill | Browser scrobble | Site dimming | WatchBridge status |
|---|---|---|---|---|
| Netflix | available | future | available | implemented |
| Crunchyroll | available | future | stable IDs; episode state conditional | implemented |
| Prime Video | no stable accurate source verified | research possible | research possible | no permission requested |
| Disney+ | no accessible history source verified | research possible | research possible | no permission requested |
| Hulu | no accessible history source verified | research possible | research possible | no permission requested |
| Max | no accessible history source verified | research possible | research possible | no permission requested |

This conservative matrix follows Simkl's current import guidance, which identifies Netflix and Crunchyroll history as accessible while noting the lack of stable/accurate import sources for the other services: <https://docs.simkl.org/how-to-use-simkl/advanced-usage/import-export-data/importing-to-simkl/faq-troubleshooting/is-there-a-way-to-import-data-from-streaming-services-directly-like-netflix-amazon-video-or-disney>.

No unsupported platform permission or placeholder provider is included.

## Structure

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
        netflix/index.js
        crunchyroll/index.js
      site-adapters/
        runtime.js
        netflix/content.js + content.css
        crunchyroll/content.js + content.css
      targets/simkl/
        index.js
        oauth.js
        resolver.js
      ui/
        popup.html / popup.js / popup.css
        oauth.html / oauth.js
      background.js

## API references and assumptions

- Simkl standard IDs: <https://api.simkl.org/conventions/standard-media-objects>
- Simkl ID search: <https://api.simkl.org/api-reference/simkl/search-by-id>
- Add history: <https://api.simkl.org/api-reference/simkl/add-to-history>
- Watched lookup: <https://api.simkl.org/api-reference/simkl/get-watched>
- Crunchyroll stable public series/watch URL forms are current, but its session/history endpoints are private and undocumented.

## Validation

Automated checks:

    npm test
    find src tests -type f -name '*.js' -print0 | xargs -0 -n1 node --check
    node -e "JSON.parse(require('fs').readFileSync('manifest.json')); console.log('manifest valid')"

Manual release procedure:

1. Fresh-load the extension. Confirm neither Netflix nor Crunchyroll host access is granted.
2. Click **Enable Netflix**. Denial must leave it disabled; acceptance must show Chrome's native prompt and then `Granted`.
3. Repeat for Crunchyroll. Verify the two providers enable/disable independently.
4. With Crunchyroll logged out, run sync and confirm a useful `[Crunchyroll]` error while queued work remains intact.
5. Log into Crunchyroll, refresh profiles, select the active profile, and sync. Confirm pagination, scanned/eligible counters, real GUIDs, progress threshold, and provider timestamp in stored events.
6. Connect a personal Simkl application. Close/reopen the popup during credential entry; Client ID and session-only secret drafts must return. Complete OAuth and confirm the secret field is cleared and no token/secret appears in logs.
7. Enable both historical providers and click **Sync now**. Confirm logs trace command, each provider fetch/normalization, queue, Simkl delivery, and resolver outcomes.
8. Run **Sync now** twice. Queue size must not grow blindly and completed keys must suppress identical events.
9. Stop/restart the service worker with queued work. Confirm the stale lock clears, retries/queue survive, and the queue resumes.
10. Visit Netflix browse pages. Simkl-completed titles should fade lightly; hovering restores full opacity. SPA navigation should discover new cards without continuous polling.
11. Sync a newly visible title/episode and confirm its state refreshes without reloading the extension.
12. Repeat on Crunchyroll series cards. Episode cards without safe coordinate mapping must remain untouched rather than guessed.
13. Turn off **Dim watched titles** and confirm attributes are removed. Re-enable it and restart the worker; registration should recover. Revoke host access and confirm the registered content script is removed.
14. Confirm a multi-season anime retry includes `use_tvdb_anime_seasons=true`, while a normal TV `S02E01` payload remains unchanged.
