# WatchBridge v0.1

A small Manifest V3 extension with a modular provider -> normalized event -> target pipeline.
The first provider is Netflix and the first target is Simkl.

## Implemented

- Netflix site access is optional and requested directly from the **Enable Netflix** click.
- Simkl API site access is also optional and requested directly from **Connect Simkl**.
- No hidden 1px window, worker call, or awaited operation occurs before `chrome.permissions.request()`.
- Netflix history comes from the logged-in Netflix session, then `runtime` + `bookmarkPosition` are read separately.
- Default watched threshold: 70%.
- Persistent queue, checkpoint, dead letters, and logs use `chrome.storage.local`.
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

## Structure

    src/
      core/
        http.js
        provider-registry.js
        storage.js
        sync-engine.js
      providers/
        netflix/
          index.js
      targets/
        simkl/
          index.js
          oauth.js
      ui/
        popup.html / popup.js / popup.css
        oauth.html / oauth.js
      background.js

A future provider only needs to implement `fetchEvents()` and return normalized watch events, then be registered in `provider-registry.js`.

## Important

Netflix endpoints used here are private/internal and can change without notice. The point of this architecture is that a Netflix break should be confined to `src/providers/netflix/`.


### OAuth credential drafts

Chrome extension popups close when focus moves to another tab/window. WatchBridge therefore autosaves the Client ID as a local draft and the Client Secret in `chrome.storage.session` on every edit. Reopening the popup restores both fields. The secret draft is cleared after the OAuth token exchange succeeds or fails.
