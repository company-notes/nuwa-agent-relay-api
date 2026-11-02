# Nuwa Agent Relay — 分階段正式環境 Smoke Test

這套腳本會在 **已部署** 的 `agent-relay.company-notes.com` 和 `address.company-notes.com` 上真正呼叫 API。它**不是**模擬測試；Mailbox 建立與寄送會使用目前的 MailTrigger 設定。請使用專用測試資料。

## 前置條件

- Node.js 22+、已 clone `company-notes/nuwa-agent-relay-api`，執行 `npm ci`。
- Agent Address 中的**同一個 Organization**，已經存在兩個不同的 Host（例如 `mypc`、`vps1`）。本工具**不建立 Host**，因為 Agent Address 的 OAuth Account API 沒有安全刪除 Host 的接口。
- 至少一個有效的 **Agent Address OAuth Access Token**。這是 OAuth 登入後的 access token，**不是** `addr_...` 或 `org_...` Token。若 A/B 使用同一個 Agent Address 帳號，可共用一個 OAuth Token；但兩個 Work Identity 仍然不同。若使用兩個 Token，必須屬於同一 Organization，且能操作該組織的 Work Address。
- MailTrigger API／已驗證的 Mail Domain 已設定。兩個測試 Host 的 Mailbox 可能被真的建立。
- 沒有內建 OAuth 登入或擷取 Token 的功能：請使用已授權的客戶端取得 Access Token；**勿把 Token 傳給 ChatGPT 或貼到 GitHub**。

## 0. 輸入必要設定

以下以 Bash / zsh 示範，Token 不會寫入 repo、輸入歷史或 Smoke State：

```bash
npm ci

export RELAY_SMOKE_HOST_A=mypc
export RELAY_SMOKE_HOST_B=vps1

read -rsp "Agent Address OAuth Token A: " RELAY_SMOKE_TOKEN_A; echo
export RELAY_SMOKE_TOKEN_A

# 同一個帳號操作兩個測試 Work 時可以省略 B Token；
# 如使用不同授權的帳號／Session，再設定：
# read -rsp "Agent Address OAuth Token B: " RELAY_SMOKE_TOKEN_B; echo
# export RELAY_SMOKE_TOKEN_B
```

如果沒有填 `RELAY_SMOKE_HOST_A/B`，工具會選擇兩個共同可用的現有 Host，並拒絕少於兩個 Host 的環境。

可選設定：`RELAY_SMOKE_ADDRESS_URL`、`RELAY_SMOKE_RELAY_URL`（預設正式 HTTPS 網域）、`RELAY_SMOKE_STATE`（預設 `.relay-smoke/session.json`）。

## 1. Setup — 建立兩個暫時 Work Identity

```bash
npm run smoke:setup
```

會依次驗證 Relay Health、兩個 OAuth Session 的 Organization/Host；只在已存在的 Host 下建立 `relay-smoke-<runId>-a` 和 `relay-smoke-<runId>-b`；分別呼叫 `POST /v1/hosts/provision`。顯示兩個 Work、Mailbox 及 Run ID。

產出的 `.relay-smoke/session.json` 只有工作 ID、地址、Run ID、Thread 狀態，**不含 OAuth Token**；Git 會忽略整個 `.relay-smoke/`。若 Setup 途中失敗，請仍先執行 Cleanup 回收已成功建立的 Work；不要直接刪除狀態檔。

## 2. Side A — 發送 Message 與 Host Handoff

```bash
npm run smoke:a -- send
```

A 分別對 B 的 Work Address 發送訊息、對 B 的 Host Address 發送 Handoff。成功後狀態檔會記錄 Message ID 和 Thread ID。

## 3. Side B — 收件、回覆與接受 Handoff

```bash
npm run smoke:b -- reply
```

B 會從 Inbox 核對 A 發出的訊息、回覆同一 Thread，從 Host Inbox 核對 Handoff、接受 Handoff 並回覆。成功結果也寫入同一個狀態檔。

若 B 使用**不同機器**：先複製 A 的 `.relay-smoke/session.json` 至 B 相同位置。B 必須設定自己的 `RELAY_SMOKE_TOKEN_B`（Shell 環境變數，**不可**透過狀態檔複製）；執行完再把更新後的狀態檔複製回 A。請勿同時在兩台機器寫入不同版本的狀態檔。

## 4. Side A — 驗證兩個完整 Thread

```bash
npm run smoke:a -- verify
```

A 透過 API 重新讀取 D1-backed Thread History，核對原始訊息、B 的回覆、Handoff、接受通知與 Handoff 回覆。全部正確才顯示 `PASS`。

請注意：MailTrigger 成功回傳代表**寄送請求被 MailTrigger 接受**；Inbox 驗證的是 Relay 自己的 D1，不表示郵件已實際送達收件匣。如果要證明真正的 Email 收送，需要另外在 MailTrigger 收件箱或入站整合檢查。

## 5. Cleanup — 只釋放測試 Work Identity

```bash
npm run smoke:cleanup
```

Cleanup 會要求輸入本次 Run ID，對每個 Work 再次向 Agent Address 確認 ID、Host、Organization、Handle 與 Run ID 一致，才使用 `DELETE /v1/account/work/:id` 釋放。也可以在非互動環境使用 `RELAY_SMOKE_CONFIRM=<runId> npm run smoke:cleanup`。

成功後把狀態檔搬到 `.relay-smoke/completed-<runId>.json`。若只清掉一半，可修正問題後重新執行 Cleanup，腳本會保留尚未成功釋放的 Work 資訊。

**清除範圍的限制：** 目前 API 無法刪除 Relay D1 Messages/Threads、MailTrigger Mailbox，也無法透過 OAuth 安全刪除共用 Host；腳本不會嘗試直接操作正式 D1 或刪除這些資源。它只撤銷自己這次建立的兩個臨時 Work Address。如果需要完全移除測試郵件／D1 資料，需另外規劃專用測試環境與管理刪除 API，不能宣稱 Cleanup 已清乾淨全部資料。

## Troubleshooting

| 錯誤 | 應檢查 |
| --- | --- |
| `401` | OAuth Access Token 已失效或根本不是 OAuth Token |
| `403` | Work ID 不是該 OAuth 帳號有權管理的 Identity |
| `work_identity_required` | Setup 尚未建立 Work，或 URL 未包含 `work_address_id` |
| `host_not_ready` | B Host Mailbox 尚未 Provision；先檢查 Setup |
| `mailtrigger_* / 502` | MailTrigger API URL、Token、Domain 驗證、收件箱配額等 |
| `No pending handoff` | B 的 Handoff 已接受，需使用更新的狀態檔 |
| `Active smoke-test state exists` | 前一輪未清除，先執行 Cleanup |

## 自動測試（無正式環境流量）

```bash
npm run test:smoke
npm test
npm run check
```

`test:smoke` 只驗證本機 Script 的 Host 防護、狀態檔權限、外部 URL 安全及錯誤回報；並不聯絡正式 MailTrigger 或 Cloudflare。
