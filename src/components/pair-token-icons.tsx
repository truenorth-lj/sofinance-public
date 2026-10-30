"use client";

import type { TokenMetadata } from "@sofinance/engine/token-metadata";
import { cn } from "@/lib/cn";
import { TokenIcon } from "./token-icon";

/** Fallback icon when Jupiter lists none: Raydium serves every listed mint's icon at this path. */
export const raydiumIcon = (mint: string) => `https://img-v1.raydium.io/icon/${mint}.png`;

export type PairTokenIconsPair = {
  mintA: string;
  mintB: string;
  symbolA: string;
  wrappedSymbol: string;
  plainSymbol: string;
};

/**
 * The overlapping xStock / plain-stock logo pair shown on the /app/rwa-pairs cards and the homepage pool list:
 * wrapped token first, icons from `/api/token-metadata` (`useTokenMetadata`), Raydium's icon path as fallback.
 */
export function PairTokenIcons({
  pair, tokens, ringClassName = "ring-cream", iconClassName,
}: {
  pair: PairTokenIconsPair;
  tokens: Record<string, TokenMetadata>;
  /** Ring colour separating the overlapping icons; match the surface they sit on. */
  ringClassName?: string;
  /** Size override for each icon (default h-11 w-11). */
  iconClassName?: string;
}) {
  const wrappedIsA = pair.symbolA === pair.wrappedSymbol;
  const mints = wrappedIsA ? [pair.mintA, pair.mintB] : [pair.mintB, pair.mintA];
  const symbols = [pair.wrappedSymbol, pair.plainSymbol];
  return (
    <span className="flex shrink-0 -space-x-3" aria-hidden="true">
      {mints.map((mint, index) => (
        <span key={`${mint}-${index}`} className={cn("rounded-full bg-ink ring-2", ringClassName)}>
          <TokenIcon symbol={symbols[index]!} icon={tokens[mint]?.icon ?? raydiumIcon(mint)} className={iconClassName} />
        </span>
      ))}
    </span>
  );
}
