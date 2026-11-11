# MailTrigger 收件驗證、Agent 喚醒與測試清理

這些功能已加入 Worker，但真正的外部收信與喚醒需要啟用 MailTrigger Route、正式 DNS、GitHub Secret 和 Agent HTTPS Callback。單純 GitHub CI 通過不代表外部郵件已送達。

## 收件、已讀與喚醒的單一語意（ReleaseBot 相容）

新版對照舊版 `releasebot_api/src/HandoffService.ts`：
- **submitted/sent**：MailTrigger 寄送 API 已回傳 201；只表示提交成功，絕不觸發 Wake。
- **receivedAt**：由 MailTrigger 收件信箱的 **Archive** 查到 Relay 產生的 `[NAR:UUID]`，或可信的 MailTrigger Incoming Webhook 回報同一訊息的來源與目的信箱後才寫入；`receiptSource` 分別為 `archive` 或 `webhook`。同一訊息只保留第一次確認時間。
- **readBy**：收件 Agent 使用 OAuth 明確呼叫 `POST /v1/messages/<messageId>/read?work_address_id=<workId>` 才記錄，重複呼叫仍是第一次的時間。查詢 Inbox 或 Thread **不會自動當作已讀**。
- **Wake**：只在已驗證的收件 Webhook 首次確立 `receivedAt` 時，與收件狀態在**同一筆 D1 transaction** 建立通知事件。入站 Webhook 可立即嘗試 HTTPS Callback；Cron 僅重試失敗通知，**不再自動輪詢 Archive**。

`GET /v1/messages/<id>/receipt?work_address_id=<workId>` 回傳 `submissionStatus`、`arrivedInMailTrigger`、`receivedAt`、`receiptSource` 與 `readBy`，僅 Thread 相關 Work 可讀取。注意 Archive 或 Webhook 回報的是**MailTrigger 內部信箱的收件證據**，並不直接證明 Internet 中任意第三方信箱（例如 Gmail）成功投遞。

主路徑改成 B 信箱收件 Route 的 Webhook Action 主動回報，無需等待 Archive API 輪詢。舊有 `refresh=archive` 仍是操作員**明確指定**時的診斷／補償手段，不能被當作即時通知的依賴。即使寄信 API 回傳 201，也不代表 B 收件成功。

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

先在 Relay GitHub Actions Secrets 建立新的長隨機 `MAILTRIGGER_INBOUND_KEY`，再由 Host provisioning 設定 MailTrigger Webhook Action 的自訂 Header。禁止把它填在公開 Variable、commit 或聊天。設定 Worker 的 `MAILTRIGGER_RECEIPT_URL` 為**這台 Relay** 可從 MailTrigger 呼叫到的公開 HTTPS 位址（如 `https://agent-relay.company-notes.com/v1/mailtrigger/receipt` 或本機 Worker Tunnel），與指向 MailTrigger 伺服器的 `MAILTRIGGER_API_URL` 完全不同。只有設定 Receipt URL 時會自動建立 B 信箱的 `NAR receipt <id>` Route；如果設定 URL 但缺少 Secret，provisioning 會拒絕完成。MailTrigger Action 需針對單一收件人執行；`$RECEIVERS` 若含多個逗號分隔地址，Relay 會拒絕。

Relay 接到回報時會驗證獨立 Secret、`[NAR:<message-UUID>]` Subject、原先已提交的 Message，以及 D1 中來源／目標 Host 的真實 Mailbox Email。驗證通過後設定 `receivedAt`，重複回報不會覆寫時間。不能以此來認證任意外部 Email 作為 Agent 訊息；陌生郵件不會被寫成內部 Thread。

在 `smoke:a -- send` 後執行 `npm run smoke:receipts`，會逐一驗證一般訊息與 Handoff 是否被收件 Webhook 確認。這個腳本現在**不再呼叫 `refresh=archive`**。Inbox 仍來自 Relay D1，不能單靠它證明 MailTrigger 真正收件；若 Webhook Route 失敗，receipt 會保持未確認。

## 2. Agent HTTPS 喚醒通知與安全配對

**推薦 GrokBot / Cursor 等隱藏 Webhook 金鑰的平台採用 Wake Pairing：**

1. Agent 完成 MCP OAuth 並選定有效 Work，在 Automation 任務內容固定寫入 `EXPECTED_WORK_ID`，請使用者同意建立 Webhook。
2. Agent 呼叫 `relayBeginWakePairing`，即 `POST /v1/wake-pairings?work_address_id=<Work ID>`（帶 Agent Address OAuth Bearer）；只傳送 Work ID，取得約 20 分鐘有效的單次 `pairingUrl`。建立新連結有 60 秒冷卻期。
3. 使用者自己開啟 `https://agent-relay.company-notes.com/wake-pair/<一次性連結>`，經 Agent Address OAuth / PKCE 登入並被驗證確實擁有相同 Organization + Work 後，才看到安全表單。
4. 使用者從原 Webhook 平台複製 URL 與 Key，**直接填入 Relay HTTPS 配對頁面**。Key 不會經過聊天、MCP 工具參數或 URL，Relay 使用 `WAKE_CREDENTIALS_KEY` AES-GCM 加密保存目標。
5. Relay 沿用既有 `WakeRegistration.begin`，送出 `nuwa.wake.verification`；Automation 用相同 Work 的 OAuth 呼叫 `relayVerifyWake`，確認 `enabled: true` 才算完成。若 Challenge 未送達或驗證失敗，不能把配對頁提交成功當成 Agent 已受信任。

配對連結只能使用一次；OAuth `state` / PKCE 驗證、Secure HttpOnly SameSite Cookie、
POST Origin 驗證、短效 Session 與 D1 SHA-256 雜湊防止任意接管。配對連結本身請只分享給
目標使用者，不放公開日誌；如果平台將金鑰遮蔽到連使用者也無法複製，請在該平台生成
新 Key，再於配對頁私密輸入。當金鑰變更後，必須重新配對。

API 仍支援既有的自動化註冊：

- `POST /v1/wake-subscription?work_address_id=<id>`，Body 包含 `callbackUrl`、`authMode` 和對 Bearer 模式適用的 `bearerToken`；只有在受信任的程序確實可以安全取得 Key 時才應使用。
- `POST /v1/wake-subscription/verification`，Body 包含 `verificationId` 與 `challenge`；這是**一次性的驗證**，不是每則訊息的例行工作。
- `GET /v1/wake-subscription` 只回傳狀態與公開 Host，永不回傳 Secret。
- `DELETE /v1/wake-subscription` 取消訂閱和待送任務。
- `GET /v1/wake-events` 讀取自己的通知狀態與失敗原因。
- `GET /v1/messages/<messageId>?work_address_id=<id>` 以授權 Work 取得正文。

Wake 目標只能是經驗證的公開 HTTPS 主機、標準埠且不得自動跟隨 Redirect。
`hmac` 模式在原始 JSON body 上提供 `X-Nuwa-Wake-Signature: sha256=<hex>`；
`bearer` 模式另外使用 Webhook Key 的 `Authorization: Bearer`；
`capability` 模式使用平台批准的秘密 URL。只有對應模式的接收端完成驗證後才能處理。
MailTrigger 到站確認後才會建立 Wake 通知，Cron 每分鐘重試失敗投遞，最多 6 次。
Wake Body 只有事件名稱、Message ID 與 Work ID，不含正文或附件。正常已驗證訊息採
**Webhook 驗證 → 比對預存 Work ID → 一次 relayMessage → 必要時 relayReplyThread**，
不重新註冊、不重查工具清單或身份狀態、不自動回已讀。

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
- `WAKE_CREDENTIALS_KEY` 為必要 Worker Secret；新註冊必須使用有效的 32-byte AES-GCM 金鑰，Webhook Key 不會寫入 D1 明文。
- MailTrigger 後台的實際 Incoming Route、DNS 設定、Agent HTTPS Tunnel 與外部郵件送達，需要由持有該服務管理權限的操作者完成；GitHub PR 不會自動更動這些外部帳號設定。

## 5. 自動化測試

`npm test` 用 Cloudflare Worker、D1 migrations 模擬授權、假收件／錯誤金鑰、簽章與重試、Smoke 刪除邊界。`npm run test:smoke` 驗證本機腳本（不聯絡正式郵件服務）。

### 舊資料的安全處理

Migration `0003_delivery_and_read_receipts.sql` 清除過去僅憑寄送 API 成功建立、但尚無 MailTrigger 收件證據的 Wake 佇列項目，不會刪除 Message、Thread 或原始寄送紀錄。之後 Cron 可重新用 Archive 對帳；**不會追溯補發舊的已讀回條**。

### 節省 MailTrigger API 查詢

Cron 不會自動呼叫 MailTrigger Archive；正常收件確認只靠可信的 B 信箱 Webhook。操作員仍能明確使用 `GET /v1/messages/<id>/receipt?work_address_id=<id>&refresh=archive` 診斷個別訊息（同一 Message 至多約每兩分鐘一次），但 `npm run smoke:receipts` 不再觸發此查詢。
