# Nuwa Agent Relay API — 正式維運

## 專案角色

Relay API 是 Nuwa Agent Relay 的訊息中樞。**Agent Address** 管理 Organization／Agent／Session 三層身分以及獨占 Runtime Lease；**Relay API** 保存 Message、Thread、Handoff、Receipt（收件／已讀確認）與 Wake（通知其他 Agent 有新訊息）。真正的郵件傳輸由外部 **MailTrigger** 負責：MailTrigger 擁有 SMTP、受管理信箱、收件 Webhook Action 和 Archive，Relay 不重寫那些系統。**Gateway** 將通知對應到 OpenMausBot／GrokBot 的原生會話，但屬另一個尚未整合的 PR，不能以 API 通過驗收代替 Bot 真正啟動。

## 唯一正式 Cloudflare 與 GitHub 流程

- 正式 Worker：`nuwa-agent-relay-api`
- 正式 URL：<https://agent-relay.company-notes.com>
- 內部 `DB`：全新 schema、但沿用原資源名稱 `nuwa-agent-relay-api`
- 身分管理：<https://address.company-notes.com>
- **永久不改**的 MailTrigger 收件回執 URL：`POST https://agent-relay.company-notes.com/v1/mailtrigger/receipt`
- 郵件供應商 API：`https://route.mxnodes.com`，使用原本的 `MAILTRIGGER_API_TOKEN` 與認證方式 `Token`
- MailTrigger 管理信箱的網域：原 GitHub Variable `MAILTRIGGER_MANAGED_DOMAIN`
- 正式 webhook 帶 `x-relay-inbound-key`，Worker 必須驗證，匿名／錯誤金鑰回 `401`

**唯一部署來源**是 `main` 分支的原始 `.github/workflows/verify.yml`。每次 push：TypeScript、Dependency Audit、Worker+D1 情境測試、offline smoke → 從原有 Repository Secrets／Variables 讀取設定 → 以 `ResolveRelayD1.mjs` 查證 Cloudflare D1 唯一原名及當次真實 ID（寫入 `GITHUB_ENV`）→ 生成短暫 Wrangler config → 遠端 D1 schema guard → migration → 確認完整 schema → Worker 部署及重設既有 MailTrigger／Wake secrets → 正式 HTTP Smoke。

保留原 GitHub Variable 名稱：`CLOUDFLARE_D1_DATABASE_ID`、`CLOUDFLARE_D1_DATABASE_NAME`、`CLOUDFLARE_CUSTOM_DOMAIN`、`MAILTRIGGER_RECEIPT_URL`、`MAILTRIGGER_MANAGED_DOMAIN`。部署前會以 Cloudflare 的原名 D1 查證當次 ID，避免舊 ID 留在 Variables 導致誤綁。保留原 GitHub Secrets：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`MAILTRIGGER_API_TOKEN`、`ALIAS_VERIFICATION_KEY`、`MAILTRIGGER_INBOUND_KEY`、`WAKE_CREDENTIALS_KEY`，不在 Repo 儲存值。這份說明不構成修改 MailTrigger 服務或刪除 MailTrigger 信箱的授權。

## API 使用與安全邊界

- `GET /health`：公開健康檢查
- `POST /v1/mailtrigger/receipt`：**外部系統依賴的固定路徑**，不屬於舊 Host/Work 相容 API。
- 其餘核心路由是 `/v2/*`：Message／Handoff、Thread 讀取與回覆、Agent Inbox、Session Inbox、Mailbox 管理、別名驗證及 Wake 訂閱。
- V2 操作要同時具備 Agent Address OAuth Bearer、`session_id` 與 `x-nuwa-runtime-token`。單憑帳號、Agent 地址或知道 Session ID 都不能取得執行權。
- MailTrigger 真正送達時經過驗證的 Webhook（或明確的 Archive reconciliation）才計為收件；MailTrigger 發送 API 成功不等於送達。
- Wake 發送標準 V2 JSON：`{ event: "nuwa.message.available", eventVersion: 2, messageID, recipientSessionID }`；Studio 接收端需驗證 HMAC、事件版本與目標 Session。
- 對 Message 的回覆保留同一 Relay Thread；Agent-target Handoff 由單一合法 Session 原子接受。Thread 完整性不能以各 Repo 自己的綠燈代替跨服務驗收。

## 資料清理與風險

V2 不接受舊 Host／Work schema。先確認舊 D1 只被 Relay Worker 使用，再依使用者明確批准捨棄舊測試資料，建立**原名的乾淨 D1**。不可將新版 `migrations/0001_init.sql` 套在混有 `paired_hosts` 等舊資料表的資料庫上；自動檢查器應拒絕舊版、混合、部分與未知 schema。Cloudflare 自動產生的 `_cf_KV`／`_cf_METADATA` 不是業務資料表。

正式部署後，必須用 Cloudflare API 驗證 Worker `DB` 綁定新 D1，並核對舊資料庫是否真正不再使用，才刪除此**特定的舊 Relay D1**。不能順便清理 MailTrigger、Releasebot、Agent Address、MCP 或 Gateway 相關的資源。

## 測試範圍與尚待整合

- `npm test`：本機真實 Worker／D1 使用情境。
- `npm run test:smoke`：不寄信的 offline harness 和 D1 guard。
- 正式 `scripts/SmokeProduction.mjs`：只發無秘密的匿名 HTTP，測 `/health`、OAuth 保護以及原 MailTrigger webhook 拒絕未授權的請求；**不寄信、不建立信箱**。
- `npm run smoke:v2`：需要兩個已授權且正在執行的 Agent Session、合法 OAuth/Runtime，才會真正寄信並檢查 A→B→A、Webhook Receipt 與 Handoff。必須明確設定 `NUWA_SMOKE_AUTHORIZE_SEND=yes`；不得在 CI 正式部署時默默執行。
- Gateway PR #23 是疊加在 API PR #22 舊基底上的另一條 Draft；API 合併後需重新整合、重跑跨 Repo 測試，不能連帶 merge 或部署。
- Remote MCP 的 Session Binding 與 OAuth refresh 等問題尚需單獨驗收。正式 Relay API 更新**不表示** GrokBot/OpenMausBot 已可無操作使用所有功能。

## 程式碼與測試規則

遵守 `CODE_PRINCIPLES.md` 的 OO、DRY、separation of concerns；遵守 `TESTING.md` 的使用情景導向真實 Worker/D1 測試。Rule 20 檢查垂直留白與例外處理時，只改風格、不改邏輯。對外路由契約、Runtime 獨占權、MailTrigger 既有接收 URL、收件證據與 Gateway 對話連續性，都是維護時不可破壞的關鍵約束。
