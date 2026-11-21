/**
 * Relay-owned administration UI. Identity authentication is delegated to
 * Agent Address OAuth; Wake configuration remains in Relay's D1 database.
 */
export class RelayManagementPage {
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly callbackURI = RelayManagementPage.origin + '/manage/callback';

  static page(): Response {
    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nuwa Relay · 接線管理</title>
<style>
:root { font-family: system-ui, "Noto Sans TC", sans-serif; color-scheme: light; color: #173b34; background: #f7f9f5; }
body { margin: 0; }
header { padding: 1.25rem max(1rem, calc((100vw - 60rem) / 2)); background: #e8f4ee; border-bottom: 1px solid #c8dcd2; }
header strong { font-size: 1.3rem; }
main { max-width: 60rem; padding: 1.5rem 1rem 4rem; margin: auto; }
section { background: white; border: 1px solid #dce8e2; border-radius: .9rem; padding: 1.4rem; margin-top: 1.3rem; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; } h2 { font-size: 1.2rem; }
p, li { line-height: 1.7; } small { color: #546d61; }
button { cursor: pointer; background: #14664c; color: white; border: 0; border-radius: .45rem; padding: .65rem .9rem; font: inherit; }
button.secondary { background: #e5efea; color: #1a503d; }
input { box-sizing: border-box; width: 100%; padding: .7rem; border: 1px solid #a5bfb2; border-radius: .4rem; font: inherit; }
label { display: block; margin: .8rem 0 .3rem; font-weight: 600; }
.receiver { border-bottom: 1px solid #edf3ef; padding: .8rem 0; }
.receiver:last-child { border: 0; }
.receiver button { margin-top: .6rem; }
#notice { min-height: 1.5rem; }
[hidden] { display: none !important; }
</style>
<script src="/manage.js" defer></script>
</head>
<body>
<header><strong>Nuwa Relay</strong> · 接線管理</header>
<main>
<h1>Wake 接收設定</h1>
<p>管理你在 Nuwa Relay 的接線網址。身分由 Agent Address 安全授權，接收設定保存在 Nuwa Relay。</p>
<p id="notice" role="status" aria-live="polite"></p>
<section id="loginPanel">
<h2>登入管理</h2>
<p>使用 Agent Address 的 Organization 帳戶登入，完成後會回到這個頁面。</p>
<button id="signIn" type="button">使用 Agent Address 登入</button>
</section>
<section id="management" hidden>
<button id="signOut" type="button" class="secondary">登出</button>
<h2>已有 Wake 的 Gateway / Session</h2>
<p><small>清單僅顯示已設定的接收器與公開主機名稱；私密 Webhook 路徑和 Bearer key 不會顯示。</small></p>
<div id="receivers"></div>
</section>
<section id="recoverPanel" hidden>
<h2>恢復尚未完成的首次聯絡</h2>
<p>當原生 Webhook 連線中斷、重新發送仍顯示等待首次聯絡時，可在確認收件平台沒有建立原生對話後恢復原本的待送訊息。</p>
<p id="selectedGateway"></p>
<div id="pendingContacts"></div>
<p><button id="closeRecoveries" class="secondary" type="button">關閉恢復清單</button></p>
</section>
<section id="editPanel" hidden>
<h2>更新 Wake 網址</h2>
<p id="selectedSession"></p>
<p>貼上新的 Quick Tunnel HTTPS 網域即可沿用既有 Webhook 路徑與認證金鑰；如例行任務路徑已變更，請貼上新的完整 HTTPS URL。</p>
<form id="wakeForm">
<label for="callbackUrl">新的 Tunnel 或完整 Webhook HTTPS URL</label>
<input id="callbackUrl" type="url" required autocomplete="off" placeholder="https://new-tunnel.trycloudflare.com">
<p><button type="submit">儲存 Wake 網址</button> <button id="cancelEdit" class="secondary" type="button">取消</button></p>
</form>
<small>變更只更新接收目的地。這不會重新配對，也不會改變原有 Gateway 身分、同事名錄或原生對話。</small>
</section>
<p><small>Agent Address 身分管理：<a href="https://address.company-notes.com/portal/">Organization Portal</a></small></p>
</main>
</body>
</html>`;
    const response = new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    response.headers.set('content-security-policy',
      "default-src 'none'; script-src 'self'; connect-src 'self'; " +
      "style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-frame-options', 'DENY');
    return response;
  }

  static script(): Response {
    const source = `(() => {
  'use strict';
  const addressAuthorize = 'https://address.company-notes.com/authorize';
  const callback = 'https://agent-relay.company-notes.com/manage/callback';
  const tokenKey = 'nuwaRelayManagementOAuthToken';
  const verifierKey = 'nuwaRelayManagementVerifier';
  const stateKey = 'nuwaRelayManagementState';
  const clientKey = 'nuwaRelayManagementClient';
  const notice = document.getElementById('notice');
  const loginPanel = document.getElementById('loginPanel');
  const management = document.getElementById('management');
  const editPanel = document.getElementById('editPanel');
  const recoverPanel = document.getElementById('recoverPanel');
  const pendingContacts = document.getElementById('pendingContacts');
  const receivers = document.getElementById('receivers');
  let activeSession = null;

  function message(text) {
    notice.textContent = text;
  }

  async function api(method, path, body, authenticated) {
    const token = sessionStorage.getItem(tokenKey);
    const headers = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (authenticated) {
      headers.authorization = 'Bearer ' + token;
    }

    const response = await fetch(path, {
      method, headers, cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error && result.error.message || 'Relay 無法完成操作。');
    }
    return result.data;
  }

  function base64URL(bytes) {
    let raw = '';
    bytes.forEach((byte) => {
      raw += String.fromCharCode(byte);
    });
    return btoa(raw).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  }

  async function signIn() {
    try {
      message('前往 Agent Address 授權…');
      const registration = await api('POST', '/manage/oauth/client', {}, false);
      const verifier = base64URL(crypto.getRandomValues(new Uint8Array(32)));
      const state = base64URL(crypto.getRandomValues(new Uint8Array(24)));
      const digest = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(verifier));
      sessionStorage.setItem(verifierKey, verifier);
      sessionStorage.setItem(stateKey, state);
      sessionStorage.setItem(clientKey, registration.clientId);

      const query = new URLSearchParams({
        response_type: 'code', client_id: registration.clientId,
        redirect_uri: callback, state, code_challenge: base64URL(new Uint8Array(digest)),
        code_challenge_method: 'S256',
      });
      window.location.assign(addressAuthorize + '?' + query.toString());
    } catch (error) {
      message(error.message);
    }
  }

  async function completeSignIn() {
    if (window.location.pathname !== '/manage/callback') {
      return;
    }
    const query = new URLSearchParams(window.location.search);
    const state = query.get('state');
    const code = query.get('code');
    const verifier = sessionStorage.getItem(verifierKey);
    const clientId = sessionStorage.getItem(clientKey);

    if (!code || !state || state !== sessionStorage.getItem(stateKey) ||
        !verifier || !clientId) {
      throw new Error('Agent Address 授權不完整，請重新登入。');
    }

    const value = await api('POST', '/manage/oauth/token',
      { clientId, code, verifier }, false);
    sessionStorage.setItem(tokenKey, value.accessToken);
    [stateKey, verifierKey, clientKey].forEach((key) => sessionStorage.removeItem(key));
    window.history.replaceState({}, '', '/manage');
  }

  async function showRecoveries(entry) {
    const path = '/v2/management/sessions/' +
      encodeURIComponent(entry.sessionID) + '/first-contacts';
    const contacts = await api('GET', path, undefined, true);
    document.getElementById('selectedGateway').textContent = entry.canonical;
    pendingContacts.replaceChildren();
    recoverPanel.hidden = false;
    editPanel.hidden = true;

    if (contacts.length === 0) {
      pendingContacts.textContent = '目前沒有符合安全恢復條件的首次聯絡。';
    }

    contacts.forEach((contact) => {
      const row = document.createElement('div');
      row.className = 'receiver';
      const title = document.createElement('strong');
      title.textContent = contact.senderCanonicalAddress + ' → ' +
        contact.recipientCanonicalAddress;
      const detail = document.createElement('div');
      detail.textContent = '原始 Message ID：' + contact.initialMessageID +
        ' · 已嘗試 ' + contact.initialWakeAttempts + ' 次';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '確認未建立對話並恢復';
      button.addEventListener('click', () => {
        const accepted = window.confirm(
          '請先確認收件助理沒有收到原始訊息、也沒有建立原生對話。' +
          '確定後會重新排程原始 Wake，可能觸發一次新的原生轉交。確定恢復？');
        if (!accepted) {
          return;
        }

        void api('POST', path + '/recover', {
          senderSessionID: contact.senderSessionID,
          recipientSessionID: contact.recipientSessionID,
          initialMessageID: contact.initialMessageID,
          confirmedNoNativeDelivery: true,
        }, true).then(() => showRecoveries(entry)).then(() => {
          message('已解除這一組首次聯絡的保留，原始 Wake 已優先排入重試。');
        }).catch((error) => message(error.message));
      });
      row.append(title, detail, button);
      pendingContacts.append(row);
    });
  }

  function showEditor(entry) {
    recoverPanel.hidden = true;
    activeSession = entry.sessionID;
    document.getElementById('selectedSession').textContent =
      entry.canonical + ' · ' + entry.callbackHost;
    document.getElementById('callbackUrl').value = '';
    editPanel.hidden = false;
    document.getElementById('callbackUrl').focus();
  }

  async function load() {
    if (!sessionStorage.getItem(tokenKey)) {
      loginPanel.hidden = false;
      management.hidden = true;
      editPanel.hidden = true;
      recoverPanel.hidden = true;
      return;
    }

    const entries = await api('GET', '/v2/management/wake-sessions', undefined, true);
    loginPanel.hidden = true;
    management.hidden = false;
    receivers.replaceChildren();
    if (entries.length === 0) {
      receivers.textContent = '這個 Organization 目前沒有已設定的 Wake 接收器。';
    }

    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'receiver';
      const title = document.createElement('strong');
      title.textContent = entry.canonical;
      const detail = document.createElement('div');
      detail.textContent = entry.callbackHost + ' · ' + entry.authMode;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '更新連線網址';
      edit.addEventListener('click', () => showEditor(entry));
      const recover = document.createElement('button');
      recover.type = 'button';
      recover.textContent = '查看待恢復首聯';
      recover.className = 'secondary';
      recover.addEventListener('click', () => {
        void showRecoveries(entry).catch((error) => message(error.message));
      });
      row.append(title, detail, edit, recover);
      receivers.append(row);
    });
    message('已載入你有權管理的 Wake 接收器。');
  }

  async function save(event) {
    event.preventDefault();
    if (!activeSession) {
      return;
    }
    const newURL = document.getElementById('callbackUrl').value;
    const target = new URL(newURL);
    if (target.protocol !== 'https:') {
      message('請填寫公開的 HTTPS URL。');
      return;
    }

    try {
      message('儲存 Wake 網址…');
      await api('PUT', '/v2/management/sessions/' +
        encodeURIComponent(activeSession) + '/wake-endpoint',
        { callbackUrl: newURL }, true);
      editPanel.hidden = true;
      await load();
      message('Wake 網址已更新，原本的接收金鑰及 Thread 保持不變。');
    } catch (error) {
      message(error.message);
    }
  }

  document.getElementById('signIn').addEventListener('click', () => { void signIn(); });
  document.getElementById('signOut').addEventListener('click', () => {
    sessionStorage.removeItem(tokenKey);
    void load();
    message('已登出 Relay 接線管理。');
  });
  document.getElementById('cancelEdit').addEventListener('click', () => {
    editPanel.hidden = true;
  });
  document.getElementById('closeRecoveries').addEventListener('click', () => {
    recoverPanel.hidden = true;
  });
  document.getElementById('wakeForm').addEventListener('submit', (event) => {
    void save(event);
  });

  void completeSignIn().then(load).catch((error) => {
    sessionStorage.removeItem(tokenKey);
    loginPanel.hidden = false;
    management.hidden = true;
    message(error.message);
  });
})();`;
    return new Response(source, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
}
