const params = new URLSearchParams(location.search);
const payload = {
  type: 'finishOAuth',
  code: params.get('code') || '',
  state: params.get('state') || '',
  error: params.get('error') || ''
};

chrome.runtime.sendMessage(payload, response => {
  const el = document.getElementById('status');
  if (chrome.runtime.lastError) {
    el.textContent = `Authorization failed: ${chrome.runtime.lastError.message}`;
    return;
  }
  if (!response?.ok) {
    el.textContent = `Authorization failed: ${response?.error || 'Unknown error'}`;
    return;
  }
  el.textContent = 'Simkl connected. You can close this tab.';
  setTimeout(() => window.close(), 1200);
});
