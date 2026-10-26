# 技術設計

## 讀取依據

本設計依基準 SHA 的 `src/app/api/internal/rwa-refresh/route.ts`、`src/lib/{rwa-store,position-history-store,rwa-postgres-store,position-history-postgres-store,rwa-refresh}.ts`、`src/lib/config/{rwa-env,rwa-migration-env}.ts`、`src/db/{schema,target,migrations}.ts`、`scripts/rwa-data-service.ts` 與既有 integration tests。
研究證據位於 workspace `artifacts/sofinance-infra-20261026/{synthesis,vercel-confirmation,shared-infra,options-survey}.md`；最新確認優先於 synthesis 中較早取樣。此次未重新執行線上研究。

## 連線與資料邊界

- 目標資料流：public API／refresh → server-only stores → public 專用 Neon；Vercel native cron → 同 repo refresh GET。prototype 繼續透過原 public API contract 取資料。
- runtime 使用 `DATABASE_URL`；CLI 專用 `SOFINANCE_RWA_MIGRATION_DATABASE_URL` 使用 direct endpoint，禁止 fallback 到 runtime URL；備份／restore 亦走 direct。
- 新 Neon 預設以建立 `sofinance` database／role 保持既有 target validator 與 migration runtime identity check；不接受把所有 DB／role 都放行的修補。
- 若需拆分 runtime／migration roles，須加入明確、受驗證的 expected database／role 設定，同時改 URL 與 SQL identity 驗證並測試拒絕錯誤 target；採最小 grants。
- Vercel direct PG 必須要求受信任 TLS／hostname 驗證，拒絕 insecure 模式；保留既有 gateway 模式供過渡，以明確設定選定來源，避免 gateway 優先序偷偷蓋過新 DB。
- runtime pooler 為優先評估路徑，須證明 postgres-js `prepare:false` 與 transaction-mode 相容；不成立則在容量可證明下明確選 direct runtime，不能無限制 fallback。
- 現 factory startup `connection.options` 設定 search_path／statement_timeout／lock_timeout；pooler 支援不能假設。必要時改 transaction-local 或受控 role defaults，驗證每條查詢含非 transaction reads 均受界線保護，且無跨 request 設定洩漏。
- `SET LOCAL transaction_timeout='8s'` 要求 PG17+，驗證 timeout／rollback 後連線恢復。migration 保留 session advisory lock、reserved session 與至少兩條 direct connections。
- poolMax 是每個 pool 的上限；需合計 RWA／position／opens 與多 Vercel instances，量測 cold start、連線與工作期限，保留現有 lease 大於 deadline 的檢查。

## Cron adapter

- 新增 repo `vercel.json` cron entry：path `/api/internal/rwa-refresh`，schedule `*/15 * * * *`（UTC）。
- GET／POST 共用 authorization、refreshEnabled／preview gate、錯誤處理與 `refreshRwaSnapshots`；GET 固定 normal due-driven 執行，POST 保留 strict JSON／既有 force 行為。
- 使用 `CRON_SECRET` Bearer 驗證；缺少／錯誤 secret 拒絕，回應 no-store。不得以 GET／query force 繞過 due checks、租約或 preview gate。
- 保留現有 300s route ceiling 與受配置的較短 job deadline，不以增加 maxDuration 掩蓋 timeout；錯誤維持 503，skip／未到期沿用正常結果。
- 原生排程可能重複、遺漏且不保證自動重試；依既有 due／lease 規則於下次 tick 恢復。超出每日取樣窗口沿用缺樣語意，不偽造歷史 observation。
- 觀測 deployment SHA、job／epoch、開始／結束、狀態、last-success／freshness，使用既有監控途徑；不得輸出 credentials 或原始 position receipts。

## 切換與復原順序

1. 盤點 production source DB／roles／tables／ledger／extensions／consumer；確認 opens、prototype 及 request-triggered position writer。核對資源 identity，安全保存 scoped logical backup。
2. 於新 public Neon 隔離環境 restore，驗 schema、ledger、內容、timestamps／cursors／receipts／parser versions；不編輯既有 migration SQL，不用 destructive push。
3. 部署具備新 stores 的版本時先不啟用 native cron；維持舊 gateway／timer，證明 direct 與 pooled 路徑選擇及 production gates。
4. 受控 quiesce：停舊 timer，封鎖 RWA 與 position／opens 等所有 source writers，drain in-flight／舊 deployments，等 lease 到期或受控失效；DB 層寫入 fence 必須涵蓋舊程序，單靠新版本 feature flag 不足。
5. final copy／校驗後設定 production 新 DB、移除舊 gateway 選路，確保舊 source 仍 fenced；處理 lease state 時保留 epochs／history，禁止攜 active lease 開雙 writer。
6. 先以受控 authenticated normal POST 驗證新 DB，繼而部署／啟用 native cron；確認舊 timer 不再觸發，驗證連續 ticks 與 daily window。
7. 新 DB 尚未寫入前可按預案回 source；接受 destination writes 後必須重新 fence、備份並補齊／反向校驗差異，或 forward-fix；禁止直接切回過期 source。
8. 完成 public／prototype smoke、無舊 consumer／流量及 restore 證據後才退役舊 gateway／timer。讀取可保留 last-good，但此次不保證切換零停機。

## 驗證計畫（實作階段執行）

- repo checks：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:env-matrix`、`pnpm build`；新增設定須納入 env matrix，普通 suite 不連網／不讀 production secrets。
- opt-in SQL：以私密注入的 `RWA_DB_TEST_URL` 指向專用測試 DB，在 disposable schemas 執行 `pnpm exec vitest run src/lib/rwa-postgres-store.integration.test.ts src/lib/position-history-postgres-store.integration.test.ts src/db/migrations.integration.test.ts`；執行前確認 identity，測後清理。
- 保留既有 lease／epoch、daily immutability、position receipts／parser／delta fences、migration ledger 測試；補 GET 無 body／auth／preview／disabled／failure／duplicate、遺漏 tick 與 timeout 復原。
- pooled／direct Neon 演練驗 search_path、每類 query timeout、lock／transaction timeout、lease concurrency／migration lock 排他；disposable schema integration 本身不等同 production cutover 證據。
- production smoke 綁定實際 deployment SHA／DB identity：pairs、tracked range APR／完整 model、daily history、既有 position incremental sync／P&L、prototype pairs／APR consumer contract；可驗 request-triggered persistence，但不簽名或發送金融交易。
- 真 cron 至少兩次連續成功且 freshness 前進，另跨 08:10–09:10 Taipei 驗每日資料；測試失敗或缺證據則相應階段維持未完成。
