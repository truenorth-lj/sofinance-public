import { SOL_INPUT_DISABLED_MESSAGE, SOL_INPUT_ENABLED } from "./feature-flags";

/** Error raised when a native-SOL open is requested while SOL input is disabled. */
export class SolInputDisabledError extends Error {
  readonly code = "sol_input_disabled";
  constructor() {
    super(SOL_INPUT_DISABLED_MESSAGE);
    this.name = "SolInputDisabledError";
  }
}

/** Vercel preview deployments only (never production or local/CI) — see feature-flags.ts. */
export function solInputPreviewOverride(): boolean {
  return (process.env.NEXT_PUBLIC_SOFI_DEPLOY_ENV || process.env.VERCEL_ENV) === "preview";
}

export function solInputEnabled(): boolean {
  return SOL_INPUT_ENABLED || solInputPreviewOverride();
}

/** True when this input kind is native SOL and SOL input is switched off. */
export function isSolInputBlocked(kind: "native" | "token"): boolean {
  return !solInputEnabled() && kind === "native";
}

/** Marks native SOL as ineligible (with the user-facing note) while SOL input is off. */
export function applySolInputPolicy<T extends { kind: "native" | "token"; eligible: boolean; reason: string | null }>(
  assets: T[],
): T[] {
  if (solInputEnabled()) return assets;
  return assets.map((asset) => asset.kind === "native"
    ? { ...asset, eligible: false, reason: SOL_INPUT_DISABLED_MESSAGE }
    : asset);
}

/** Server-side guard for open quote/prepare: refuse native SOL input while it is off. */
export function assertSolInputAllowed(selection: { inputKind: "native" | "token" }): void {
  if (isSolInputBlocked(selection.inputKind)) throw new SolInputDisabledError();
}
