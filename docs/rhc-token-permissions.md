# Robinhood Chain stock tokens: transfer controls

What SoFinance checked about the two tokens in the Robinhood Chain SPCX / SPCXon Uniswap v4 pool, and how the app
uses it. This is the Robinhood Chain counterpart of the Solana Token-2022 *freeze authority* check: both chains show
the same **Freeze risk** chip when an issuer can stop or reverse transfers.

Recheck at any time (public RPC, read-only, no keys): `pnpm tsx scripts/rhc-token-permissions.ts`.
Reviewed constants: `RHC_TOKEN_CONTROLS` in `packages/engine/src/protocols/uniswap-v4/constants.ts`.

## How it was checked (2026-10-30)

1. Contract source: both tokens are **BeaconProxy** contracts with verified source on Blockscout
   (`robinhoodchain.blockscout.com/api/v2/smart-contracts/<address>`). The beacon's `implementation()` decides the
   code that runs every transfer, so the implementation address is part of the review.
2. Function-level reading of the verified implementation: which roles can pause, block, burn from a holder, or swap
   the code, and which checks run inside `transfer` / `transferFrom`.
3. Live state on the public RPC (`https://robinhood-rpc.publicnode.com`): beacon implementation, paused flags, and
   whether the Uniswap v4 PoolManager (`0x8366…0951`) is blocked or non-compliant.

## SPCX: Robinhood Stock (`0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`)

* Beacon / access-controlled registry `0xe10b6f6B275de231345c20D14Ab812db62151b00`, implementation
  `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`.
* **Pause:** `TOKEN_PAUSER_ROLE` pauses this token; the registry can also pause every Robinhood token at once.
* **Blocklist:** the registry's `BLOCKER_ROLE` can block an address; `transfer`, `transferFrom`, `approve` and
  `permit` check it.
* **Burn from any holder:** `ADMIN_BURNER_ROLE`.
* Also: mint / burn roles, multiplier and metadata roles.
* **Upgradeable:** `BEACON_UPGRADER_ROLE` can point the beacon at new code.
* Live: `paused()` false, registry `paused()` false, `isBlocked(PoolManager)` false; implementation matches.

## SPCXon: Ondo GMToken (`0x9B8294F24453379aa87C807ab82bf1d5722153Fc`)

* Beacon `0xC6fBC077d53d01f73e3195B2b916fD95555bA222`, implementation `0xf74a964355485aE20457601b554754311c14233F`.
* **Pause:** `tokenPauseManager()` = `0x2C81cFDFFb8D17d24BCc78a9a542891331a48184`, checked on every transfer
  (`isTokenPaused(token)`).
* **Blocklist / compliance:** compliance contract `0x57DF1e146c08F88E2f1DF1b4df03f0DD45181327` checks sender, from
  and to on every transfer.
* **Burn from any holder:** `BURNER_ROLE` `burn(from)`.
* `CONFIGURER_ROLE` can replace the compliance and pause contracts.
* **Upgradeable:** beacon owner can swap the code.
* Live: `isTokenPaused` false, `checkIsCompliant(PoolManager)` passes; implementation and pause manager match.

## How the app uses it

* Pool discovery reads, in the same multicall as the pool state: each beacon's `implementation()`, SPCX `paused()`
  and the registry `paused()`, SPCXon `tokenPauseManager()` and `isTokenPaused(SPCXon)`. No extra RPC round trips.
* **Freeze risk** chip: shown when a token has any reviewed power above (both do today), and also, fail-closed, when
  the controls could not be read or the implementation is not the reviewed one.
* A paused token or an unreviewed implementation adds a plain-words pool warning ("SPCX transfers are paused by its
  issuer right now", "…token contract could not be confirmed as the reviewed version"). The pool is not delisted.
* Every Robinhood Chain pool also carries the neutral **New chain** label; it never shows "No flags".
* Liquidity: same TVL handling as other chains (there is no hard-coded "thin" label).
* The transaction-time path (`readOpenContext`) does not re-read these controls; the open simulation would fail on a
  paused or blocked transfer anyway.

The tokens' powers can change with a beacon upgrade. When the script reports a different implementation, re-review
the new verified source before updating `RHC_TOKEN_CONTROLS`.
