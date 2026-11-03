# Nuwa Agent Relay：瀏覽器登入與雙 Agent 正式環境 Smoke Test

這組腳本直接操作已部署的 Agent Address 和 Relay API。會建立真正的 Work、Host、Mailbox 和訊息。**不需要手動取得 OAuth Access Token，也不需要事先建立兩個 Host。**

## 1. 登入

前置條件：Node.js 26 LTS (26.13.0+)；可以使用瀏覽器登入 Agent Address 的帳號。若沒有帳號，可在瀏覽器授權頁註冊。

```bash
git pull
nvm use
npm ci
npm run smoke:login
```

腳本會在本機 127.0.0.1 的隨機 Port 啟動 OAuth Callback Server，以 PKCE S256 與 OAuth State 進行 Authorization Code 流程。瀏覽器登入完成後，Access／Refresh Token 寫入 Git 忽略的 `.relay-smoke/auth-a.json`（限制 0600 權限）。請不要傳送、提交或貼出這個檔案。Windows 若未自動開啟瀏覽器，請複製終端機顯示的授權網址。

若有第二個**同一個 Organization** 的 Agent Address 帳號，可另外執行 `npm run smoke:login -- b`；一般測試只需同一帳號，A 和 B 仍然有各自獨立的 Host 和 Work。

## 2. Setup — 自動建立 Host、Work 與 Mailbox

```bash
npm run smoke:setup
```

- 若帳號已有 Organization，直接沿用。
- 若沒有 Organization，腳本會提示輸入名稱，並要求確認建立。新 Organization 無法由本工具刪除。
- 預設建立 `relay-smoke-<runId>-a` 和 `relay-smoke-<runId>-b` 兩個 Host，在各 Host 下建立臨時 `relay-smoke-<runId>-a|b` Work Identity。
- 透過 Relay 為兩個 Host 建立／取得 MailTrigger Mailbox；Mailbox 建立可能真的產生遠端資源。
- 中途失敗時，已成功建立的 Work 會保存在 `.relay-smoke/session.json`。**修正外部服務設定後直接重跑 `npm run smoke:setup`**，腳本會重新向 Agent Address 驗證先前的 Work 身分，沿用原 Run ID，只重試尚未完成的 Mailbox Provision；也可選擇執行 Cleanup。請不要刪除狀態檔或自行重建帳號。

如果希望沿用既有 Host，可預先設定 `RELAY_SMOKE_HOST_A` 和 `RELAY_SMOKE_HOST_B`。非互動模式若必須新增 Organization，需要 `RELAY_SMOKE_ORG=<slug>` 及 `RELAY_SMOKE_CREATE_ORG=yes` 兩個變數，表示明確允許建立永久資源。

## 3. 兩端分階段測試

```bash
npm run smoke:a -- send
npm run smoke:b -- reply
npm run smoke:a -- verify
```

A 發出 Message 與 Host Handoff，B 確認 Inbox、Reply、Accept Handoff、Reply Handoff，最後 A 驗證兩個 Thread 的 D1-backed History。所有訊息會通過正式 Relay 和 MailTrigger API。

**MailTrigger 接受寄送請求不代表郵件已實際送達收件箱**。Relay Inbox 讀的是 D1 訊息紀錄，若要驗證實際 Email Deliverability，需要額外檢查 MailTrigger 收件狀態或外部測試收件箱。

若 B 在不同電腦上操作：B 必須自行執行 `npm run smoke:login -- b`，從 A 複製**不含 Token** 的 `.relay-smoke/session.json` 後執行 `smoke:b`，再將更新過的狀態檔送回 A。**絕不可複製 auth-a.json、auth-b.json 或 OAuth Token。**

## 4. Cleanup

```bash
npm run smoke:cleanup
```

清理前須確認本次 Run ID。程式會核對臨時 Work 的 Organization、Parent Host、ID 和帶 Run ID 的名稱，只撤銷本次建立的 Work。全部成功後會封存狀態檔，並移除本機儲存的 OAuth 憑證（需要保留登入時可設定 `RELAY_SMOKE_KEEP_LOGIN=1`）。**本機刪檔不等於撤銷遠端 OAuth Grant／Token**，仍須遵守服務端的權杖有效期與撤銷機制。若中途失敗，狀態檔與 Token 會保留，以便安全重試。

**清理限制：** 目前 Agent Address 沒有 OAuth Account API 來安全刪除 Host 或 Organization；Relay／MailTrigger 也沒有相應的刪除管理 API。本工具**不會刪除**已建立的 Host、Organization、Mailbox、D1 Thread 或 Message。請在測試隔離的帳號／MailTrigger 網域使用，不要假設 Cleanup 是完整遠端資料清除。

如果只執行了 Login、還沒有任何 Setup，也可以使用 `npm run smoke:logout` 清除本機 OAuth 檔案；它不會操作遠端 Work／Host，也不會撤銷遠端 OAuth Token。

## 5. 離線測試與故障排除

```bash
npm run test:smoke
npm run check
npm test
npm run audit:check
```

離線測試會檢查 PKCE、OAuth Callback State、Run ID Host 命名、檔案權限、Host 清除保護與錯誤處理，不會登入真實帳號。

| 錯誤 | 處理方式 |
| --- | --- |
| OAuth login timed out | 使用同一台電腦的瀏覽器完成授權，重新執行 `npm run smoke:login` |
| OAuth state mismatch | 授權回呼不屬於這次登入，重新登入 |
| Unauthorized / invalid token | Token 已過期或撤銷，執行 `smoke:login` |
| Organization mismatch | A、B OAuth 身分須屬同一 Organization |
| MailTrigger 502 | 檢查 Relay 綁定的 API URL、驗證 Domain、Mailbox 權限 |
| Active smoke-test state exists | 請先執行 Cleanup，不要直接刪除狀態檔 |

進階用法仍允許以 `RELAY_SMOKE_TOKEN_A` / `RELAY_SMOKE_TOKEN_B` 環境變數覆蓋本機 Login。
