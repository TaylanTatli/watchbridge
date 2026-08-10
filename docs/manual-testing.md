# Manual testing checklist

Use this checklist before publishing a WatchBridge release. Tests involving Netflix, Crunchyroll, Prime Video, or Simkl require the tester's own accounts and credentials.

## Fresh installation

1. Remove or disable the existing unpacked installation.
2. Load the repository from `chrome://extensions`.
3. Confirm Netflix, Crunchyroll, and Prime Video initially show **Not granted**.
4. Confirm Simkl is disconnected on a genuinely fresh storage profile.

## Optional provider permissions

For Netflix, Crunchyroll, and Prime Video:

1. Select the provider's **Enable** button.
2. Confirm Chrome displays its native host-permission prompt.
3. Deny the prompt and verify the provider remains disabled.
4. Repeat, accept the prompt, and verify the provider becomes enabled.
5. Revoke access and confirm the provider is disabled and its registered decorator is removed.

Netflix's permission request must remain directly tied to the user gesture. Do not add an await, worker message, or hidden window before `chrome.permissions.request()`.

## Simkl OAuth

1. Enter a personal Simkl developer Client ID.
2. Enter the matching Client Secret.
3. Close and reopen the popup while copying credentials.
4. Confirm the Client ID draft survives in local storage.
5. Confirm the secret draft survives only in session storage.
6. Complete OAuth and verify the secret draft is cleared.
7. Confirm the connected row displays only **Connected**, **OAuth granted**, and **Disconnect**.
8. Search logs and the popup DOM for accidental token or secret exposure.

## Crunchyroll profiles and history

1. Sign out of Crunchyroll and select **Refresh** in WatchBridge.
2. Confirm a readable inline session error appears without blocking the popup.
3. Sign in to Crunchyroll in the same browser profile and reload the site.
4. Refresh WatchBridge profiles and confirm the active profile is listed.
5. If multiple profiles exist, select one and make it active on Crunchyroll.
6. Run synchronization and verify pagination, progress threshold, provider GUIDs, timestamps, and season/episode coordinates.
7. Confirm session tokens, cookies, account IDs, and device IDs do not appear in logs.

## Prime Video history

1. Sign out of Prime Video and run sync; confirm a readable sign-in error appears without queue corruption.
2. Sign in at `primevideo.com` in the same browser profile.
3. Enable Prime Video and confirm Chrome requests both exact optional hosts in one native prompt.
4. Run sync and confirm movies become movie events.
5. Confirm season containers create one event per watched child episode and preserve each child's exact `time` value.
6. Confirm canonical titles and structured season/episode coordinates come from `catalogMetadataV2` requested with `uxLocale=en_US`.
7. Run sync again and confirm stable GTI + timestamp keys prevent duplicate queue growth.
8. Stop and restart the service worker with Prime events queued; confirm the persistent queue resumes.
9. Test a catalog-unavailable history item: cached metadata should be reused, while a cache miss should become unmatched without localized-title guessing.
10. Confirm REMOVE actions/tokens, cookies, and temporary metadata device IDs do not appear in storage or logs.
11. Enable **Dim watched titles**, visit a Prime browse/history page, and confirm safely mapped watched cards are faded and grayscale.
12. Hover a faded Prime card and confirm full color and opacity return.
13. Confirm unmatched and previously unseen Prime cards remain unchanged.

## Synchronization and idempotency

1. Enable Netflix, Crunchyroll, and Prime Video.
2. Select **Sync now**.
3. Confirm logs trace popup command, provider fetch, normalization, queueing, Simkl delivery, and resolver results.
4. Run **Sync now** again.
5. Confirm the queue does not grow with identical historical events.
6. Confirm an error from one provider does not discard existing queued work.
7. Reset checkpoints and verify completed event keys still suppress known successful events.

## Service-worker recovery

1. Start a sync with queued events.
2. Stop the service worker from `chrome://extensions`.
3. Restart it by opening the popup or triggering the extension.
4. Confirm the stale running lock is cleared.
5. Confirm the queue, retries, completed keys, checkpoints, and unmatched records survive.
6. Confirm registered site decorators are reconciled after restart.

## Anime numbering and timestamps

Verify outgoing Simkl payloads for:

- anime `S01E01` with `use_tvdb_anime_seasons=true`;
- anime `S02E01` with `use_tvdb_anime_seasons=true`;
- normal television `S02E01` without the anime flag;
- ISO-8601 `watched_at` at the Simkl boundary;
- unchanged deterministic `watchEventKey` values.

## Site decoration

1. Enable **Dim watched titles** for Netflix.
2. Visit a Netflix browse page and confirm completed titles are lightly faded.
3. Hover a faded card and confirm it returns to full opacity.
4. Navigate within the SPA and confirm newly visible cards are discovered.
5. Sync a visible title and confirm its state refreshes without reloading the extension.
6. Disable dimming and confirm WatchBridge visual attributes are removed.
7. Repeat on Crunchyroll series cards.
8. Confirm unresolved, plan-to-watch, watching, and unsafe episode-only matches remain untouched.
