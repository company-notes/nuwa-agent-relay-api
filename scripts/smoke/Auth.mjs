import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { addressOrigin, assert, statePath } from './Shared.mjs';
import { SmokeLogger } from './Logger.mjs';

const AUTH_TIMEOUT_MS = 180_000;
const EXPIRY_MARGIN_MS = 60_000;
const logger = new SmokeLogger('smoke.oauth');

export function authFile(side) {
  assert(['a', 'b'].includes(side), 'Login side must be a or b.');

  return join(dirname(statePath), 'auth-' + side + '.json');
}

export function oauthChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizationURL(origin, clientId, redirectURI, verifier, state) {
  const url = new URL('/authorize', origin);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectURI);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', oauthChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}

export function checkCallback(url, expectedState) {
  const callback = new URL(url, 'http://127.0.0.1');
  const values = callback.searchParams.getAll('state');

  if (callback.pathname !== '/oauth/callback' || values.length !== 1) {
    throw new Error('Unexpected OAuth callback.');
  }

  const provided = Buffer.from(values[0]);
  const expected = Buffer.from(expectedState);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('OAuth state mismatch. Login was not accepted.');
  }

  if (callback.searchParams.has('error')) {
    throw new Error('OAuth authorization was denied: ' + callback.searchParams.get('error'));
  }

  const codes = callback.searchParams.getAll('code');
  assert(codes.length === 1 && codes[0], 'OAuth callback did not contain one authorization code.');

  return codes[0];
}

function verifyOrigin(origin) {
  const url = new URL(origin);

  assert(url.protocol === 'https:' && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/', 'OAuth server must be an HTTPS origin.');

  return url.origin;
}

async function oauthPost(origin, path, body, type = 'form') {
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

function requireTokenPayload(data) {
  assert(typeof data?.access_token === 'string' && data.access_token.length > 0,
    'OAuth token endpoint returned no access token.');
  assert(!data.token_type || data.token_type.toLowerCase() === 'bearer',
    'OAuth token type must be Bearer.');

  return data;
}

async function saveAuth(side, auth) {
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
    await rm(temp, { force: true });

    throw error;
  }
}

function openBrowser(url) {
  if (process.env.RELAY_SMOKE_NO_BROWSER === '1') {
    return;
  }

  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? null
      : 'xdg-open';

  // Avoid shell expansion of URL query parameters (especially on Windows).
  if (command) {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', (error) => {
      logger.exception('browser_launch_failed', error);
    });
    child.unref();
  }
}

export async function listenForCallback(state, timeoutMs = AUTH_TIMEOUT_MS) {
  let accept;
  let reject;
  let finished = false;
  const received = new Promise((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });

  // If client registration fails before the browser opens, close() rejects this
  // pending promise. Attach a rejection handler before any external request.
  received.catch((error) => {
    // An early rejection is still handled by the login flow; record its type.
    logger.exception('callback_pending_rejected', error);
  });
  const server = createServer((req, res) => {
    const host = req.headers.host;
    const localAddress = server.address();

    if (req.method !== 'GET' || host !== '127.0.0.1:' + localAddress.port) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
      return;
    }

    try {
      const code = checkCallback(req.url, state);

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end('<!doctype html><meta charset="utf-8"><h2>Agent Address 已登入</h2><p>可以返回終端機。</p>');

      if (!finished) {
        finished = true;
        accept(code);
      }
    } catch (error) {
      logger.exception('callback_rejected', error);
      res.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('Authorization response was rejected.');

      // Ignore invalid local callbacks; PKCE state must not be bypassed.
      if (error instanceof Error && error.message.startsWith('OAuth authorization was denied')) {
        if (!finished) {
          finished = true;
          reject(error);
        }
      }
    }
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, rejectListen) => {
    server.once('listening', resolve);
    server.once('error', rejectListen);
  });

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      reject(new Error('OAuth login timed out. Run smoke:login again.'));
    }
  }, timeoutMs);
  const port = server.address().port;
  const redirectURI = 'http://127.0.0.1:' + port + '/oauth/callback';

  return {
    redirectURI,
    received,
    close: async () => {
      clearTimeout(timer);
      // Handle a pending receiver when the login aborted before callback.
      if (!finished) {
        finished = true;
        reject(new Error('OAuth login cancelled.'));
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function browserLogin(side = 'a') {
  const origin = verifyOrigin(addressOrigin);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const receiver = await listenForCallback(state);

  try {
    const client = await oauthPost(origin, '/register', {
      client_name: 'Nuwa Agent Relay Local Smoke Test',
      redirect_uris: [receiver.redirectURI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }, 'json');

    assert(typeof client.client_id === 'string' && client.client_id,
      'OAuth client registration did not return a client_id.');

    const authURL = buildAuthorizationURL(
      origin, client.client_id, receiver.redirectURI, verifier, state,
    );
    console.log('請在瀏覽器登入 Agent Address：');
    console.log(authURL);
    console.log('本機回呼網址：' + receiver.redirectURI);
    openBrowser(authURL);

    const code = await receiver.received;
    const data = requireTokenPayload(await oauthPost(origin, '/token', {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: receiver.redirectURI,
      code_verifier: verifier,
    }));

    const now = Date.now();
    await saveAuth(side, {
      version: 1,
      origin,
      clientId: client.client_id,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: Number.isFinite(data.expires_in) ? now + data.expires_in * 1000 : null,
      loginAt: new Date(now).toISOString(),
    });

    console.log('OAuth 登入完成。憑證只存放於本機 ' + authFile(side));
    console.log('下一步：npm run smoke:setup');
  } finally {
    await receiver.close();
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

export async function removeLocalAuth() {
  for (const side of ['a', 'b']) {
    await rm(authFile(side), { force: true });
  }
}
