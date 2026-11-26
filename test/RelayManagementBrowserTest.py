#!/usr/bin/env python3
"""Real Chromium flow for Relay Wake management; account service stays isolated."""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright


class ManagementScenarioServer:
    """Serve the actual Relay HTML/JS while isolating external OAuth/API effects."""

    def __init__(self) -> None:
        repoRoot = Path(__file__).resolve().parents[1]
        source = (
            "import { RelayManagementPage } from './src/RelayManagementPage.ts';"
            "console.log(JSON.stringify({"
            "html: await RelayManagementPage.page().text(),"
            "script: await RelayManagementPage.script().text()"
            "}));"
        )
        compiled = subprocess.check_output(
            ['node', '--input-type=module', '--eval', source],
            cwd=repoRoot, text=True,
        )
        assets = json.loads(compiled)
        self.html = assets['html']
        self.script = assets['script']
        self.callbackHost = 'old-tunnel.trycloudflare.com'
        self.updated = 0
        self.recovered = 0
        self.resetCompleted = 0
        self.policy = {'id': '11111111-1111-4111-8111-111111111111', 'canonical': 'nuwainfo/coder',
                       'displayName': 'Coder', 'mode': 'unconfigured', 'revision': 0}
        self.updateBody: dict[str, str] = {}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def handler(self) -> type[BaseHTTPRequestHandler]:
        scenario = self

        class ManagementHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                pass

            def respond(self, code: int, body: str,
                        contentType: str = 'text/html; charset=utf-8') -> None:
                data = body.encode('utf-8')
                self.send_response(code)
                self.send_header('content-type', contentType)
                self.send_header('cache-control', 'no-store')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def payload(self) -> dict[str, str]:
                length = int(self.headers.get('content-length', '0'))
                return json.loads(self.rfile.read(length))

            def requireOAuth(self) -> bool:
                if self.headers.get('authorization') == 'Bearer test-account-token':
                    return True
                self.respond(401, json.dumps({'ok': False, 'error': {
                    'message': 'Unauthorized'}}), 'application/json')
                return False

            def do_GET(self) -> None:
                path = urlsplit(self.path).path
                if path in ('/manage', '/manage/callback'):
                    self.respond(200, scenario.html)
                    return

                if path == '/manage.js':
                    self.respond(200, scenario.script, 'application/javascript')
                    return

                if path == '/v2/management/sessions/test-gateway-main/first-contacts':
                    if not self.requireOAuth():
                        return

                    entries = [] if scenario.recovered else [{
                        'senderSessionID': 'session-a',
                        'recipientSessionID': 'session-b',
                        'senderCanonicalAddress': 'relay-test-org/tammy/main',
                        'recipientCanonicalAddress': 'relay-test-org/may/main',
                        'initialMessageID': 'lost-first-message',
                        'initialWakeAttempts': 1,
                    }]
                    self.respond(200, json.dumps({
                        'ok': True, 'data': entries}), 'application/json')
                    return

                if path == '/v2/management/collaboration-policies':
                    if not self.requireOAuth():
                        return
                    self.respond(200, json.dumps({'ok': True, 'data': {
                        'canEdit': True, 'policies': [scenario.policy],
                    }}), 'application/json')
                    return

                if path == '/v2/management/agents':
                    if not self.requireOAuth():
                        return
                    records = [] if scenario.resetCompleted else [{
                        'id': 'test-gateway-id',
                        'canonical': 'nuwainfo/gateway/main',
                        'displayName': 'GrokBot Gateway',
                    }]
                    self.respond(200, json.dumps({'ok': True, 'data': records}), 'application/json')
                    return

                if path == '/v2/management/agents/test-gateway-id/data':
                    if not self.requireOAuth():
                        return
                    self.respond(200, json.dumps({
                        'ok': True, 'data': {
                            'targetAgentID': 'test-gateway-id',
                            'targetCanonical': 'nuwainfo/gateway/main',
                            'confirmation': 'RESET nuwainfo/gateway/main',
                            'fingerprint': 'test-preview-fingerprint',
                            'stage': 'preview',
                            'members': [{
                                'id': 'test-gateway-id',
                                'addressPrefix': 'nuwainfo/gateway',
                                'displayName': 'GrokBot Gateway',
                                'sessions': 1,
                            }],
                            'conversationCount': 2, 'mailboxCount': 1, 'protectedCoworkers': 0,
                        },
                    }), 'application/json')
                    return

                if path == '/v2/management/wake-sessions':
                    if not self.requireOAuth():
                        return
                    self.respond(200, json.dumps({'ok': True, 'data': [{
                        'sessionID': 'test-gateway-main',
                        'canonical': 'nuwainfo/gateway/main',
                        'authMode': 'bearer',
                        'callbackHost': scenario.callbackHost,
                    }]}), 'application/json')
                    return

                self.respond(404, 'Not Found')

            def do_POST(self) -> None:
                body = self.payload()
                if self.path == '/v2/management/sessions/test-gateway-main/first-contacts/recover':
                    if not self.requireOAuth():
                        return

                    assert body == {
                        'senderSessionID': 'session-a',
                        'recipientSessionID': 'session-b',
                        'initialMessageID': 'lost-first-message',
                        'confirmedNoNativeDelivery': True,
                    }
                    scenario.recovered += 1
                    self.respond(200, json.dumps({
                        'ok': True,
                        'data': { 'recovered': True,
                                  'initialMessageID': 'lost-first-message' },
                    }), 'application/json')
                    return

                if self.path == '/manage/oauth/client':
                    self.respond(201, json.dumps({'ok': True, 'data': {
                        'clientId': 'test-public-client'}}), 'application/json')
                    return

                if self.path == '/manage/oauth/token':
                    assert body['clientId'] == 'test-public-client'
                    assert body['code'] == 'authorized-code'
                    assert len(body['verifier']) >= 43
                    self.respond(200, json.dumps({'ok': True, 'data': {
                        'accessToken': 'test-account-token'}}), 'application/json')
                    return

                self.respond(404, 'Not Found')

            def do_DELETE(self) -> None:
                if not self.requireOAuth():
                    return

                if self.path != '/v2/management/agents/test-gateway-id/data':
                    self.respond(404, 'Not Found')
                    return

                body = self.payload()
                assert body == {
                    'confirmation': 'RESET nuwainfo/gateway/main',
                    'fingerprint': 'test-preview-fingerprint',
                }
                scenario.resetCompleted += 1
                self.respond(200, json.dumps({
                    'ok': True, 'data': { 'completed': True },
                }), 'application/json')

            def do_PUT(self) -> None:
                if not self.requireOAuth():
                    return
                if self.path == '/v2/management/collaboration-policies/' + scenario.policy['id']:
                    body = self.payload()
                    assert body['revision'] == scenario.policy['revision']
                    assert body['mode'] in ('manual', 'autonomous')
                    scenario.policy.update(mode=body['mode'], revision=body['revision'] + 1)
                    self.respond(200, json.dumps({'ok': True, 'data': scenario.policy}), 'application/json')
                    return

                if self.path != '/v2/management/sessions/test-gateway-main/wake-endpoint':
                    self.respond(404, 'Not Found')
                    return

                body = self.payload()
                assert body == {'callbackUrl': 'https://new-tunnel.trycloudflare.com'}
                scenario.updateBody = body
                scenario.callbackHost = 'new-tunnel.trycloudflare.com'
                scenario.updated += 1
                self.respond(200, json.dumps({'ok': True, 'data': {
                    'enabled': True,
                    'callbackHost': scenario.callbackHost,
                    'authMode': 'bearer',
                }}), 'application/json')

        return ManagementHandler

    def start(self) -> None:
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class RelayManagementBrowserTest(unittest.TestCase):
    """A Gateway owner logs in, chooses a Session, and updates its Tunnel host."""

    def testOwnerRelocatesTunnelWithoutRePairing(self) -> None:
        scenario = ManagementScenarioServer()
        scenario.start()

        try:
            with sync_playwright() as playwright:
                chrome = shutil.which('google-chrome') or shutil.which('chromium')
                if chrome is None:
                    raise RuntimeError('Install Chromium or Google Chrome for the browser scenario.')
                browser = playwright.chromium.launch(executable_path=chrome, headless=True)
                try:
                    page = browser.new_page()

                    def authorizedRedirect(route) -> None:
                        request = urlsplit(route.request.url)
                        values = parse_qs(request.query)
                        self.assertEqual(values['code_challenge_method'], ['S256'])
                        self.assertEqual(values['redirect_uri'], [
                            'https://agent-relay.company-notes.com/manage/callback',
                        ])
                        callback = (scenario.origin + '/manage/callback?code=authorized-code&state=' +
                                    values['state'][0])
                        route.fulfill(status=302, headers={'location': callback})

                    page.route('https://address.company-notes.com/authorize**', authorizedRedirect)
                    page.goto(scenario.origin + '/manage?collaboration=' + scenario.policy['id'])
                    page.get_by_role('button', name='使用 Agent Address 登入').click()
                    page.get_by_text('已載入你有權管理的接線與 Agent 身分。').wait_for()
                    self.assertTrue(page.get_by_text('nuwainfo/gateway/main', exact=True).is_visible())
                    self.assertTrue(page.get_by_text('old-tunnel.trycloudflare.com').is_visible())

                    select = page.locator('#collaboration-' + scenario.policy['id'])
                    save = page.get_by_role('button', name='儲存通訊授權')
                    self.assertTrue(save.is_disabled())
                    select.select_option('autonomous')
                    save.click()
                    page.get_by_text('通訊授權已儲存。可回到原本工作繼續使用。').wait_for()
                    self.assertEqual(scenario.policy['mode'], 'autonomous')
                    select.select_option('manual')
                    save.click()
                    page.get_by_text('通訊授權已儲存。可回到原本工作繼續使用。').wait_for()
                    self.assertEqual(scenario.policy['mode'], 'manual')
                    self.assertEqual(scenario.policy['revision'], 2)

                    page.get_by_role('button', name='更新連線網址').click()
                    page.get_by_label('新的 Tunnel 或完整 Webhook HTTPS URL').fill(
                        'https://new-tunnel.trycloudflare.com')
                    page.get_by_role('button', name='儲存 Wake 網址').click()
                    page.get_by_text('Wake 網址已更新，原本的接收金鑰及 Thread 保持不變。').wait_for()
                    self.assertTrue(page.get_by_text('new-tunnel.trycloudflare.com').is_visible())
                    self.assertEqual(scenario.updated, 1)

                    page.get_by_role('button', name='查看待恢復首聯').click()
                    page.get_by_text('relay-test-org/tammy/main → relay-test-org/may/main').wait_for()
                    page.once('dialog', lambda dialog: dialog.accept())
                    page.get_by_role('button', name='確認未建立對話並恢復').click()
                    page.get_by_text('已解除這一組首次聯絡的保留').wait_for()
                    self.assertEqual(scenario.recovered, 1)

                    page.get_by_label('要重製的 Agent').select_option('test-gateway-id')
                    page.get_by_role('button', name='預覽清除範圍').click()
                    page.get_by_text('所選身分：nuwainfo/gateway/main').wait_for()
                    self.assertTrue(page.get_by_text('相關對話：2 段').is_visible())

                    page.get_by_label('請完整輸入下列確認文字').fill(
                        'RESET nuwainfo/gateway/main')
                    page.once('dialog', lambda dialog: dialog.accept())
                    page.get_by_role('button', name='永久清除並重製').click()
                    page.get_by_text('身分已重製完成。可重新使用首頁安裝流程建立新的地址。').wait_for()
                    self.assertEqual(scenario.resetCompleted, 1)

                    page.get_by_role('button', name='登出').click()
                    self.assertTrue(page.get_by_role('button', name='使用 Agent Address 登入').is_visible())
                finally:
                    browser.close()
        finally:
            scenario.close()


if __name__ == '__main__':
    unittest.main()
