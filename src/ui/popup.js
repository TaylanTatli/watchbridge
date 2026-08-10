import { saveOAuthDraft } from '../core/storage.js';

const NETFLIX_ORIGIN = 'https://www.netflix.com/*';
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

function render(next) {
  state = next;
  const permission = state.netflixPermission;
  const enabled = state.settings.netflixEnabled;
  $('netflixPermissionText').textContent = permission
    ? (enabled ? 'Granted · provider enabled' : 'Granted · provider disabled')
    : 'Not granted';
  $('enableNetflix').textContent = permission && enabled ? 'Enabled' : 'Enable Netflix';
  $('enableNetflix').disabled = permission && enabled;
  $('threshold').value = state.settings.threshold ?? 70;
  $('interval').value = state.settings.intervalMinutes ?? 30;
  $('revokeNetflix').disabled = !permission;
  $('disableNetflix').disabled = !enabled;

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

  $('syncNow').disabled = sync.running || !enabled || !permission || !state.simkl.connected;
  $('syncNow').textContent = sync.running ? `Syncing: ${sync.phase}…` : 'Sync now';

  const s = sync.lastStats;
  $('stats').innerHTML = s ? [
    `<strong>Last:</strong> ${formatTime(s.finishedAt)}`,
    `<strong>Scanned:</strong> ${s.scanned ?? 0}`,
    `<strong>Eligible:</strong> ${s.eligible ?? 0}`,
    `<strong>Sent:</strong> ${s.sent ?? 0}`,
    `<strong>&lt; threshold:</strong> ${s.skippedUnderThreshold ?? 0}`,
    `<strong>Unmatched:</strong> ${s.unmatched ?? 0}`,
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

// IMPORTANT: permission request is the first operation in the user's click handler.
// No await, worker message or hidden window occurs before chrome.permissions.request().
$('enableNetflix').addEventListener('click', () => {
  chrome.permissions.request({ origins: [NETFLIX_ORIGIN] }, async granted => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message);
      return;
    }
    if (!granted) {
      alert('Netflix site access was not granted.');
      await refresh();
      return;
    }
    const response = await send({ type: 'setNetflixEnabled', enabled: true });
    if (!response.ok) alert(response.error);
    else render(response.state);
  });
});

$('disableNetflix').addEventListener('click', async () => {
  const response = await send({ type: 'setNetflixEnabled', enabled: false });
  if (!response.ok) alert(response.error); else render(response.state);
});

$('revokeNetflix').addEventListener('click', () => {
  chrome.permissions.remove({ origins: [NETFLIX_ORIGIN] }, async removed => {
    if (removed) await send({ type: 'setNetflixEnabled', enabled: false });
    await refresh();
  });
});

$('threshold').addEventListener('change', async () => {
  const response = await send({ type: 'setThreshold', value: $('threshold').value });
  if (response.ok) render(response.state);
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
  if (!confirm('Reset checkpoint and re-read the full Netflix history on next sync?')) return;
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
