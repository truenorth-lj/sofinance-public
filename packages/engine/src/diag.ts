// THROWAWAY DIAGNOSTIC (diag/phantom-sol-bisect) — DO NOT MERGE.
// Variants are selected per request by the host (non-production only) via
// `runWithOpenDiag` in diag-store.ts. This module has no Node imports so it
// is safe to reach from shared code.
export const OPEN_DIAG_VARIANTS = ["v0", "v1", "v2", "v3", "v3b", "v4", "s1"] as const;
export type OpenDiagVariant = (typeof OPEN_DIAG_VARIANTS)[number];

type DiagStore = { getStore(): OpenDiagVariant | undefined };
const holder = globalThis as { __sofiOpenDiagStore?: DiagStore };

export function openDiag(): OpenDiagVariant | undefined {
  return holder.__sofiOpenDiagStore?.getStore();
}
/** Every variant except the control drops the protocol fee. */
export const diagNoFee = () => { const v = openDiag(); return Boolean(v && v !== "v0"); };
/** v2: let Jupiter wrap/unwrap native SOL itself. */
export const diagJupiterWrap = () => openDiag() === "v2";
/** v3 / v3b: force a one-sided range so only a single swap leg is built. */
export const diagSingleSide = (): "above" | "below" | null =>
  openDiag() === "v3" ? "above" : openDiag() === "v3b" ? "below" : null;
/** v4: wrap + first Jupiter leg + close only, no Raydium open. */
export const diagSwapOnly = () => openDiag() === "v4";

export function parseOpenDiag(value: unknown, vercelEnv: string | undefined): OpenDiagVariant | undefined {
  // Hard guard: never honored on production.
  if (vercelEnv === "production") return undefined;
  return typeof value === "string" && (OPEN_DIAG_VARIANTS as readonly string[]).includes(value)
    ? value as OpenDiagVariant : undefined;
}
