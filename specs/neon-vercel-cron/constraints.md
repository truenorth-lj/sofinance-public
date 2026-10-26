# 執行邊界

## MUST

- Step 1 已完成且使用者於 2026-10-26 明確核准實作與遷移；以下資料保全與操作邊界持續有效。
- source changes 只在指定 worktree `worktrees/dev/neon-vercel-cron/sofinance-public`／`dev/neon-vercel-cron`；遵守目標 AGENTS，保留其他人的修改。
- 先搬 DB／兩套 stores，再切 native cron；保留 schema、ledger、daily observations、position receipts／游標／parser 與 fencing invariants。
- runtime 與 migration／backup 分開連線；安全 TLS、PG17+、明確 DB／role identity、session advisory lock 用 direct endpoint，pooler 相容性以真 SQL 證明。
- 切換涵蓋 timer、refresh POST／GET、position request-triggered writes、已啟用 opens 及所有舊 deployments，始終只有一個權威寫入來源。
- 還原演練、final-copy 校驗、post-write recovery 與退役條件均有可回讀證據；逐項報告 code／data／cron／retirement 狀態。
- 機密只經平台 secret／私密環境注入；紀錄只留非敏感 metadata，備份置於受控安全位置。

## MUST NOT

- Step 1 的「僅三份文件」限制已隨核准完成；實作、審查、PR、測試與既有 production 的部署／遷移按核准規格推進。
- 不使用或修改 prototype 的 `neon-carmine-leaf`；不搬 prototype 財務資料／reconcile cron，不合併其他 app DB。
- 不因七表可重抓部分行情而丟 daily history、receipts、ledger 或 opens attribution；不把 cache 當備份。
- 不放寬成任意 DB／role，不停用 TLS 驗證，不使用 pooled session lock，不移除 bounded queries／timeouts／preview gate。
- 不讓 GET force refresh，不改 APR 計算或聲稱 15 分鐘 tick 等同 5 分鐘更新，不偽造錯過的 daily observation。
- 不將 destination 接受寫入後的舊 DB 直接當 rollback；不在未證明無 consumer 時刪 gateway／DB／volume／共用 server。
- 不輸出、提交 secrets／完整 DB URL／備份資料；不執行金融簽名、交易或付款，不把 code green 宣稱為資料已搬或 cron 已活。

## MUST ASK／待解依賴

- 規格核准已取得；主代理繼續執行，不要求重複的一般 merge 核准。
- Neon 方案／ownership／區域／restore 保留選擇需根據實際容量與費用；若涉及新付費方案、購買或平台條款，先取得相應決定／host 所需確認。
- 如平台需要登入、人類驗證／reveal-email flow 或額外權限，只在實際任務必要時交由主代理處理，不能繞過；不得在聊天索取 secret。
- 盤點若發現未列 consumer、缺失備份／校驗、無法 fence 所有 writers、不可接受停寫窗口或不可證明 pooler 安全，停在相應 gate，提出最小待決事項；不擴大成重建／清除共用基礎設施。
