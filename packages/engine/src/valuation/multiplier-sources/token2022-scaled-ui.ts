import { getScaledUiAmountConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { multiplierAt } from "../multiplier";
import type { MultiplierEvidence, MultiplierHint, ResolveContext, ScaledUiMultiplierConfig } from "../types";
import type { MultiplierSource } from "./types";

type ConfigHint = Extract<MultiplierHint, { kind: "scaled-ui-config" }>;

const effective = (config: ScaledUiMultiplierConfig | null, nowMs: number): number | null =>
  multiplierAt(config ? { kind: "scaled-ui", config } : { kind: "none" }, nowMs);

const evidenceOf = (hint: ConfigHint, nowMs: number): MultiplierEvidence =>
  ({ origin: hint.origin, observedAtMs: hint.observedAtMs, multiplier: effective(hint.config, nowMs) });

const sameMultiplier = (a: number | null, b: number | null): boolean =>
  a !== null && b !== null && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));

/** Warn about every other config whose effective multiplier at `nowMs` differs from the chosen one. */
function warnConflicts(asset: string, chosen: MultiplierEvidence, others: readonly ConfigHint[], context: ResolveContext): void {
  if (!context.warn) return;
  for (const other of others) {
    const ignored = evidenceOf(other, context.nowMs);
    if (!sameMultiplier(chosen.multiplier, ignored.multiplier)) context.warn({ kind: "multiplier-conflict", asset, chosen, ignored });
  }
}

/**
 * Solana Token-2022 ScaledUiAmount. A mint account read in this request wins: with no extension it answers null and
 * leaves the mint to `spl-plain`. Without one, the most recently observed config (snapshot or Jupiter) wins, so a
 * stale snapshot never overrides a newer issuer schedule. Any config that disagrees at evaluation time is reported.
 */
export const token2022ScaledUiSource: MultiplierSource = {
  id: "token2022-scaled-ui",
  read(ref, hints, context) {
    if (ref.chain !== "solana") return null;
    const asset = `${ref.chain}:${ref.address}`;
    const configs = hints.filter((hint): hint is ConfigHint => hint.kind === "scaled-ui-config");
    const mint = hints.find((hint) => hint.kind === "mint-extensions");
    if (mint) {
      const chosen: MultiplierEvidence = { origin: "mint-account", observedAtMs: null, multiplier: effective(mint.scaledUiConfig, context.nowMs) };
      warnConflicts(asset, chosen, configs, context);
      return mint.scaledUiConfig ? { kind: "scaled-ui", config: mint.scaledUiConfig } : null;
    }
    const newest = configs.reduce<ConfigHint | null>((best, hint) => !best || hint.observedAtMs > best.observedAtMs ? hint : best, null);
    if (!newest) return null;
    warnConflicts(asset, evidenceOf(newest, context.nowMs), configs.filter((hint) => hint !== newest), context);
    return { kind: "scaled-ui", config: newest.config };
  },
};

/** The extension config of an unpacked mint, as serializable numbers (timestamp in seconds). */
export function scaledUiConfigFromExtension(extension: {
  multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp: bigint | number;
} | null): ScaledUiMultiplierConfig | null {
  if (!extension) return null;
  return {
    multiplier: Number(extension.multiplier),
    newMultiplier: Number(extension.newMultiplier),
    newMultiplierEffectiveTimestamp: Number(extension.newMultiplierEffectiveTimestamp),
  };
}

/**
 * The multiplier hint of a mint account the caller already read in its own batch. No I/O. Null when the account is
 * missing, not a token mint, or does not decode (the asset then stays unknown, never 1).
 */
export function mintAccountHint(mint: string, info: AccountInfo<Buffer> | null | undefined): MultiplierHint | null {
  if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) return null;
  try {
    const unpacked = unpackMint(new PublicKey(mint), info, info.owner);
    return { kind: "mint-extensions", scaledUiConfig: scaledUiConfigFromExtension(getScaledUiAmountConfig(unpacked)) };
  } catch {
    return null;
  }
}
