# Phase E design: move remaining DEX UI behavior into the registry

Date: 2026-11-12 (Asia/Taipei). Docs only — no code in this PR. Grounded in
`truenorth-lj/sofinance-public` `main` @ `7b39de6410efb856a41f5a8ba2688dbb6cee28ce`
(D6 squash of #371, empty tree vs approved `ecbddcbe4d04e58901705aaccc22d0b67c84ff03`).

Revised in this PR after PM approved head `e6365ba0485b7028cab1f5d7f7da39f3c25a6931`
with one design change: `showHighestRange` and `nullFeeLabel` stay in
`CHAIN_META` (chain presentation, not DEX behavior). Only `opensRhcDialog`
(folded into `openUi: "rhc-dialog"`) and everything in `PROTOCOL_META` move
into the registry. PM agreements are recorded in §0.

This is the design for the Phase E line in the local audit (not in this repo):
move that DEX behavior into `dexDescriptors` / the registry, and add a
shrink-only boundary test that counts protocol-keyed tables outside
`src/lib/dex`. It does **not** start the E1–E3 venue migrations (Orca
read-only, RHC Uniswap v4 money path, Raydium CLMM money path). Those stay
their own series, with a PM design review before E3.

No transaction-building, fee constants, fee-wallet, signing order, or Vercel
env vars change in the PRs this document sequences. `#364` is out of scope.

---

## 0. PM agreements (2026-11-12)

Recorded from the approval of #372. Implementation PRs follow these as written:

- **No stub descriptors.** Do not register Raydium, Orca, or RHC as
  `DexDescriptor`s in E-T / E-dispatch / E-move. A real descriptor arrives
  only with that venue's E1–E3 series.
- **No invented `feePolicy`.** Do not put a placeholder fee, rent, or
  `planLpFeeShare` on a half-registered DEX.
- **`useDescriptorPlanTerms` stays exactly as today:** `true` for Meteora,
  `false` for every other protocol. Flipping it is an intended product change
  in E2/E3, not a side effect of moving UI flags.
- **`openUi` is call-for-call equivalent** to today's routing: Raydium
  `native-modal`, RHC `rhc-dialog`, Meteora `registry`, Orca `none`.
- **Table ceiling = the shipped scanner's count**, shrink-only. The inventory
  in §1.5 is a preview; E-T freezes whatever the scanner it ships actually
  reports.

Approved sequence, each PR separately approved: **E-T**, then **E-dispatch**,
then **E-move**. **E-labels** and **E-discovery** are skipped for now.

---

## 1. Current state (file:line)

### 1.1 Only Meteora is in the registry

`DEX_IDS` already names four venues (`src/lib/dex/types.ts:14`):
`raydium-clmm`, `orca-whirlpool`, `meteora-dlmm`, `uniswap-v4-rhc`.

The client registry list is only Meteora (`src/lib/dex/descriptors.ts:8`):

```ts
export const DEX_DESCRIPTORS: readonly DexDescriptor[] = Object.freeze([meteoraDlmmDescriptor]);
```

The server module list is the same set (`src/lib/dex/modules.ts:8`).
`registry.test.ts` requires those two lists to name the same DEXes, and a
registered module must have a `describeDexContract` suite (`src/lib/dex/README.md`,
"Adding a DEX").

A `DexDescriptor` today is a full contract object (`src/lib/dex/types.ts:130–138`):
`id`, `chain`, `displayName`, `meta: DexMeta`, `capabilities: DexCapabilities`,
optional `positionCapabilities`. `DexMeta` (`types.ts:79–114`) is protocol
economics and mechanics (range units, open-step bounds, rent, approvals,
`feePolicy`, `planLpFeeShare`, `depositInputs`, …). `DexCapabilities` already
includes `open` and `plan` (`types.ts:117–127`). There is **no** field for
"open in the native Raydium modal", "open in the RHC dialog", or an external
pool URL. Highest-range visibility and the null fee-tier label live on
`CHAIN_META` and stay there (see §2.2).

Meteora's descriptor is the one complete example
(`src/lib/dex/meteora-dlmm/descriptor.ts:26–80`): `capabilities.open` and
`capabilities.plan` are `SUPPORTED`, `meta.feePolicy` charges 10 bps on the
swapped part of open/add and on withdraw-to-USDC, and compound is `none`.

### 1.2 `PROTOCOL_META` / `CHAIN_META` — what is actually there

Defined next to the pool loaders in
`src/components/unified-pools/use-pool-sources.ts`.

`ProtocolMeta` (`use-pool-sources.ts:120–125`) has three optional fields:

| Field | Meaning |
|---|---|
| `planFallback` | `SUPPORTED` so a pool still gets a Plan / Calculate link when the protocol is **not** in `DEX_DESCRIPTORS`. |
| `externalPoolUrl(poolAddress)` | Off-site "open on the venue" URL. |
| `opensNativeModal` | Open with the panel's existing native dialog (Raydium Create position, or RHC via `openPool`). |

`PROTOCOL_META` (`use-pool-sources.ts:127–134`) is only partially filled:

| Protocol | `opensNativeModal` | `planFallback` | `externalPoolUrl` |
|---|---|---|---|
| `raydium-clmm` | `true` | `SUPPORTED` | `https://raydium.io/clmm/create-position/?pool_id=…` |
| `uniswap-v4-rhc` | `true` | (unset) | (unset) |
| `meteora-dlmm` | absent (tests assert `undefined`) | absent | absent |
| `orca-whirlpool` | absent | absent | absent |

`ChainMeta` (`use-pool-sources.ts:136–145`) is **chain-keyed**, not
protocol-keyed, and holds both chain presentation and one DEX-routing flag:

| Chain | `showHighestRange` | `nullFeeLabel` | `opensRhcDialog` |
|---|---|---|---|
| `solana` | `true` | `"—"` | unset |
| `robinhood` | `false` | `"Dynamic"` | `true` |

`showHighestRange` and `nullFeeLabel` are chain presentation and **stay on
`CHAIN_META`**. Only `opensRhcDialog` is DEX behavior; it is folded into
`openUi: "rhc-dialog"` (see §2.2).

Helpers: `protocolMeta` / `chainMeta` at `use-pool-sources.ts:147–151`.
Characterization: `use-pool-sources.test.tsx:124–131`.

### 1.3 How the UI consumes those tables today

**Plan link** (`src/components/unified-pools/pool-card.tsx:59–60`):

```ts
const plan = dexDescriptors.descriptorFor(pool.protocol)?.capabilities.plan
  ?? (meta?.planFallback ?? null);
```

A registered DEX (Meteora) uses `capabilities.plan`. Raydium, which has no
descriptor yet, uses `planFallback`. Orca and RHC have neither, so they get no
Calculate / Plan button. The comment on that line states this split explicitly.

**Highest range + fee label** (`pool-card.tsx:56–57, 91, 103`): read from
`chainMeta(pool.chain)`. Solana cards show Highest range and render a missing
fee tier as `"—"`; Robinhood cards hide Highest range and render a missing fee
tier as `"Dynamic"`. These reads stay on `chainMeta` after E-move.

**External URL** (`pool-card.tsx:58`): `protocolMeta(…).externalPoolUrl(pool.poolAddress)`.
Only Raydium has one.

**Open button** (`src/components/unified-pools/unified-pools-panel.tsx:140–150`),
abbreviated:

1. Unsupported token → `{ kind: "unsupported" }`.
2. If `dexDescriptors.descriptorFor(pool.protocol)?.capabilities.open` is
   present: unsupported → greyed with the capability reason; supported → open
   the **registry** dialog (`setRegistryOpen`).
3. Else if `protocolMeta(…).opensNativeModal` → `openPool(pool)`.
4. Else → `"Opening is not available yet"` (today: Orca).

`openPool` itself (`unified-pools-panel.tsx:122–135`) does **not** look at the
protocol. It first checks `chainMeta(pool.chain)?.opensRhcDialog` and, when
true, opens the RHC dialog (`onOpenRhc`). Otherwise it opens the Raydium Create
position dialog from the Solana row. So RHC's `opensNativeModal: true` only
gets the user into `openPool`; the chain flag is what picks the RHC dialog.

**Deep link** (`/app/rwa-pairs?openPool=…`, `unified-pools-panel.tsx:153–163`):
if `actionFor(pool).kind === "open"`, then

```ts
if (dexDescriptors.descriptorFor(pool.protocol)) setRegistryOpen(pool);
else openPool(pool, false);
```

The test is **descriptor presence**, not `capabilities.open.supported` and not
`opensNativeModal`. This is the main landmine for Phase E (see §4 and §5).

**Homepage** (`src/components/homepage-pools-table.tsx:55–65`): a registry DEX
whose `open` is unsupported is disabled; every other pool is a link to
`/app/rwa-pairs?openPool=…`, which then hits the deep-link rule above.

### 1.4 Plan / share-calc terms also key off descriptor presence

`planPoolTerms` (`src/lib/lp-plan-pool-terms.ts:8–14, 130–161`) is the shared
projector for `/app/plan` and the pools-page calculator
(`src/components/plan/plan-app.tsx:77–78`,
`src/components/unified-pools/share-calc-dialog.tsx:81–86`).

- `descriptor == null` (Raydium today, and any other unregistered protocol):
  `LEGACY_COST` / `LEGACY_LP_FEE_SHARE` / `LEGACY_EXITS` — "about 1% of the
  deposit" opening cost, Raydium's usual LP fee share, exit to USDC or the
  pool tokens (`lp-plan-pool-terms.ts:54–64, 98–109, 138–147`).
- `descriptor != null`: opening cost and exits are derived from
  `meta.feePolicy`, `meta.rent`, `meta.planLpFeeShare`, and
  `capabilities.withdraw` / `withdrawOutputs` (`lp-plan-pool-terms.ts:71–96,
  119–128, 149–161`). That is what Meteora already uses.

Adding a `DexDescriptor` for Raydium or RHC, even a "UI-only" one, would
switch those venues off the legacy planning assumptions unless this split is
changed first. That is a behavior change on a planning path that talks about
fees and opening cost. It is called out for LJ in §5. PM agreement:
`useDescriptorPlanTerms` stays exactly as today (Meteora `true`, others
`false`).

### 1.5 Other protocol-keyed tables outside `src/lib/dex` (inventory)

The audit asks the new boundary check to count protocol-keyed tables outside
`src/lib/dex`. A first pass over `src/` (same root the existing
`architecture-dex-boundaries.test.ts` scans; test files excluded), looking for
**static object literals** whose keys include a canonical or legacy DEX id
(`raydium-clmm`, `orca-whirlpool`, `meteora-dlmm`, `uniswap-v4-rhc`,
`rhc-uniswap-v4`):

| # | Table | File | What it is |
|---|---|---|---|
| 1 | `PROTOCOL_META` | `src/components/unified-pools/use-pool-sources.ts:127` | The DEX-behavior table this design moves. |
| 2 | `PROTOCOL_LABELS` | `src/lib/unified-pools/model.ts:19` | Display names ("Raydium", "Orca", …). `DexDescriptor.displayName` already holds this for Meteora (`descriptor.ts:29`). Stays put for now (E-labels skipped). |
| 3 | `DISCOVERY` | `src/app/api/protocol-pools/route.ts:19–23` | Flag-gated read-only list loaders for Orca, RHC, and Meteora (not Raydium; Raydium is `/api/rwa-pairs`). Production flags are off → 404. Stays put for now (E-discovery skipped). |

`CHAIN_META` is chain-keyed, so it is **not** in that count. After E-move it
still holds `showHighestRange` and `nullFeeLabel`. Only `opensRhcDialog`
leaves it.

Related, but **out of the first ceiling** (wrong key shape, or runtime, or a
different layer):

- `SOURCE_ERROR` and `POOL_SOURCES` in `use-pool-sources.ts:19, 73` — keyed by
  source aliases `raydium` / `orca` / `meteora` / `rhc`, not by `DexId`. They
  are the C2 loader table, not open/plan behavior.
- `unifiedPoolFlags()` (`src/lib/unified-pools/flags.ts:10–17`) — a function
  returning booleans from deploy-target flags, not a protocol-keyed table.
- `src/lib/protocol-flags.ts` — each constant is `Record<DeployTarget, boolean>`,
  not a protocol-keyed table. Do not touch the `METEORA_DLMM_*` Vercel env vars
  (D6 standing rule).
- Runtime accumulators typed `Partial<Record<DexId, …>>` (for example daily TVL
  stats in `src/lib/rwa-refresh/`).
- `packages/engine/src/protocols/registry.ts` — engine CLMM adapter dispatch,
  outside the `src/` scan and a different layer than `dexDescriptors`.
- `PRICE_SOURCE_ID.raydium` in `src/lib/position-performance-assemble.ts:21–24`
  — a price-source enum, not a DEX id.

The implementing PR (E-T) must run the scanner it ships and freeze **that**
count as the ceiling if it differs from this inventory of 3 (PM: ceiling =
shipped scanner count, shrink-only).

---

## 2. Target shape

### 2.1 Why not "just add stub descriptors" for Raydium / RHC / Orca

Three independent consumers treat **descriptor presence** as "this DEX is on
the registry path":

1. Open button: `capabilities.open` present → registry dialog, never
   `opensNativeModal` (`unified-pools-panel.tsx:144–149`).
2. Deep link: `descriptorFor(protocol)` truthy → `setRegistryOpen`
   (`unified-pools-panel.tsx:162–163`).
3. Plan / share-calc: any descriptor → `descriptorCost` / `descriptorExitCost`
   instead of `LEGACY_*` (`lp-plan-pool-terms.ts:138–161`).

`DexDescriptor` also requires a complete `DexMeta`, including `feePolicy`
(`types.ts:98, 130–135`). A stub would have to invent a fee policy that other
code might start reading. `DEX_DESCRIPTORS` must stay in lockstep with
`DEX_MODULES` and a contract suite, so a stub is not a client-only data blob.

Therefore Phase E does **not** register Raydium, Orca, or RHC as
`DexDescriptor`s until that venue's own series (E1–E3) is ready to own
economics, an adapter, and fixtures (PM: no stub descriptors, no invented
`feePolicy`). The move of today's UI flags must not wait on those series.

### 2.2 Registry UI record, looked up through the existing registry

Add a client-safe UI record in `src/lib/dex` (name bikeshed: `DexUi`, living
on the descriptor when one exists, and in a registry-local table for venues
not yet registered). The panel, cards, homepage, and deep link call one
helper, e.g. `dexDescriptors.uiFor(protocol)` (exact method name is
implementer's choice), and stop importing `PROTOCOL_META` and
`opensRhcDialog`. Cards keep reading `showHighestRange` and `nullFeeLabel`
from `chainMeta(pool.chain)`.

Target `DexUi` shape (all fields data, no `protocol === "…"` at the call site).
It does **not** include `showHighestRange` or `nullFeeLabel`:

```ts
export type DexOpenUi = "registry" | "native-modal" | "rhc-dialog" | "none";

export type DexUi = {
  /** Which open shell the pools page / deep link uses. */
  openUi: DexOpenUi;
  /** Off-site venue URL, if any. */
  externalPoolUrl?: (poolAddress: string) => string;
  /**
   * When true, `/app/plan` and the share calculator use descriptor fee/rent
   * terms. When false, they keep `LEGACY_*` in `lp-plan-pool-terms.ts`.
   * Must stay exactly as today: true only for Meteora (PM 2026-11-12).
   */
  useDescriptorPlanTerms: boolean;
};
```

**Why those two fields stay on `CHAIN_META`:** they are chain presentation,
not DEX behavior. Solana cards show Highest range and use `"—"` for a missing
fee tier; Robinhood cards do not, and use `"Dynamic"` (`pool-card.tsx:91,
103`, `use-pool-sources.ts:143–144`). Putting them on `DexUi` would force
every protocol to declare them. A future Solana DEX that omitted the fields
would silently inherit a default of `showHighestRange: false` and hide the
row, even though every Solana pool today shows it. Keeping the flags on the
chain table means a new Solana (or Robinhood) venue gets the right
presentation without a per-protocol entry.

`uiFor(id)` resolves, in order:

1. `normalizeDexId(id)` (already handles `rhc-uniswap-v4`,
   `src/lib/dex/types.ts:33–36`).
2. If a `DexDescriptor` is registered **and** it carries `ui`, use that.
3. Else the registry-local table (the moved `PROTOCOL_META` plus
   `opensRhcDialog`, folded into `openUi`).
4. Else a safe default: `{ openUi: "none", useDescriptorPlanTerms: false }`.

`plan` stays `capabilities.plan` when a descriptor exists, otherwise a
`planFallback` capability on the UI record (same union `pool-card.tsx:60`
already implements). Once every venue that should have a Plan link has a real
descriptor, `planFallback` goes away.

`DexDescriptor` grows an optional `ui?: DexUi`. Meteora's descriptor is
updated to make today's implicit values explicit. Unregistered venues live
only in the registry-local table until E1–E3.

Equivalent values to ship (must match §1.2–1.3 exactly; `openUi` is
call-for-call equivalent, `useDescriptorPlanTerms` is exactly as today):

| Protocol | `openUi` | `plan` / fallback | `externalPoolUrl` | `useDescriptorPlanTerms` |
|---|---|---|---|---|
| `meteora-dlmm` | `"registry"` | `capabilities.plan` (`SUPPORTED`) | unset | `true` (already on this path) |
| `raydium-clmm` | `"native-modal"` | `planFallback: SUPPORTED` | today's Raydium URL | `false` |
| `uniswap-v4-rhc` | `"rhc-dialog"` | unset (no Plan button today) | unset | `false` |
| `orca-whirlpool` | `"none"` | unset | unset | `false` |

`opensNativeModal` and `opensRhcDialog` are replaced by the single `openUi`
tag. `openPool` should no longer branch on `chainMeta(…).opensRhcDialog`.
`CHAIN_META` keeps `showHighestRange` and `nullFeeLabel` only.

### 2.3 Dispatch must use `openUi`, not descriptor presence

Before any data is moved, the consumers in §1.3–1.4 must be rewired:

- `actionFor`: switch on `uiFor(protocol).openUi` (`registry` /
  `native-modal` / `rhc-dialog` / `none`), and for `registry` still honour
  `capabilities.open.supported`.
- Deep link: the same `openUi` switch, **never**
  `if (descriptorFor(protocol)) setRegistryOpen(pool)`.
- Homepage: keep linking to `?openPool=`; the app page uses the same `openUi`.
- `planPoolTerms`: use descriptor economics only when
  `ui.useDescriptorPlanTerms` is true (Meteora today; others false). A later
  E3 Raydium descriptor does not flip Plan numbers just by being registered.

Until that rewiring lands, adding any new `DexDescriptor` is a behavior
change. The PM rule "do not drop more architecture-dex branches via UI lookup
tables before phase E" stays in force until these fields live **inside**
`src/lib/dex` and the new table ceiling is in place. New protocol-keyed tables
outside `src/lib/dex` are not an acceptable temporary home.

---

## 3. Boundary test: protocol-keyed tables outside `src/lib/dex`

### 3.1 What it counts

A new shrink-only test, next to `src/lib/architecture-dex-boundaries.test.ts`
(same scan root `src/`, same "real test files + `src/lib/dex/__contract__/`
are exempt" rule at that file's `:74–75`). Suggested files:
`src/lib/architecture-dex-tables.test.ts` and
`src/lib/architecture-dex-tables-baseline.json`.

A finding is a **static object-literal table** (including `as const` /
`Object.freeze(…)`) in a non-exempt file **outside** `src/lib/dex/**` whose
keys include at least one canonical or legacy DEX id (the set already listed
in `DEX_BRANCH_LITERALS` minus chain strings — see
`architecture-dex-boundaries.test.ts:37–40`: `raydium-clmm`, `orca-whirlpool`,
`meteora-dlmm`, `uniswap-v4-rhc`, `rhc-uniswap-v4`).

Counted: one finding per such table (not per key). The existing branch guard
already counts `protocol === "…"` comparisons; this test is specifically
tables, including the "lookup map" blind spot called out at
`architecture-dex-boundaries.test.ts:13–14`.

Not counted (document in the test header so reviewers do not have to
re-litigate):

- Chain-keyed tables (`CHAIN_META`, `CHAIN_LABELS`), including after
  `opensRhcDialog` is removed — `showHighestRange` and `nullFeeLabel` stay.
- Source-alias tables (`SOURCE_ERROR`, `POOL_SOURCES`).
- Runtime-built `Record`s and `useState`.
- Price-source / error-code maps that happen to contain the substring
  "raydium" on a different type.
- Files under `src/lib/dex/**`.
- Engine paths under `packages/` (this scan, like the existing one, is `src/`).

If a later PR wants a second metric for source-alias tables, that is a
follow-up, not a silent widening of this ceiling.

### 3.2 Ceiling and ratchet

Mirror `architecture-dex-boundaries.test.ts:6–8, 34–35, 282–297, 321–323`:

- A JSON baseline lists each violating file and its table count.
- `BASELINE_CEILING.tables` is the sum, pinned in the test so raising the
  ceiling takes two deliberate edits.
- **Initial ceiling = the shipped scanner's count** (PM 2026-11-12). The
  inventory in §1.5 is **3** (`PROTOCOL_META`, `PROTOCOL_LABELS`,
  `DISCOVERY`). E-T re-runs the scanner and freezes whatever it actually
  reports; if that is not 3, the PR says so and uses the scanner's number.
- A new file or a higher count fails.
- A lower count than the baseline also fails until the JSON and
  `BASELINE_CEILING` are lowered in the same PR (shrink-only ratchet).
- The totals assertion is `<= BASELINE_CEILING`, same as imports/branches.

`PROTOCOL_LABELS` and `DISCOVERY` stay for now (E-labels and E-discovery are
skipped). They still occupy ceiling slots, so new tables cannot be added
without lowering others.

Negative controls: an in-memory probe tree (same idea as
`architecture-dex-boundaries.test.ts` `PROBE_TREE`) with a planted
protocol-keyed table outside `src/lib/dex` must fail, and the same table
inside `src/lib/dex` must not.

---

## 4. PR order and equivalence evidence

Approved order, each step separately approved: **E-T**, then **E-dispatch**,
then **E-move**. Do not start E1–E3 code in any of these PRs. Do not merge any
of them until PM approves the new heads. No preview deploys, no Vercel env
changes, no real-money tests, no Phantom/EweT, no `#364` files. UI shots
(1280 and 375) only if a PR changes pixels; none of these three PRs should.
E-labels and E-discovery are skipped for now.

Each PR stays behavior-preserving unless an intended change is called out
with its own regression test (standing rule). The sequence below is written
so each step can prove equivalence without a behavior change.

| Step | PR | What | Equivalence evidence |
|---|---|---|---|
| **E-T** | test only: table scanner + baseline + `BASELINE_CEILING` (ceiling = shipped scanner count, shrink-only) | No production code. | The new test, including probe-tree negative controls. Existing `architecture-dex-boundaries` still green (imports 78, branches 28 after D6). CI `check` green. No smoke, no shots. |
| **E-dispatch** | Rewire `actionFor`, deep link, `openPool`, homepage comments, and `planPoolTerms` to key off `openUi` / `useDescriptorPlanTerms` **without** moving the data yet. Temporary: a small mapper in or next to the current files may read `PROTOCOL_META` and `opensRhcDialog` to produce `DexUi`, so call sites no longer test descriptor presence. That mapper is deleted in E-move. `showHighestRange` / `nullFeeLabel` stay on `CHAIN_META` and are not part of this mapper. | **Required table test** (button and deep link, each cell asserting the same handler is called before and after): all four protocols plus the legacy `rhc-uniswap-v4` alias, covering unsupported token; Meteora `open` unsupported and supported; Raydium native modal; RHC dialog; Orca "Opening is not available yet". Characterization tests for `use-pool-sources` (`:124–131`) still pass (tables unchanged). `planPoolTerms` unit tests (or new snapshots) for `descriptor: null` (Raydium legacy terms) and for the Meteora descriptor (unchanged `descriptorCost`); `useDescriptorPlanTerms` remains true only for Meteora. Share-calc / plan-app tests. Hermetic e2e if an existing pools-open or plan case covers this (do not add a real-money path). Read-only `/app` 200 smoke after merge, if PM asks. No shots unless pixels change (they should not). |
| **E-move** | Introduce `DexUi` + `uiFor` in `src/lib/dex`, put Meteora's values on `meteoraDlmmDescriptor.ui`, put Raydium / RHC / Orca in the registry-local table, switch call sites to `uiFor`, delete `PROTOCOL_META` and `opensRhcDialog` from `CHAIN_META`. Keep `showHighestRange` and `nullFeeLabel` on `CHAIN_META`. Lower the table baseline (3 → 2 if only `PROTOCOL_META` leaves; `CHAIN_META` was never in the count). Lower the architecture-dex **branch** baseline if `opensRhcDialog` / `opensNativeModal` comparisons disappear from components — that drop is allowed in this phase, and only by moving into the registry, not by adding a new UI table outside `src/lib/dex`. | The same handler-matrix test as E-dispatch (still green after the move). Plus: a snapshot or equality test that `uiFor("raydium-clmm")` / `"uniswap-v4-rhc"` / `"meteora-dlmm"` / `"orca-whirlpool"` / `"rhc-uniswap-v4"` equals the matrix in §2.2; `protocolMeta` gone; `chainMeta` still has `showHighestRange` / `nullFeeLabel` and no `opensRhcDialog`; `architecture-dex-tables` ratchet lowered in the same PR; existing Meteora registry contract suite untouched; `use-pool-sources` tests rewritten to assert `uiFor` for the moved fields and `chainMeta` for the two that stay. Read-only smokes after merge (if PM asks): `/app` 200; a Meteora read through the registry (no-wallet `POST /api/dex/meteora-dlmm/open-ranges` — `quote-open` requires `request.owner`, see the #371 smoke); `/app/meteora` still 404. No shots unless pixels change. |

Dependency: E-T before E-dispatch before E-move; each is approved on its own
head. E-move before any stub-or-real descriptor for Raydium / Orca / RHC.
E1–E3 stay blocked on their own design / PM review, not on E-move, but they
must not register a descriptor until E-dispatch is on `main`.

---

## 5. Flags for LJ (behavior or money paths)

Nothing in E-T, E-dispatch, or E-move should change what a user signs, what
they pay, the fee wallet, minOut, or transaction order. If an implementation
PR would do any of the following, stop and flag it — do not fold it into a
"just moving tables" PR. Several of these are also PM agreements (§0).

1. **Registering a `DexDescriptor` for Raydium, Orca, or RHC before that
   venue's E1–E3 series** (PM: no stub descriptors). Today, descriptor
   presence reroutes open (including deep links) into the registry dialog
   (`unified-pools-panel.tsx:144–149, 162–163`) and switches Plan / share-calc
   off `LEGACY_*` terms (`lp-plan-pool-terms.ts:138–161`). A stub descriptor
   with `capabilities.open: SUPPORTED` would attempt a registry open that has
   no adapter. A stub with `open` unsupported would **hide** today's native /
   RHC open button. Either is a behavior change; the unsupported case is a
   product regression, the supported case can break or mis-route a money path.

2. **Inventing a `feePolicy` (or `planLpFeeShare`, rent, `withdrawOutputs`)
   on a stub descriptor** (PM: no invented `feePolicy`). `DexMeta.feePolicy`
   is the reviewable rate table (`types.ts:42–56, 98`). Meteora's rates live
   only on its descriptor (`meteora-dlmm/descriptor.ts:13–18, 50`). A
   placeholder policy would be picked up by `planPoolTerms` /
   `descriptorCost` / `descriptorExitCost` and would change the numbers shown
   for opening cost, LP fee share, and exit cost — planning copy that
   describes fees. Out of scope for E-move.

3. **Flipping `useDescriptorPlanTerms` away from today** (Meteora `true`,
   every other protocol `false`; PM) or deleting the `descriptor == null`
   legacy branch without an equivalent guard. That changes day-0 opening cost
   from the current "about 1%" assumption (`lp-plan-pool-terms.ts:13–14,
   54–64`) to swap-cost-plus-platform-fee and may change which exits are
   offered. Treat as an intended product change in E3 (Raydium) or E2 (RHC),
   with snapshots and an explicit LJ/PM note — not as a side effect of moving
   UI flags.

4. **Changing `openUi` for a live venue** (PM: call-for-call equivalent —
   Raydium `native-modal`, RHC `rhc-dialog`, Meteora `registry`, Orca
   `none`). Moving RHC from "chain flag inside `openPool`" to
   `openUi: "rhc-dialog"` must be call-for-call equivalent. Sending Raydium or
   RHC through `setRegistryOpen` is a money-path routing change.

5. **Moving `showHighestRange` or `nullFeeLabel` onto `DexUi` or a
   per-protocol table.** That is the design change PM rejected: a future
   Solana DEX would silently default to `showHighestRange: false` and hide
   the row. These stay on `CHAIN_META`.

6. **Changing Meteora (or any venue) fee bps, fee-wallet guards, signing
   order, or minOut.** E-move must not edit `meta.feePolicy`,
   `assertMeteoraFeeRule`, or adapter builders. Compound remains a no-platform-fee
   path on Meteora (`descriptor.ts:17` comment, PR8).

7. **Enabling production discovery or tx-build flags, or editing Vercel
   env.** `METEORA_DLMM_DISCOVERY_ENABLED.production` is `false`
   (`src/lib/protocol-flags.ts`, production 404 on
   `GET /api/protocol-pools?protocol=meteora-dlmm`). D6 left those flags and
   the env vars untouched. E-discovery is skipped for now.

8. **`useLatest` on a tx / money callback.** Not required for this series.
   If a later E2/E3 hook change would introduce it, flag it (standing PM rule).

9. **`#364`** (ScaledUiAmount / token-safety / selected-state / spot-swap /
   wallet-discovery, held for LJ). Do not touch those files in any Phase E PR.

Items 1–4 are the reason E-dispatch exists as its own PR: after it lands,
registering a descriptor is no longer silently load-bearing, but
`useDescriptorPlanTerms` and `openUi` still have to be set deliberately.

---

## 6. Out of scope

- Implementing E1 (Orca), E2 (RHC Uniswap v4), or E3 (Raydium CLMM).
- Retiring `LEGACY_DEX_ID_ALIASES` / `"rhc-uniswap-v4"` (TODO(PR11),
  `types.ts:23–24`) — belongs with E2.
- E-labels and E-discovery (skipped for now).
- Production flag flips, preview deploys, CLI redeploys, real-money tests.
- Editing `#364`.
- Dropping architecture-dex branches by adding more UI lookup tables outside
  `src/lib/dex`.
- Moving `showHighestRange` or `nullFeeLabel` off `CHAIN_META`.
