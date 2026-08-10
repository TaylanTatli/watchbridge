import { postJson } from '../../core/http.js';
import { saveSimkl, setPendingOAuth, getPendingOAuth, clearPendingOAuth, clearOAuthSecretDraft, addLog } from '../../core/storage.js';

const AUTH_URL = 'https://simkl.com/oauth/authorize';
const TOKEN_URL = 'https://api.simkl.com/oauth/token';

export function redirectUri() {
  return chrome.runtime.getURL('src/ui/oauth.html');
}

export async function beginOAuth(clientId, clientSecret) {
  if (!clientId?.trim() || !clientSecret?.trim()) throw new Error('Client ID and Client Secret are required.');
  const state = crypto.randomUUID();
  await saveSimkl({ clientId: clientId.trim(), accessToken: '' });
  await setPendingOAuth({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), state, createdAt: Date.now() });

  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId.trim());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  await chrome.tabs.create({ url: url.toString() });
}

export async function finishOAuth({ code, state, error }) {
  if (error) throw new Error(`Simkl OAuth error: ${error}`);
  if (!code) throw new Error('Simkl did not return an authorization code.');

  const pending = await getPendingOAuth();
  if (!pending) throw new Error('OAuth session expired. Start Connect Simkl again.');
  if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
    await clearPendingOAuth();
    throw new Error('OAuth session expired.');
  }
  if (!state || state !== pending.state) throw new Error('OAuth state mismatch.');

  try {
    const result = await postJson(TOKEN_URL, {
      code,
      client_id: pending.clientId,
      client_secret: pending.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    });
    if (!result?.access_token) throw new Error(result?.error || 'Simkl token response did not contain access_token.');
    await saveSimkl({ clientId: pending.clientId, accessToken: result.access_token });
    await addLog('info', '[Simkl] OAuth connected successfully.');
    return true;
  } finally {
    // Never persist the client secret beyond the OAuth exchange.
    await clearPendingOAuth();
    await clearOAuthSecretDraft();
  }
}
