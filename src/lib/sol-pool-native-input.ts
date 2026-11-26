import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { allowlistedPoolById } from "@/lib/rwa-allowlist";

/** User-facing note when native SOL is refused because the pool already holds wrapped SOL. */
export const SOL_POOL_NATIVE_INPUT_MESSAGE =
  "SOL can't be used to open this pool yet. Use hSOL, USDC, or wrapped SOL already in your wallet.";

export class SolPoolNativeInputError extends Error {
  readonly code = "sol_pool_native_input";
  constructor() {
    super(SOL_POOL_NATIVE_INPUT_MESSAGE);
    this.name = "SolPoolNativeInputError";
  }
}

/** True when either pool mint is wrapped SOL (the native SOL mint). */
export function poolHoldsWrappedSol(pool: { mintA: string; mintB: string }): boolean {
  return pool.mintA === NATIVE_SOL_MINT || pool.mintB === NATIVE_SOL_MINT;
}

/** True when this input is native SOL and the pool already holds wrapped SOL. */
export function isNativeSolDisabledForPool(kind: "native" | "token", pool: { mintA: string; mintB: string }): boolean {
  return kind === "native" && poolHoldsWrappedSol(pool);
}

/** Marks native SOL ineligible on pools that already hold wrapped SOL; token wSOL is left alone. */
export function applySolPoolNativeInputPolicy<T extends { kind: "native" | "token"; eligible: boolean; reason: string | null }>(
  assets: T[],
  pool: { mintA: string; mintB: string },
): T[] {
  if (!poolHoldsWrappedSol(pool)) return assets;
  return assets.map((asset) => asset.kind === "native"
    ? { ...asset, eligible: false, reason: SOL_POOL_NATIVE_INPUT_MESSAGE }
    : asset);
}

/** Throws when a native-SOL open is requested for a pool that already holds wrapped SOL. */
export function assertNativeSolAllowedForPool(
  selection: { inputKind: "native" | "token" },
  pool: { mintA: string; mintB: string },
): void {
  if (isNativeSolDisabledForPool(selection.inputKind, pool)) throw new SolPoolNativeInputError();
}

/**
 * Same guard, keyed by pool id. Uses the curated allowlist so quote and prepare can
 * reject before any quote or swap is built. Unknown pools fall through (the engine
 * sol-swap-step guard still applies at step 1).
 */
export function assertNativeSolAllowedForPoolId(selection: { inputKind: "native" | "token"; poolId: string }): void {
  if (selection.inputKind !== "native") return;
  const known = allowlistedPoolById(selection.poolId);
  if (known) assertNativeSolAllowedForPool(selection, known);
}
