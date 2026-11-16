/** Compatibility readers for existing native position tools, separate from generic trading admission. */
import type { GetPositionPerformanceOptions, PositionPerformanceResult, NativePositionRangeFacts } from "@/lib/position-read-types";
import type { DexId } from "./types";
import type { NativeWalletListing } from "./wallet-read";
export type NativePositionSource = "orca" | "meteora" | "raydium";
export type PositionPerformanceCommand = { positionMint: string; wallet?: string; maxSignatures?: number; skipPricing?: boolean;
  refreshHistory?: boolean; historyAfterSignatures?: string[] };
export type PositionRangeCommand = { positionMint: string; wallet?: string; poolId?: string };
export type NativePositionReader = {
  source: NativePositionSource;
  listing?: NativeWalletListing;
  /** Existing native source precedence; unrelated to module/generic HTTP ordering. */
  order: number;
  protocol?: string;
  enabled: () => boolean;
  matches: (positionMint: string) => Promise<boolean>;
  performance: (positionMint: string, options: GetPositionPerformanceOptions) => Promise<PositionPerformanceResult | null>;
  range: (positionMint: string) => Promise<NativePositionRangeFacts | null>;
};
export type RegisteredPositionReader = NativePositionReader & { id: DexId };
