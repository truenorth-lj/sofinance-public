# Unified open-position: shared shell + per-venue adapters

Date: 2026-11-10 (Asia/Taipei). Grounded in `origin/main` @ `2ea1bc2` and live prod
payloads from `https://sofinancelab.xyz` (sofinance-public). Extends the PM-approved
pattern in `/workspace/unified-positions/ADAPTER_DESIGN.md` (capability flags, no
chain checks in the UI, venue-specific pieces as optional slots).

This is the design for (1) why TSLAx/TSLA Raydium shows "—" and (2) one shared
Create-position UI, built from Raydium's modal, with adapters underneath for
Raydium CLMM, Meteora DLMM, Orca (when enabled), and Robinhood Chain Uniswap v4.

No transaction-building behaviour or fee constants change
(`SOFINANCE_FEE_BPS` = 10 bps on the swapped part only; RHC 10 bps). DEX code
continues to go through the registry interface (`src/lib/dex/*`) for registry
venues; Raydium stays on its existing open-prepare path until it is registered.

---

## 0. What LJ saw (2026-11-10, sofinancelab.xyz)

1. **Card** — TSLAx/TSLA · Raydium, pool `4bMb…gRbd`, LOW TVL ~$2.3k, 24h vol ~$2.7k,
   5 bps: APR pill "—", Highest range "—", copy "No 7-day estimate right now."
2. **Raydium modal** — titled "Create position" (Best halo, RangePresetPicker, input
   asset + amount + Fees & details, lemon full-width button).
3. **Meteora modal** — titled "Open a position", a stacked list of Micro / Tight /
   Standard / Wide with "N bins" and "APR unavailable".
4. **Robinhood** — a third dialog ("Open position · Robinhood Chain") wrapping
   `RhcUniv4OpenPanel` (EVM wallet, approval steps, different chrome).

LJ: always show a number; the three opens should share one component; reuse
Raydium's look; adapt each exchange underneath; modular and loosely coupled.

---

## 1. Root cause: TSLAx/TSLA Raydium "No 7-day estimate right now."

The 7-day estimate **exists and is healthy**. Before this PR the card hid it.

Live `GET /api/pool-range-apr?poolId=4bMbJzxWyiokwyQC4ndST5sJv6Qnb4viyACzhyFUgRbd`
(2026-11-10 ~11:20 UTC / ~19:20 Asia/Taipei):

| Field | Value |
|---|---|
| `sample.degraded` | `false` |
| `sample.confidence` | `"ok"` |
| `sample.days` / `dataDays` | 7 / 17 |
| `sample.windowEndUtc` | 2026-11-10 00:00 UTC |
| `freshness.snapshotAt` | 2026-11-10 00:18:28 UTC (~11h old, not expired; expiry is 48h) |
| `freshness.stale` / `lastAttemptStatus` | `false` / `"ok"` |
| `pool.tvlUsd` / `tickSpacing` / `tickCurrent` | ~$1,671 / **1** / 46056 |
| `referenceCapitalUsd` | 100 |
| `model.avgDailyVolumeUsd` | ~$1,183 |
| Preset APRs at $100 | Micro 16.36% · Tight 12.47% · Standard 7.16% · Wide 2.27% |
| 7d LP fees / day | $1,183 × 0.0005 × 0.84 ≈ **$0.50** |
| Fee cap at a $1,000 preview | 0.50 × 365 / 1000 × 100 ≈ **18.1%** |
| Pairs-list 24h fee/TVL (not shown on the card) | ~22.5% (`estimatedFeeAprPct`) |

`summarizeApr7d` (`src/lib/unified-pools/apr7d.ts`) used to publish a number only when
`highestRangeSummary` found a candidate that **fit a $1,000 preview deposit**.
For Raydium, `enforcesRangeAprSizeFit("raydium-clmm")` was true, so
`rangeAprPayload` ran `sizeFitFor` at `CARD_APR_DEPOSIT_USD = 1_000`.

`sizeFitFor` (removed from `src/lib/range-apr/size-aware.ts`) excluded a range when:

1. **crowded** — the deposit would be more than 50% of (active + own) liquidity;
2. **near-edge** — the nearer range edge is closer than 3× the estimated swap impact;
3. **cross-band** — that same impact would leave the current *tick-spacing band*.

On this pool the band is one tick (`tickSpacingBand(46056, 1) = [46056, 46057)`),
about **0.04 bps** from the current price to the nearer band edge. A $1,000
deposit against the active bin (~1.24e10 liquidity) estimates **~22 bps** of
impact. The checks at $1,000:

| Preset | own share | edge | result |
|---|---|---|---|
| Micro (±2 ticks) | 91.8% | 2.0 bps | **crowded** |
| Tight | 81.7% | 5.0 bps | **crowded** |
| Standard | 42.6% | 29 bps | **near-edge** (29 < 3 × 22) |
| Wide | 18.2% | 99 bps | **cross-band** (0.04 < 22) |

Every candidate was excluded → `highestRangeSummary` was null → status `"missing"`
with reason **"No 7-day estimate right now."** (the non-degraded missing copy).
The pill and Highest range both rendered "—".

This was the same path the unit tests documented for a SKHYx-like $126 pool ("no APR
when all preview ranges are excluded"). It was intentional at the time: the card
must not name an *actionable* $1,000 Best that Raydium prepare would reject. On a
**tickSpacing = 1** pool the cross-band rule is pathological: the band is ~1 bp,
so *any* meaningful deposit (even $100, impact ~2 bps) still failed cross-band.
Falling back to a smaller preview capital therefore still showed nothing.

The copy was also misleading: the sample was not missing. The UI was refusing to
name a range that a fixed $1,000 preview would not fit.

Meteora / Orca / RHC did **not** apply size-fit on the card
(`enforcesRangeAprSizeFit` was Raydium-only), which is why a Meteora TSLAx/TSLA
card could show a number while the sibling Raydium card showed "—".

The saved snapshot was not expired, not degraded, and had enough data days
(`MIN_DATA_DAYS = 7`; this pool has 17). rwa-refresh was **not** triggered
(standing rule). The cron's last snapshot for this pool succeeded at 00:18 UTC.

### 1.1 Honest "always a number" rule (LJ, 2026-11-10: cut size-fit)

LJ (t865u): do not keep the $1,000 size-fit check at all — "不要有這個檢查 直接砍掉".
The card and the Create-position form no longer exclude presets by crowded /
near-edge / cross-band preview fit, and the form no longer blocks with
"Lower the amount to open a position."

`summarizeApr7d` (pure; cards, table, homepage snapshot all call it) now:

1. Rank the sample's presets by 7-day fee APR (ties go wider), still fee-capped
   at the shared $1,000 preview basis (own-liquidity dilution applies). For this
   pool on the 2026-11-10 snapshot used in screenshots that is **Standard ~4.35%**.
   The $100 server reference listed Micro ~16%; repricing at the $1,000 card
   preview changes the ranking. Highest range becomes "Standard".
2. **True data gap** (degraded / no preset estimates / expired snapshot) — do
   **not** invent a range APR. Keep today's copy ("Not enough recent trading
   data…" / "No 7-day estimate right now." / "APR data is temporarily
   unavailable."). A pool-level fee/TVL figure from a shorter window would be a
   second APR and would break "only the 7-day estimate, mentioned at most once"
   plus the existing "never guess when the sample is degraded" tests.

The form ranks the same way for the typed amount (or the $1,000 preview before
one is entered). Genuine on-chain / build failures stay: prepare errors,
insufficient balance, and Meteora's 70-bin max, in plain language.
`staysInLiquidityBand` remains a quote/prepare check in the engine (a real
build failure), not a preview that hides ranges.

Copy stays 7-day (it *is* a 7-day estimate). No "earn" / "yield" / "guaranteed"
/ "backtest". "Fees not guaranteed" remains OK in the existing caveat. Errors
stay plain language, no codes.

---

## 2. Root cause: why the three opens look different

They are three independent UIs that never shared a shell.

| | Raydium | Meteora (registry DEXes) | Robinhood Chain |
|---|---|---|---|
| Component | `OpenPositionModal` + `useOpenPositionController` + `RangePresetPicker` | `RegistryOpenModal` via `RegistryOpenDialog` | `RhcOpenDialog` → `RhcUniv4OpenPanel` |
| Title | "Create position" | "Open a position" | "Open position · Robinhood Chain" |
| Range UI | `RangePresetPicker`: lemon **Best** halo, compact Micro/Tight/Standard/Wide + Custom, headline APR card | Stacked radio rows, "N bins", per-row `Est. APR` / `APR unavailable` | Its own tick / min-range controls and approval step list |
| APR source | Same `/api/pool-range-apr` payload as the card; re-priced locally via `rangeAprPayload` + `estimateRangeApr` | Same payload **joined to live `open-ranges` by exact tick/bin bounds** | Separate RHC snapshot; no 24h APR in the dialog (card is the only APR) |
| Tx path | `/api/open-quote` + `/api/open-prepare` (+ optional 2-step SOL swap) | `POST /api/dex/[dex]/open-ranges`, `quote-open`, `dexTxAdapter("open")` | `/api/rhc-univ4-open` (EVM, simulated before MetaMask) |
| Signer | Solana wallet | Solana wallet | EVM wallet (wrong-network prompt) |
| Venue-specific | 2-step SOL, rent NFT / tick arrays, protocol fee 10 bps on swapped part, custom min–max | 70-bin cap, rent disclosure, bitmap-extension / missing bin-array blocks, no native SOL input | Approval + mint + open, leftover returned, no SoFinance fee on close |

### 2.1 Why Meteora's modal said "APR unavailable"

`presetApr` (`registry-open-modal.tsx`) only prints a number when a snapshot
preset has the **same id and the same bounds** as the live open-ranges preset:

```
item.tickLower / spacing === preset.lowerUnit
&& item.tickUpper / spacing - 1 === preset.upperUnit
```

Open-ranges is computed from the **current** on-chain `activeId` (Meteora
`meteoraOpenPresets`). The APR snapshot was taken at 08:16 UTC with
`tickCurrent = 46061` (Micro ticks 46059–46063 → bins 46059–46062). Live
`POST /api/dex/meteora-dlmm/open-ranges` a few hours later returned Micro
**46058–46061**. Price moved one bin. The join fails for every preset → every
row reads **"APR unavailable"** even though the snapshot has Micro 57.5%,
Tight 52.6%, Standard 17.7%, Wide 5.3%.

The tests call this out: *"when the feed … covers other bounds"*. Raydium never
hits this because one payload drives both the buttons and the numbers.

Matching by stale exact bounds is the wrong join. "Micro" means the same
economic width around the current price; the estimator should price the *live*
bounds from the snapshot's bin model (`estimateRangeApr`), or at least fall
back to the same preset id. That is also how the shared shell will work.

---

## 3. Architecture choice

Candidates considered:

**A. Keep three modals, share a few CSS classes.** Fast, does not fix the APR
join, and the next venue (Orca, a second RHC flow) forks a fourth UI.

**B. One god component with `if (protocol === …)`.** Shortest path that compiles;
the next contributor copies the nearest branch. Rejected: the positions work
already moved away from this, and LJ asked for loose coupling.

**C. Shared presentational shell + per-venue session adapters (chosen).**
Same shape as `PositionSource` / `SourceCapabilities` in
`ADAPTER_DESIGN.md`. The UI has no `protocol ===` checks. Venue-specific UI
(bin count, rent note, 2-step SOL, EVM network prompt, custom min–max, approval
steps) renders only when the adapter's capability flags / slots are set.
Transaction building stays inside each venue's existing path (no behaviour
change).

**D. Reprice everything through the engine registry only, delete the Raydium
controller.** Correct long-term (Raydium is not in the DEX registry yet) but
out of scope: it would rewrite open-quote / open-prepare. We wrap the existing
controller instead and leave "register Raydium" as a later PR.

Why C: smallest public surface (`OpenVenueSession` view-model +
`OpenPositionShell` props), hides the most complexity (ticks vs bins vs RHC,
two HTTP shapes, two signers), and a change that looks right from the shell
file is right for every venue. Interface depth over a rich, scattered API.

---

## 4. Types (`src/lib/open-position/model.ts`)

```ts
export type OpenVenueId = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "rhc-uniswap-v4";
export type RangeUnit = "tick" | "bin" | "rhc-tick";
export type SignerKind = "solana-wallet" | "evm-wallet";

export type OpenCapabilities = {
  customRange: boolean;          // Raydium min–max; off for Meteora (bin cap) unless added later
  maxRangeUnits: number | null;  // Meteora 70
  rangeUnit: RangeUnit;
  rentNote: boolean;
  twoStepSolSwap: boolean;       // Raydium SOL path
  nativeSolInput: boolean;       // registry DEXes refuse native SOL
  evmNetworkPrompt: boolean;
  approvalSteps: boolean;        // RHC
  openStepsMax: number;
  feePolicy: { kind: "bps-on-swapped-part"; bps: 10 } | { kind: "rhc"; bps: 10 } | { kind: "none" };
  signer: SignerKind;
};

export type OpenPresetView = {
  id: "micro" | "tight" | "standard" | "wide";
  label: string;
  band: string;             // "±0.05%" or "±2 steps"
  units: number | null;     // bins or ticks, for the optional slot
  available: boolean;
  reason: string | null;    // e.g. Meteora 70-bin copy, verbatim
  lower: number;            // venue units (tick / inclusive bin / rhc tick)
  upper: number;
  priceLower: number;
  priceUpper: number;
};

/** One row of the quote / cost panel. Adapters append; the shell does not invent fees. */
export type CostLine = { key: string; label: string; value: string; help?: string };

export type OpenVenueSession = {
  venue: OpenVenueId;
  displayName: string;          // "Raydium", "Meteora", "Uniswap v4"
  pairLabel: string;
  capabilities: OpenCapabilities;
  inputs: { id: string; symbol: string; kind: "native" | "token"; balanceLabel: string; disabled?: boolean; disabledReason?: string }[];
  inputId: string;
  setInput(id: string): void;
  amount: string;
  setAmount(text: string): void;
  fillMax(): void;
  presets: readonly OpenPresetView[];
  selectedPreset: OpenPresetView["id"] | "custom";
  setPreset(id: OpenPresetView["id"] | "custom"): void;
  custom?: { minPrice: string; maxPrice: string; setMin(v: string): void; setMax(v: string): void };
  apr: import("@/components/range-apr/use-pool-range-apr").PoolRangeAprState;
  capitalUsd: number | null;    // typed amount; null → $1,000 preview
  quoteLines: CostLine[];
  notices: { kind: "info" | "alert" | "status"; testId?: string; text: string }[];
  submitLabel: string;          // "Create position" / "Create position (2 steps)" / …
  ready: boolean;
  blockedReason: string | null; // plain language, no codes
  busy: boolean;
  closeLocked: boolean;
  connected: boolean;
  connect(): void;
  submit(): Promise<void>;
  statusNode?: React.ReactNode; // existing TxStatus / confirmed links, unchanged
};
```

`estimateLivePresetApr(payload, live: { id, lower, upper }, unit)` converts live
bounds into the payload's tick space (`lower * spacing` … `(upper + 1) * spacing`
for inclusive bins; identity for Raydium ticks) and calls `estimateRangeApr` on
the snapshot model. No exact-bound join. Used by the Meteora / registry adapter
and by any future venue that has a model plus live ranges.

The shell never imports a venue module. `openVenueFor(pool)` picks the adapter
from the registry descriptor when one exists, else the Raydium session, else
the RHC session. Flags that disable a source (`ORCA_*`, `METEORA_*`,
`RHC_UNIV4_*`) still hide that venue entirely, same as today.

---

## 5. Shared form (`src/components/open-position/open-position-form.tsx`)

Implemented as `OpenPositionForm` (chrome + body) and `OpenPositionFormFields`
(the body: input asset, amount + Max, range picker, notes slot, CTA). Raydium,
Meteora (registry), and RHC all render through this form. Venue-specific copy
(rent, 70-bin cap, fee disclosure, approval steps, RHC tick presets) goes in
adapter-provided notes / the range slot. The form is shown even without a
wallet; the CTA is “Connect wallet” until one is connected. Subtitle is always
`{pair} · {venue}`.

## 5. Shared shell (`src/components/open-position/open-position-shell.tsx`)

Visual contract: Raydium's `OpenPositionModal` (the look LJ prefers).

- Overlay + `max-w-lg` dark charcoal sheet, rounded 20/28, cream type.
- Title **"Create position"** (one name everywhere). Subtitle:
  `{pair} · {displayName}` and the existing one-line explainer, with the
  explainer's last clause coming from the adapter when the flow is not
  "one Solana transaction" (RHC, multi-step).
- "Read risks before you confirm" link.
- Input asset `<select>` (Raydium styling) + Amount + Max.
- **`RangePresetPicker`** for every venue that exposes the four presets.
  New optional props, defaults preserve today's Raydium behaviour:
  - `showCustom` (default `true`; Meteora passes `false` until custom bins exist)
  - `unitSlot` — when `capabilities.maxRangeUnits` is set, a muted "N bins"
    under the band, and the existing "not available to open yet" copy on
    disabled presets.
- The picker already owns the headline APR card, Best halo, and "Other ranges".
- Cost panel: adapter `quoteLines` rendered with the same `<dl>` / "Fees &
  details" disclosure as Raydium. Extra slots (rent paragraph before a quote,
  SOL reserve copy, "wallet asks you to approve N transactions") append when
  the capability is on.
- Lemon full-width button: Connect wallet / Create position / step label.
- Escape and backdrop follow `closeLocked`.

Venue-specific slots (render nothing when the flag is off):

| Slot | On for |
|---|---|
| Custom min–max | Raydium |
| 2-step SOL copy + pending-swap card | Raydium |
| Native-SOL-refused note | Registry DEXes |
| Rent disclosure + SOL reserve | Meteora (and Raydium's own rent lines via quoteLines) |
| 70-bin / "not available to open yet" | Meteora `maxRangeUnits` |
| Wrong-network prompt | RHC |
| Approval step list | RHC |

---

## 6. Adapters (session hooks, not new tx builders)

Each hook returns `OpenVenueSession` and **calls the existing builder**:

- `useRaydiumOpenSession(pair)` — thin wrapper over
  `useOpenPositionController` + `usePoolRangeApr` + `depositUsd`. Submit is
  today's `signAndSend`. 10 bps still charged only on the swapped part.
- `useRegistryOpenSession(pool, descriptor)` — today's
  `RegistryOpenDialog` data loading (`fetchOpenRanges` + `loadPoolRangeApr`)
  and `dexTxAdapter("open")` + `useTxPipeline`. APR via
  `estimateLivePresetApr`. 70-bin cap and rent copy stay in the descriptor
  (`meta.maxRangeUnitsPerPosition`, `meta.rent`, `meta.feePolicy.open`).
- `useRhcOpenSession(pool)` — today's `useEvmWalletConnection` + the open
  panel's prepare / simulate / `eth_sendTransaction`. Custom
  range follows whatever the panel already offers (Min ±10 ticks stays the
  RHC label). Fee disclosure unchanged (RHC 10 bps).

Raydium's `OpenPositionModal` becomes `OpenPositionShell` + the Raydium
session (byte-identical UI in PR-A). `RegistryOpenModal` is deleted once the
registry session is wired. `RhcOpenDialog` keeps the wrong-network branch
and otherwise renders the same shell.

---

## 7. Migration (sequenced, each unit verifiable)

1. **PR-1 — Always show the 7-day number when the sample exists**
   (`fix/apr-card-shows-estimate-when-sample-exists`).
   - `summarizeApr7d` fallback in §1.1. Update `apr7d.test.ts` (the SKHYx-like
     thin-pool cases now a fee-capped number and a range name, not `"missing"`).
   - `presetApr` matches by preset id and/or live-bound reprice; exact-bound
     match stays as a last resort. Update `registry-open-modal.test.tsx`:
     "other bounds" of the *same id* now `Est. APR …`, not `APR unavailable`.
     A degraded or failed feed still reads `APR unavailable` (no guess).
   - No tx-building changes. Screenshots: TSLAx/TSLA Raydium card at 1280 and
     375, showing a number and Highest range; Meteora open modal showing
     estimates on the four presets.

2. **PR-2 — Shared shell + adapters**
   (`feat/unified-open-position-shell`).
   - Add `src/lib/open-position/{model,estimate,venues/*}.ts` and
     `src/components/open-position/open-position-shell.tsx`.
   - PR-2a: Raydium modal renders through the shell; existing
     `open-position-modal.test.tsx` and hermetic e2e stay green (titles,
     Best, 2-step copy).
   - PR-2b: Meteora / registry uses the shell (`RangePresetPicker` look,
     title "Create position"). Keep 70-bin, rent, fee, SOL-refused copy.
   - PR-2c: RHC dialog uses the same chrome; inner approval / simulate path
     untouched.
   - Screenshots: every venue's modal at 1280 and 375, plus the TSLAx/TSLA
     card.

Do not merge either PR. UI changes need PM review of the screenshots. No
preview deploys, no rwa-refresh, no real-money tests, no fee or prepare
changes, no DB migrations.

---

## 8. Decisions for PM / LJ

1. **Size-fit (LJ t865u, 2026-11-10):** removed entirely — card and form no
   longer filter presets by a $1,000 preview fit, and the form no longer shows
   "Lower the amount to open a position." The card shows the best 7-day range
   APR (Standard ~4.35% on the 2026-11-10 snapshot after the $1,000 preview
   reprice and fee cap). Genuine prepare / balance / 70-bin errors stay.
2. **Degraded / no sample:** keep "—" and today's plain-language reason, so we
   do not introduce a second, non-7-day APR. Change only if LJ wants a
   fee/TVL stand-in labelled "Estimated" (never "7-day").
3. **Shared title:** "Create position" on every venue (Raydium's). Meteora's
   "Open a position" and RHC's "Open position · Robinhood Chain" go away; the
   subtitle carries the venue name.
4. **Meteora Custom range:** off in v1 (bin cap + missing bin-array rules).
   The picker still shows Micro / Tight / Standard / Wide (+ Best).
5. **Ranking side-effect:** this Raydium pool will start ranking by its ~4.35%
   7-day APR (Standard) instead of falling into the no-APR group. That matches
   LJ's "highest 7-day APR wins" rule and is a visible list-order change.

---

## 9. Out of scope

- Registering Raydium in the DEX registry / rewriting open-prepare.
- Changing `SOFINANCE_FEE_BPS`, RHC fees, or any build/sign payload.
- Triggering `rwa-refresh`, preview deploys, real-money tests, Phantom / EweT.
- The `dataDays` per-day-TVL backlog (`pool-range-apr.ts`; already tracked).
- New range types or a Meteora custom-bin editor.
