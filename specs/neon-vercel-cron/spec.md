# Public Neon DB 與 Vercel Cron

狀態：2026-10-26 使用者已明確核准「依規格開始實作與遷移」；進入實作。本文件本身不代表資料已搬遷或排程已啟用。
基準：`dev/neon-vercel-cron`，`6422286f073b82e9aa4a844604563286a883ebb7`；日期：2026-10-26 Asia/Taipei。

## 目標與範圍

將 public 的持久資料搬至 public 專用 Neon project／DB，將 RWA 排程改由本 repo 的 Vercel Cron 管理；保留現有網站、API、資料語意與網域。
先完成 DB／RWA 與 position stores 切換，再切 cron，最後依證據退役 SoFinance 舊 gateway／timer。
不搬 prototype 財務 DB／reconcile cron，不重寫 engine、APR 演算法，不移除其他 app 的服務或共用主機。

## 已知基線

- 既有研究確認 Vercel Pro Active、production Ready 且 SHA 為上述基準；public 無 native cron、Storage DB 或 Shared env 連結，設定清單未見 DATABASE 變數。
- 有效 gateway 為 `sofinance-rwa.zeabur.app`；21:33 讀回 health 200，public snapshot 為 21:30:38 Taipei、stale=false。舊 local hostname 的 404 不能判作現況故障。
- 團隊 Neon `neon-carmine-leaf` 連 prototype Preview／Production，必須保留；public 新建獨立資源，不共享該 compute。
- 兩套 store 目前優先 gateway，且拒絕 Vercel direct PG；POST refresh、DB lease／epoch fencing、daily unique 已存在。
- 以上為保存證據，不代表執行切換時的即時狀態；來源見 design.md。

## 功能要求

1. RWA 與 position history 都能在 Vercel 使用驗證 TLS 的 Neon 連線；保留 fail-closed、preview gate、期限與查詢界線。
2. 搬遷七表及 Drizzle ledger：`rwa_feed_state`、`rwa_pool_latest`、`rwa_apr_latest`、`rwa_apr_daily`、`background_job_state`、`position_history_state`、`position_history_transactions`。
3. 另盤點 `SOFINANCE_OPENS_DATABASE_URL`、`sofinance_position_opens` 與 `source_ref` attribution；若存在資料／consumer，明列遷移或保留方案，不能當作七表已涵蓋。
4. repo 定義 `*/15 * * * *`，GET `/api/internal/rwa-refresh`；共用 POST 的驗證與業務流程，GET 不接受 force、不需 JSON body。
5. 保留 POST 相容性、due grace、租約接管／epoch、last-good snapshot、每日唯一且不可覆寫語意，以及 position receipts／parser／delta fences。
6. 15 分鐘 tick 不承諾 APR 每 5 分鐘更新；每日 08:10–09:10 Taipei 的取樣／缺樣語意維持。
7. 具備 scoped backup、restore drill、資料校驗、單 writer 切換及 destination 接受寫入後的復原程序。

## 分階段驗收

| 狀態 | 所需證據 |
|---|---|
| Code done | 核准後完成 stores、cron adapter、設定與操作程序，repo checks 與隔離 SQL tests 通過；不等同 production 完成 |
| Data migrated | 實際 source catalog／consumer 已盤點，restore 演練成功；受控停寫後 final copy，七表／ledger／額外 store 的筆數、穩定排序內容雜湊及時間／游標核對一致，租約轉換有紀錄 |
| Cron alive | 部署 SHA 與 Neon target 讀回正確；至少連續兩次原生 GET tick、實際成功寫入與 freshness 有證據，重複／漏 tick／失敗復原通過，跨每日窗口驗證完成 |
| Old services retired | public／prototype consumer smoke 通過，舊 gateway 無相依／流量，備份可還原後才停舊 SoFinance service 並撤銷專用憑證；共用資源不刪 |

## 未解依賴與核准

- 三份規格已獲使用者明確核准；不再要求相同範圍或一般 merge 的重複核准。
- Neon organization ownership、區域、PG17+、容量／備份保留與方案成本待選定；新付費方案／購買、平台條款或需要人類驗證的授權另依實際需要處理。
- source DB 身分／隔離、完整 catalog／大小／extensions、opens 使用情形、所有 writers／consumers、可用 export 路徑與可接受停寫窗口待查證。
- runtime pooler 相容性、Function deadline／連線總量與復原演練尚未驗證；不承諾零停機、零資料損失或 free tier 足夠。
