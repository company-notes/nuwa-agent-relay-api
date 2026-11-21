#!/usr/bin/env python3
"""Real Chromium flow for Relay Wake management; account service stays isolated."""
from __future__ import annotations

import json
import re
import shutil
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright


class ManagementScenarioServer:
    """Serve the actual Relay HTML/JS while isolating external OAuth/API effects."""

    def __init__(self) -> None:
        source = (Path(__file__).resolve().parents[1] /
                  'src' / 'RelayManagementPage.ts').read_text(encoding='utf-8')
        self.html = self.extract(source, r'const html = `(.*?)`;\s*const response')
        self.script = self.extract(source, r'const source = `(.*?)`;\s*return new Response')
        self.callbackHost = 'old-tunnel.trycloudflare.com'
        self.updated = 0
        self.updateBody: dict[str, str] = {}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    @staticmethod
    def extract(source: str, pattern: str) -> str:
        match = re.search(pattern, source, re.DOTALL)
        if match is None:
            raise AssertionError('Cannot extract the actual Relay UI source.')
        return match.group(1)

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

            def do_PUT(self) -> None:
                if not self.requireOAuth():
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
                    page.goto(scenario.origin + '/manage')
                    page.get_by_role('button', name='使用 Agent Address 登入').click()
                    page.get_by_text('已載入你有權管理的 Wake 接收器。').wait_for()
                    self.assertTrue(page.get_by_text('nuwainfo/gateway/main').is_visible())
                    self.assertTrue(page.get_by_text('old-tunnel.trycloudflare.com').is_visible())

                    page.get_by_role('button', name='更新連線網址').click()
                    page.get_by_label('新的 Tunnel 或完整 Webhook HTTPS URL').fill(
                        'https://new-tunnel.trycloudflare.com')
                    page.get_by_role('button', name='儲存 Wake 網址').click()
                    page.get_by_text('Wake 網址已更新，原本的接收金鑰及 Thread 保持不變。').wait_for()
                    self.assertTrue(page.get_by_text('new-tunnel.trycloudflare.com').is_visible())
                    self.assertEqual(scenario.updated, 1)

                    page.get_by_role('button', name='登出').click()
                    self.assertTrue(page.get_by_role('button', name='使用 Agent Address 登入').is_visible())
                finally:
                    browser.close()
        finally:
            scenario.close()


if __name__ == '__main__':
    unittest.main()
