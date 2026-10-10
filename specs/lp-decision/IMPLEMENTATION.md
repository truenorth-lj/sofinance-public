# LP 唯讀決策：本地實作與驗收

## checkout 與授權邊界

- 實際路徑：`/Users/sophiecheng/Documents/ChatGPT/SoFinance/sofinance-public`；origin `https://github.com/truenorth-lj/sofinance-public.git`。
- 最初 baseline `6672c9a1011950ddb3fc30da389b583b3f47317e`；目前共享 HEAD `aeb1eb258a8c771ca46fe7f61aada5f477ea270f`。保留共享工作樹修改；既有 open-*／MCP 改動未編輯。
- 已讀主規格全文、AGENTS.md、CLAUDE.md、README、相關 Next 安裝版文件。沒有相關 `.agents/skills`／可讀本地 memories。
- 本工作沒有 reset、刪除修改、commit、push、PR、部署、購買、配置新憑證或簽署／廣播金融交易。退出端點只構造 unsigned simulation，不回傳可簽交易，永遠 `executable=false, sent=false`。

## 實作結果

首屏在 `/app`、`/app/rwa-pairs`、`/app/position-performance` 提供時間／USDC 金額句型、圓角卡片及上下文帶入；原錢包／開倉流程保留，`/app/ai` 仍為 MCP 設定。日期為 UTC 00:00，按實際剩餘時間計算，不上取整為整天。持倉金額仍手動輸入。

`lp-decision/2` 分開歷史絕對淨損益、同資金流 HODL 相對收益、退出淨回收及未來情境增量。既有 `pnlUsd` 未完整扣成本，不轉作完整淨收益；`currentEquityUsd` 不作退出實收。池 APR 不作未來預測。DEMO 必須顯式勾選，所有合成情境和成本有標示；正式路徑不借 demo 假成功。

| 模組 | 最終行為 |
| --- | --- |
| `lp-accounting.ts` | 原子字串／BigInt、Decimal 120 位；事件去重、內部移轉及收益去重；未知值不填零。 |
| `lp-ledger-analysis.ts` | position-boundary/1 台帳；同交易同幣淨額、已核實 claim→swap→increase 採明示 income-first 分配。跨交易同幣只列待核實候選，按提款後再存入處理，不自動認定複投。錯 owner／未知 reward 是未知正貢獻。 |
| Token-2022 邊界 | 存入用 pool amount＋transfer fee；提款用 gross－fee。principal／income 共用一次 payout fee，明示先分配收入再本金，保留 gross／fee 原子證據，不能重扣。 |
| 完整度 | 部位歷史起點、pool 原子流、累計 liquidity 對當前帳戶、收益歸屬、相關帳戶及全錢包分開。全錢包未讀不自動阻擋已可核實的部位指標。 |
| 共同成本 | 每 signature 的 meta.fee 只算一次，包含 network＋priority。exclusive 已核實 LP 為 `[fee,fee]`；混合／外部 NFT 批次為 `[0,fee]`。區間不是鏈上精確單 LP 分攤。rent funding／refund 是資產，不作全額費用／再算收入。 |
| 歷史／HODL adapter | 正式 live 台帳接區間會計與同邊界 HODL；提款時查完整 A/B 籃子。缺正貢獻只取消上界，缺負貢獻只取消下界；缺完整起點／截點一致性則完整指標 unavailable。已定價部分另列 subtotal，不能叫完整 PnL。 |
| `lp-current-equity.ts` | 單一 confirmed getMultipleAccounts context 讀 position／pool／boundary ticks／clock／reward mint；SDK PositionUtils fees/rewards 加 installed SDK 時間累積／emission cap 整數規則。snapshot 成功才宣告待領 inventory 完整；缺價另外限制估值。 |
| 歷史／snapshot 一致性 | current snapshot 後查 newest signature，核對歷史 head；fee-only claim 即使 liquidity 不變仍降級／要求重讀。不能把新 equity 配舊 journal。 |
| `lp-live-marks.ts` | 多個核實直接 USDC venue；completed-prior-minute age≤60s，無 lookahead／empty-fill／當前價回填。來源 min/max 是觀測價差範圍，不是統計信賴區間；USDC=1 是計價單位恆等，不是假設 USD peg。來源 429 暫停 60s；TTL＋容量界。 |
| `lp-flow-data.ts` | 25s 總預算／10s 單來源，RPC 間隔；保留最後成功 cursor，失敗不跳交易。同 position 序列化，head 變化清舊 cache；位置 cache 15min／最多20個。讀完整 position 後才查 NFT mint／token-account 相關成本窗口（最多1000 signatures，達上限即 partial）。 |
| `lp-scenario.ts` | 維持／重掛同初始 range；outside-range／價格條件、cooldown／max count／每次成本；扣增量成本、不重扣沉沒成本。沒有可核實套利回流，不編造收入。條件式 breakeven 限取樣點，不稱精確交點。 |
| 模型 gate | probability 一律 null；資料、样本外、洩漏、校準未通過不顯示百分比或概率排序。 |
| `lp-position-evidence.tsx` | 正式 UI「讀取實際台帳與歷史／HODL」「預覽退出：USDC＋SOL」，部分區間／成本／歸屬細節、續讀、來源錯誤、60s估值過期、15s退出期限及 SOL 曝險。拒絕 replay／demo 作當前值；取消／輸入切換／unmount 令舊回應失效，防重複請求。 |

主 `/api/lp-decision` 的既有單值歷史欄位仍 unavailable；正式區間計算由新增 live ledger adapter 與同頁持倉證據卡提供，未把區間硬填入 exact scalar 欄位。

## 真實公開證據（不是使用者私有持倉）

公開測試池 `DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro` 內的一個真實部位。該部位的 NFT、position PDA、原始交易與數量不列入公開版本；證據檔與重播測試（`specs/lp-decision/fixtures/`、`*.evidence.test.ts`）只保留在擷取它們的本機，已列入 `.gitignore`。

- `fixtures/public-transaction-evidence.json`：51筆交易，liquidity 對帳；102組pool token checks、10筆RAY payout 餘額吻合。scoped wallet A/B與SOL／rent亦核實。
- network `260000`＋priority `1420466`＝`1680466` lamports；初始 rent `9145440`＝已退NFT `560240`＋當前三帳戶可回收 `8585200`。外部退款批次總fee `20000`，部位分攤 `[0,20000]`，未假裝精確。
- `fixtures/public-historical-mark-audit.json`：85個 token/day 直接USDC分鐘來源；164個參考點有107個符合60s，57個稀疏／過舊拒算。無缺檔／窗口截斷。這是舊回放窗口，不是目前正式報價。
- `fixtures/rpc-current-equity-snapshot.json`：新增真實單一截點；A／B 本金＋fees 與 RAY 待領以原子量核對，liquidity相同。捕獲資料會過期；只作 coherent decoder 回放測試，正式路徑重新讀 RPC。
- `fixtures/closure/two-token-success/`：完整提款／領費／關閉＋兩個token換USDC的成功unsigned simulation原始組；1123 bytes、原token餘額delta全0、network＋priority5000、SOL淨回收8580200。不要混用root closure不同失敗attempt。
- `/api/lp-decision` 曾真實讀取100筆USD日線、近期原始事件及兩個独立本金quote。日線／本金quote不冒充歷史USDC或完整退出淨回收。

正式 `/exit-preview?convertRent=0` 回分資產向量；SOL費用已在native淨變化，route費用／價格影響已在USDC模擬實收，均不再次扣除。`netRecoveryUSDC=null`。最早quote起算15s是本地刷新政策，另核對block height，不是provider承諾。CU price=0不保證landing。Direct-USDC pool/reward目前明確拒算。

## 真正仍缺的資料／工程限制

| 驗收 | 剩餘限制 | 性質 |
| --- | --- | --- |
| M0 | public baseline已核實；private／正式部署SHA未確認 | 未提供／未授權的部署來源，不阻擋本地實作 |
| M1／M2完整實證 | 公開稀疏minute資料仍有57個事件點超過既定age；多venue live adapter可增加覆蓋，不能保證來源存在，也不能放寬門檻凑通過。live RPC若429保留partial並續讀 | 來源覆蓋／公共限速；全錢包審計不是部位指標的前置條件 |
| 真正跨交易複投 | 可用部位邊界規則計算；要聲稱特定已領收入後來複投，仍需核實 intervening wallet flows | optional provenance資料；未知隔離，不能默認compound |
| M2／M4正式未來情境 | 缺可重播 tick／active liquidity／volume 時間路徑、個別策略真實增量成本與風險參數 | 觀測資料／策略範圍；確定性引擎與gate已完成，demo不是正式預測 |
| 全USDC原子退出 | 含SOL第三腿1358–1363 bytes >1232；已試direct/maxAccounts12、16→20、ATA／ALT壓縮及Hadron路由。quote／instructions可取得，不能歸因缺憑證 | 工程／路由條件；可交付USDC＋SOL向量。新ALT需鏈上簽署（未授權）；兩獨立simulation不能當順序bundle |
| M5 | 無固定訓練／保留集、完整池路徑archive、樣本外Brier／reliability／coverage、預先門檻及洩漏檢查結果 | 模型與資料依賴；probability維持null |
| M6發布／真交易 | 未執行 | 明確未授權；唯讀本地QA另列 |

## 驗證

最終 aggregate／production UI QA記錄於下方。舊版410／421 tests不代表本輪最終樹。

- 最終命令：`npm run lint && npm run typecheck && npm test && npm run build`。
- meaningful regression：成本只扣一次、Token-2022 存入／提款共用費用、同交易claim→swap→increase／混合庫存、錯owner reward、HODL完整籃子請求、head fee-only變更、concurrent position readers、真實單一截點 decoder／錯owner／過期clock、source no-lookahead／429cache、UI vector／expiry／duplicate／cancel／replay拒絕／partial續讀。
- 未跑：真實金融交易、部署、Python exploratory backtest、private deployment audit；未通過：完整真實歷史估值、正式未來情境、樣本外校準。

## 本地操作

```sh
cd /Users/sophiecheng/Documents/ChatGPT/SoFinance/sofinance-public
npm run dev -- --webpack --hostname 127.0.0.1 --port 3001
```

開 `http://127.0.0.1:3001/app`；選日期及USDC金額。DEMO顯式開啟才有合成三情境。RWA帶池；position-performance輸入持倉 NFT 即可見新唯讀台帳／退出入口，無需先跑原績效全窗口查詢。若已有production preview占用3001，不重複啟動。

```text
/api/lp-decision/ledger?positionId=<NFT>&source=live&analyze=1
/api/lp-decision/ledger?positionId=<NFT>&source=live&analyze=1&before=<last-success-signature>
/api/lp-decision/ledger?positionId=<NFT>&source=captured-public
/api/lp-decision/exit-preview?positionId=<NFT>&convertRent=0
```

captured-public 為固定公開benchmark replay，fresh=false／replayOnly，不作目前持倉結果；未驗 standalone部署打包。來源fixtures須保留。

離線重播：`node --import tsx scripts/reconcile-lp-public.ts`；歷史來源覆蓋 `node --conditions=react-server --import tsx scripts/reconcile-lp-marks.ts`。公開重新捕獲腳本 `probe-lp-public.mjs --resume`、`probe-lp-market.mjs`、`probe-lp-history-marks.mjs`／`probe-lp-closure.mjs`，會更新公開fixtures；遇429停止／續傳，不配置憑證。

### 最終程式樹 aggregate

停止本次 dev server 後執行 `npm run lint && npm run typecheck && npm test && npm run build`，exit 0：lint零warning、typecheck通過、88個測試檔／439項全部通過、production build通過。額外fee-only claim整合測試保持liquidity吻合但更換history head，確認所有完整歷史上下界降級。build僅有既有bigint pure-JS fallback及RWA／pool-daily-apr dynamic探測訊息，最終路由正確為dynamic，沒有編譯失敗。

production preview以 `npm run start -- --hostname 127.0.0.1 --port 3001` 運作（session57045）。最終新入口浏览器已成功核對真實向量 `〔數值未公開〕` USDC原子量＋`8580200` lamports、fee5000、1119 bytes，取得 `2026-10-09T20:03:06.709Z`、期限 `20:03:21.058Z`，隨後實際顯示過期。這是已過期驗收快照，不可作即時報價。截圖 `artifacts/lp-decision-final-vector-qa.jpg`。

Production瀏覽器亦通過：原生日期鍵盤切換清除舊退出結果、金額1000→2000令進行中退出失效、主返回／取消停止退出、不存在的合法NFT顯示account unavailable而沒有零回收。日期picker的自動化fill未提交React事件，改以原生鍵盤ArrowUp／blur確認實際日期切換；不是以DOM注入結果假裝通過。舊停服分頁為data:錯誤頁，沒有操作其被policy阻擋的內容，依documented stale-tab recovery在同一IAB browser建立新的HTTP分頁。

### 最終 production UI 結果

| 項目 | 結果 |
| --- | --- |
| 新台帳／退出入口 | 通過：公開NFT帶入，不依賴原績效查詢／錢包簽名。 |
| live完整position窗口 | 通過：自動分頁至51筆、讀至起點、positionAccounting=reconciled、walletAccounting=not-collected。全錢包未讀沒有阻擋部位對帳。 |
| 缺價格／部分合計 | 通過：歷史／HODL仍unavailable，有價部分另列〔數值未公開〕～〔數值未公開〕 USDC（當次部分合計，非完整淨收益）。這不是價格齊全的验收通過。 |
| 向量與cost | 通過：正式unsigned回收USDC＋SOL，network／priority已在SOL；第二次〔數值未公開〕 USDC＋0.008580200SOL、1083bytes，取得20:07:10.242Z，期限20:07:24.495Z；已過期。 |
| freshness | 通過：15s退出過期及60s部位估值過期均在真實UI顯示。 |
| 日期／金額／取消 | 通過：原生日期切換、金額變更、主返回／取消與獨立取消令舊結果失效。忽略abort及重複點擊由React整合測試補充核實。 |
| 缺部位資料 | 通過：合法但不存在的NFT明確unavailable，不填0。 |
| 虧損與無法回本 | 通過：最終production顯式DEMO，下跌維持-511.4682、重掛-517.4682、退出-1.0000；相對重掛-6.0000、期間內未估得breakeven。合成／no probability／非實際持倉明示。 |
| 返回demo／正式 | 通過：返回清除demo結果，取消DEMO後恢復正式入口。 |
| 完整歷史USDC／HODL實證 | 未通過：價格來源覆蓋／稀疏／公共限速。沒有用captured資料作live成功。 |
| 正式未來情境與模型校準 | 未通過：沒有足夠觀測路徑／固定樣本外評估；probability=null。 |
| 真實金融交易／部署 | 未跑：未授權。 |

最終圖 `artifacts/lp-decision-final-ledger-qa.jpg` 同時顯示51筆部位对帳、完整收益unavailable、部分合計及兩種過期狀態；`lp-decision-final-vector-qa.jpg` 為首次短效向量成功時截圖。保留同一browser的新production分頁作交付；伺服器僅綁127.0.0.1。最終git diff --check通過，HEAD不變。
