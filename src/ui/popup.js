import { saveOAuthDraft } from '../core/storage.js';

const SIMKL_API_ORIGIN = 'https://api.simkl.com/*';
const $ = id => document.getElementById(id);
let state = null;
let pollTimer = null;
let authDraftHydrated = false;

function send(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(response || { ok: false, error: 'No response from service worker.' });
    });
  });
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = label;
}

function formatTime(iso) {
  if (!iso) return 'never';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function providerMarkup(provider) {
  const config = provider.settings || {};
  const permissionText = provider.permissionGranted
    ? (config.enabled ? 'Granted · history sync enabled' : 'Granted · history sync disabled')
    : 'Not granted';
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const profile = provider.id === 'crunchyroll' && provider.permissionGranted ? `
    <div class="profileRow">
      <label>Profile
        <select data-provider="${escapeHtml(provider.id)}" data-action="profile">
          ${profiles.length
            ? profiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === config.profileId ? 'selected' : ''}>${escapeHtml(item.name)}${item.selected ? ' (active)' : ''}</option>`).join('')
            : '<option value="">Active Crunchyroll profile</option>'}
        </select>
      </label>
      <button data-provider="${escapeHtml(provider.id)}" data-action="profiles">Refresh</button>
    </div>` : '';
  return `<div class="provider" data-provider-card="${escapeHtml(provider.id)}">
    <div class="row">
      <div><h3>${escapeHtml(provider.label)}</h3><small>${escapeHtml(permissionText)}</small></div>
      <button class="primary" data-provider="${escapeHtml(provider.id)}" data-origin="${escapeHtml(provider.permissionOrigin)}" data-label="${escapeHtml(provider.label)}" data-action="enable" ${provider.permissionGranted && config.enabled ? 'disabled' : ''}>${provider.permissionGranted && config.enabled ? 'Enabled' : `Enable ${escapeHtml(provider.label)}`}</button>
    </div>
    <div class="row compact">
      <label>Watched threshold</label>
      <div><input data-provider="${escapeHtml(provider.id)}" data-action="threshold" type="number" min="1" max="100" value="${Number(config.threshold || 70)}"> %</div>
    </div>
    <label class="toggle"><span>Dim watched titles</span><input data-provider="${escapeHtml(provider.id)}" data-action="dim" type="checkbox" ${config.dimWatched ? 'checked' : ''} ${provider.capabilities.siteDecoration ? '' : 'disabled'}></label>
    ${profile}
    <div class="actions">
      <button data-provider="${escapeHtml(provider.id)}" data-action="disable" ${config.enabled ? '' : 'disabled'}>Disable provider</button>
      <button class="danger" data-provider="${escapeHtml(provider.id)}" data-origin="${escapeHtml(provider.permissionOrigin)}" data-action="revoke" ${provider.permissionGranted ? '' : 'disabled'}>Revoke site access</button>
    </div>
  </div>`;
}

function bindProviderControls() {
  for (const button of document.querySelectorAll('[data-action="enable"]')) {
    const providerId = button.dataset.provider;
    const origin = button.dataset.origin;
    const label = button.dataset.label;
    // IMPORTANT: the permission request is the first operation in this click handler.
    button.addEventListener('click', () => {
      chrome.permissions.request({ origins: [origin] }, async granted => {
        if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message);
        if (!granted) {
          alert(`${label} site access was not granted.`);
          await refresh();
          return;
        }
        const response = await send({ type: 'setProviderSettings', provider: providerId, patch: { enabled: true } });
        if (!response.ok) alert(response.error); else render(response.state);
      });
    });
  }

  for (const button of document.querySelectorAll('[data-action="disable"]')) {
    button.addEventListener('click', async () => {
      const response = await send({ type: 'setProviderSettings', provider: button.dataset.provider, patch: { enabled: false } });
      if (!response.ok) alert(response.error); else render(response.state);
    });
  }

  for (const button of document.querySelectorAll('[data-action="revoke"]')) {
    button.addEventListener('click', async () => {
      await send({ type: 'setProviderSettings', provider: button.dataset.provider, patch: { enabled: false, dimWatched: false } });
      chrome.permissions.remove({ origins: [button.dataset.origin] }, async () => {
        await send({ type: 'reconcileProviderDecorator', provider: button.dataset.provider });
        await refresh();
      });
    });
  }

  for (const input of document.querySelectorAll('[data-action="threshold"]')) {
    input.addEventListener('change', async () => {
      const response = await send({ type: 'setProviderSettings', provider: input.dataset.provider, patch: { threshold: input.value } });
      if (response.ok) render(response.state);
    });
  }
  for (const input of document.querySelectorAll('[data-action="dim"]')) {
    input.addEventListener('change', async () => {
      const response = await send({ type: 'setProviderSettings', provider: input.dataset.provider, patch: { dimWatched: input.checked } });
      if (response.ok) render(response.state);
    });
  }
  for (const select of document.querySelectorAll('[data-action="profile"]')) {
    select.addEventListener('change', async () => {
      const response = await send({ type: 'setProviderSettings', provider: select.dataset.provider, patch: { profileId: select.value } });
      if (response.ok) render(response.state);
    });
  }
  for (const button of document.querySelectorAll('[data-action="profiles"]')) {
    button.addEventListener('click', async () => {
      setBusy(button, true, 'Loading…');
      const response = await send({ type: 'refreshProviderProfiles', provider: button.dataset.provider });
      if (!response.ok) alert(response.error); else render(response.state);
    });
  }
}

function render(next) {
  state = next;
  const providerHost = $('providers');
  const providers = Array.isArray(state.providers) ? state.providers : [];
  if (!providers.length) {
    providerHost.innerHTML = `<div class="providerUpdate">
      <strong>WatchBridge update pending</strong>
      <small>The popup is newer than the running service worker. Reload once to activate provider controls and new optional permissions.</small>
      <button id="reloadExtension" class="primary full">Reload WatchBridge</button>
    </div>`;
    providerHost.querySelector('#reloadExtension').addEventListener('click', () => chrome.runtime.reload());
  } else if (!providerHost.contains(document.activeElement) || document.activeElement?.tagName === 'BUTTON') {
    providerHost.innerHTML = providers.map(providerMarkup).join('');
    bindProviderControls();
  }
  $('interval').value = state.settings.intervalMinutes ?? 30;

  $('redirectUri').textContent = state.redirectUri;
  // Polling must never clobber credentials while the user is typing.
  // Hydrate the draft once when the popup opens; after that it belongs to the user
  // until OAuth persists a Client ID or the popup is reopened.
  if (!authDraftHydrated) {
    $('clientId').value = state.oauthDraft?.clientId || state.simkl.clientId || '';
    $('clientSecret').value = state.oauthDraft?.clientSecret || '';
    authDraftHydrated = true;
  } else if (state.simkl.connected && state.simkl.clientId) {
    $('clientId').value = state.simkl.clientId;
  }
  if (state.simkl.connected) $('clientSecret').value = '';
  $('simklDisconnected').hidden = state.simkl.connected;
  $('simklConnected').hidden = !state.simkl.connected;

  const sync = state.sync;
  const badge = $('statusBadge');
  badge.className = 'badge';
  if (sync.running) {
    badge.textContent = sync.phase || 'Syncing';
    badge.classList.add('busy');
  } else if (sync.lastError) {
    badge.textContent = 'Error';
    badge.classList.add('error');
  } else {
    badge.textContent = sync.phase === 'done' ? 'Done' : 'Idle';
  }

  const runnable = providers.some(provider => (
    provider.settings?.enabled && provider.permissionGranted && provider.capabilities.historyBackfill
  ));
  $('syncNow').disabled = sync.running || !runnable || !state.simkl.connected;
  $('syncNow').textContent = sync.running ? `Syncing: ${sync.phase}…` : 'Sync now';

  const providerStats = Object.values(sync.lastStatsByProvider || {});
  const s = sync.lastStats;
  $('stats').innerHTML = s ? [
    `<strong>Last:</strong> ${formatTime(s.finishedAt)}`,
    ...providerStats.map(item => `<strong>[${escapeHtml(item.provider)}]</strong> scanned ${item.scanned ?? 0}, sent ${item.sent ?? 0}, unmatched ${item.unmatched ?? 0}`),
    `<strong>Stored unmatched:</strong> ${sync.unmatchedRecords?.length ?? 0}`,
    `<strong>Queue:</strong> ${sync.queue?.length ?? 0}`,
    `<strong>Dead:</strong> ${sync.deadLetters?.length ?? 0}`
  ].join(' · ') : 'No sync yet.';
  if (sync.lastError) $('stats').innerHTML += `<div class="log error">${escapeHtml(sync.lastError)}</div>`;

  $('logs').innerHTML = (state.logs || []).slice(0, 30).map(log =>
    `<div class="log ${log.level || ''}"><time>${escapeHtml(log.at.slice(0,19).replace('T',' '))}</time> ${escapeHtml(log.message)}</div>`
  ).join('') || '<div class="log">No logs.</div>';

  $('footer').textContent = `v${chrome.runtime.getManifest().version} · ${state.extensionId}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

async function refresh() {
  const response = await send({ type: 'getState' });
  if (response.ok) render(response.state);
}


// Chrome action popups close as soon as the user switches to another tab/window.
// Persist each credential field while it is being typed so copying the second
// credential from elsewhere never destroys the first one. Client ID is a local
// draft; the secret exists only in storage.session and is cleared after OAuth.
$('clientId').addEventListener('input', () => {
  saveOAuthDraft({ clientId: $('clientId').value }).catch(() => {});
});

$('clientSecret').addEventListener('input', () => {
  saveOAuthDraft({ clientSecret: $('clientSecret').value }).catch(() => {});
});

$('interval').addEventListener('change', async () => {
  const response = await send({ type: 'setInterval', value: $('interval').value });
  if (response.ok) render(response.state);
});

$('connectSimkl').addEventListener('click', () => {
  // Same rule as Netflix: the optional host permission request happens directly in the click.
  chrome.permissions.request({ origins: [SIMKL_API_ORIGIN] }, async granted => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message);
      return;
    }
    if (!granted) {
      alert('Simkl API access was not granted.');
      return;
    }

    const button = $('connectSimkl');
    setBusy(button, true, 'Opening Simkl…');
    const response = await send({
      type: 'beginOAuth',
      clientId: $('clientId').value.trim(),
      clientSecret: $('clientSecret').value
    });
    setBusy(button, false, 'Connect Simkl');
    if (!response.ok) alert(response.error);
  });
});

$('disconnectSimkl').addEventListener('click', async () => {
  const response = await send({ type: 'disconnectSimkl' });
  if (!response.ok) alert(response.error); else render(response.state);
});

$('syncNow').addEventListener('click', async () => {
  const button = $('syncNow');
  setBusy(button, true, 'Syncing…');
  // Do not block UI rendering on a long first import; periodic refresh shows persisted state.
  send({ type: 'syncNow' }).then(response => {
    if (!response.ok) alert(response.error);
    refresh();
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  await refresh();
});

$('resetCheckpoint').addEventListener('click', async () => {
  if (!confirm('Reset checkpoints and re-read enabled provider histories on next sync?')) return;
  const response = await send({ type: 'resetCheckpoint' });
  if (!response.ok) alert(response.error); else render(response.state);
});

$('clearLogs').addEventListener('click', async () => {
  const response = await send({ type: 'clearLogs' });
  if (response.ok) render(response.state);
});

refresh();
pollTimer = setInterval(refresh, 1200);
window.addEventListener('unload', () => clearInterval(pollTimer));
