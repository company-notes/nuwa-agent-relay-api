/** Owns smoke OAuth credentials, refresh, persistence and account scoping. */
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { addressOrigin, assert, statePath } from './SmokeConfig.mjs';
import { SmokeLogger } from './Logger.mjs';

const EXPIRY_MARGIN_MS = 60_000;
const logger = new SmokeLogger('smoke.oauth.credentials');

export function authFile(side) {
  assert(['a', 'b'].includes(side), 'Login side must be a or b.');

  return join(dirname(statePath), 'auth-' + side + '.json');
}

export function verifyOrigin(origin) {
  const url = new URL(origin);

  assert(url.protocol === 'https:' && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/', 'OAuth server must be an HTTPS origin.');

  return url.origin;
}

export async function oauthPost(origin, path, body, type = 'form') {
  const payload = type === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString();
  const response = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': type === 'json'
        ? 'application/json'
        : 'application/x-www-form-urlencoded',
    },
    body: payload,
    signal: AbortSignal.timeout(20_000),
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error('OAuth ' + path + ' returned non-JSON HTTP ' + response.status);
  }

  if (!response.ok) {
    // Never print token requests, responses, redirect URLs, or secrets.
    const error = typeof data?.error === 'string' ? data.error : 'oauth_request_failed';

    throw new Error('OAuth ' + path + ' failed (HTTP ' + response.status + ', ' + error + ').');
  }

  return data;
}

export function requireTokenPayload(data) {
  assert(typeof data?.access_token === 'string' && data.access_token.length > 0,
    'OAuth token endpoint returned no access token.');
  assert(!data.token_type || data.token_type.toLowerCase() === 'bearer',
    'OAuth token type must be Bearer.');

  return data;
}

export async function saveAuth(side, auth) {
  const file = authFile(side);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });

  const temp = file + '.' + process.pid + '.tmp';

  try {
    await writeFile(temp, JSON.stringify(auth, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temp, file);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch (cleanupError) {
      logger.exception('credential_temp_cleanup_failed', cleanupError);
    }

    throw error;
  }
}

export async function readSavedToken(side, expectedOrigin = addressOrigin) {
  const primary = authFile(side);
  let auth;

  try {
    auth = JSON.parse(await readFile(primary, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && side === 'b') {
      return readSavedToken('a', expectedOrigin);
    }

    if (error.code === 'ENOENT') {
      throw new Error('尚未登入。請先執行 npm run smoke:login。');
    }

    throw error;
  }

  assert(auth.version === 1 && auth.origin === verifyOrigin(expectedOrigin) &&
    typeof auth.clientId === 'string', '本機 OAuth 憑證與 Agent Address 服務不一致，請重新登入。');
  assert(typeof auth.accessToken === 'string', '本機 OAuth 憑證缺少 Access Token。');

  if (auth.expiresAt === null || Date.now() + EXPIRY_MARGIN_MS < auth.expiresAt) {
    return auth.accessToken;
  }

  assert(auth.refreshToken, 'OAuth Access Token 已到期，請重新執行 npm run smoke:login。');
  const data = requireTokenPayload(await oauthPost(auth.origin, '/token', {
    grant_type: 'refresh_token',
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
  }));

  auth.accessToken = data.access_token;
  auth.refreshToken = data.refresh_token || auth.refreshToken;
  auth.expiresAt = Number.isFinite(data.expires_in) ? Date.now() + data.expires_in * 1000 : null;
  await saveAuth(side, auth);

  return auth.accessToken;
}
