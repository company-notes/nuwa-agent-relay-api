# MailTrigger 收件驗證、Agent 喚醒與測試清理

這些功能已加入 Worker，但真正的外部收信與喚醒需要啟用 MailTrigger Route、正式 DNS、GitHub Secret 和 Agent HTTPS Callback。單純 GitHub CI 通過不代表外部郵件已送達。

## 1. MailTrigger 真實收件回報

MailTrigger 官方文件：https://www.mailtrigger.net/static/doc/QuickStart.html 和 https://www.mailtrigger.net/static/doc/Integrations.html

若要測試 Internet Email，使用你管理的真實網域，完成 MailTrigger Domain 驗證、MX、SPF、DKIM 與 DMARC。保留給測試的 `.test` 網域不能證明公網郵件送達。設定 receiving mailbox 的 Support Incoming，以及 Route → Webhook (API) Action：

- URL：`https://agent-relay.company-notes.com/v1/mailtrigger/receipt`
- Method：`POST`
- Headers：`Content-Type: application/json`、`X-Relay-Inbound-Key: <your-secret>`
- JSON Body：
```json
{"from":"$SENDER","receiver":"$RECEIVERS","subject":"$SUBJECT"}
```

先在 Relay GitHub Actions Secrets 建立新的長隨機 `MAILTRIGGER_INBOUND_KEY`，再將相同值存入 MailTrigger Action 的自訂 Header。禁止把它填在公開 Variable、commit 或聊天。重新手動執行 Deploy workflow 才會安裝 Worker Secret。MailTrigger Action 需針對單一收件人執行；`$RECEIVERS` 若含多個逗號分隔地址，Relay 會拒絕。

Relay 接到回報時會驗證獨立 Secret、`[NAR:<message-UUID>]` Subject、原先已提交的 Message，以及 D1 中來源／目標 Host 的真實 Mailbox Email。驗證通過後設定 `receivedAt`，重複回報不會覆寫時間。不能以此來認證任意外部 Email 作為 Agent 訊息；陌生郵件不會被寫成內部 Thread。

在 `smoke:a -- send` 後執行 `npm run smoke:receipts`，會逐一驗證一般訊息與 Handoff 的 MailTrigger 收件回報。舊版 Inbox 的資料來自 Relay D1，不能用來證明真正郵件收件。若要驗證 Gmail 等外部服務收信，還需要一個可獨立觀察的外部收件箱。

## 2. Agent HTTPS 喚醒通知

每個 Work 以自己的 OAuth Token 註冊：

- `POST /v1/wake-subscription?work_address_id=<id>`，Body `{"callbackUrl":"https://agents.example.com/wake"}`；只回傳一次簽章 Secret。
- `GET /v1/wake-subscription` 只回傳訂閱狀態和 URL，永不回傳 Secret。
- `DELETE /v1/wake-subscription` 取消訂閱和待送任務。
- `GET /v1/wake-events` 讀取自己的通知狀態與失敗原因。
- `GET /v1/messages/<messageId>?work_address_id=<id>`，僅同 Thread 的已授權參與者可取得正文。

管理者需在 Relay GitHub Actions Variables 加入 `WAKE_ALLOWED_HOSTS`，內容為逗號分隔的**確切公開 HTTPS hostname**，例如 `agents.example.com`；不允許 localhost、任意 IP、HTTP、萬用字元或自動重新導向。重新部署後 Cloudflare Cron 每分鐘掃描 D1 wake 佇列，傳送只有事件名稱、Message ID 和 Work ID 的 JSON，不包含正文／附件。

每個 Callback 使用 `X-Nuwa-Wake-Signature: sha256=<hex>`，簽的是原始 JSON Body 的 HMAC-SHA256；接收端必須用專屬 Secret 驗證，並以 Message ID 做冪等處理。非 2xx 最多重試 6 次；郵件不會因為喚醒失敗而重寄。

本機測試示例：

```powershell
npm run smoke:login
npm run smoke:setup
# 需事先設定公開 HTTPS 入口（例如你控制的 Cloudflare Tunnel），轉發至 http://127.0.0.1:8765/wake
npm run smoke:wake:register -- https://agents.example.com/wake
# 在第二個終端機保持執行：
npm run smoke:wake:listen
# 在第一個終端機執行：
npm run smoke:a -- send
npm run smoke:b -- reply
npm run smoke:a -- verify
npm run smoke:receipts
npm run smoke:cleanup
```

其中 `smoke:receipts` 只有當 MailTrigger 真實執行接收入站信的 Route 才會通過。`smoke:wake:listen` 是 HMAC 驗證加 OAuth 讀取訊息的 Agent Adapter 範例，不會自行啟動 AI 模型或執行郵件中的指令；接收端必須已運行且能透過管理者設置的 HTTPS 入口連線。

## 3. 嚴格限制的 Cleanup

新建立的 Smoke Run 才能使用完整清理。Cleanup 會：

1. 透過 OAuth、Work ID、Host path 和 Run ID 再次驗證身份。
2. 先呼叫 `DELETE /v1/smoke/host?work_address_id=<id>&run_id=<10hex>`：僅允許 Host `relay-smoke-<runId>-a|b` 與其中同名 Work，確認 MailTrigger mailbox ID/Domain/Username 一致後刪除 Mailbox，並刪除相關 Relay D1 訊息、Thread 和 Wake 資料。
3. 撤銷該 Work。
4. 透過 Agent Address `DELETE /v1/account/host/<id>?run_id=<10hex>` 撤銷**空的測試 Host**；如果仍存在有效 Work，會拒絕。
5. 全部成功後封存 State、刪除本機 OAuth 憑證；中途失敗保留狀態供安全續跑。

共用 Host、其他 Agent、Organization 以及不屬於該 Run 的 Mailbox 不會刪除。舊版已清理完成的 Run（例如 `698b3539fd`）因 Work 已撤銷，無法再用新的 Work OAuth Cleanup API 自動補刪；歷史資料必須經管理者單獨核對。不要刪除整個正式 D1 或 Domain。

## 4. 部署依賴與限制

- Agent Address 必須先部署受限的空 Host 撤銷 API。
- Relay 必須套用 `0002_mail_receipts_wake.sql` 並部署新的 Cron 與 API。
- `MAILTRIGGER_INBOUND_KEY` 為可選 Secret；未設定時 Inbound Route 回傳 503，不會放行。
- `WAKE_ALLOWED_HOSTS` 為可選 Variable；未設定時 Agent Wake 無法註冊。
- MailTrigger 後台的實際 Incoming Route、DNS 設定、Agent HTTPS Tunnel 與外部郵件送達，需要由持有該服務管理權限的操作者完成；GitHub PR 不會自動更動這些外部帳號設定。

## 5. 自動化測試

`npm test` 用 Cloudflare Worker、D1 migrations 模擬授權、假收件／錯誤金鑰、簽章與重試、Smoke 刪除邊界。`npm run test:smoke` 驗證本機腳本（不聯絡正式郵件服務）。
