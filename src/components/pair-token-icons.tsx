"use client";

import { cn } from "@/lib/cn";
import { iconFor, type IconChain, type TokenIconMap } from "@/lib/token-icons/map";
import { TokenIcon } from "./token-icon";

/** Fallback icon for a Solana mint the database has no icon for: Raydium serves listed mints' icons at this path. */
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
 * wrapped token first. Icons are the links the daily refresh stored in the database (`tokenIcons` from
 * `/api/rwa-pairs`, no per-request Jupiter call); a Solana token without one uses Raydium's icon path, and any icon
 * that fails to load shows the letter avatar (`TokenIcon`).
 */
export function PairTokenIcons({
  pair, icons, chain = "solana", ringClassName = "ring-cream", iconClassName,
}: {
  pair: PairTokenIconsPair;
  icons: Partial<TokenIconMap> | null | undefined;
  chain?: IconChain;
  /** Ring colour separating the overlapping icons; match the surface they sit on. */
  ringClassName?: string;
  /** Size override for each icon (default h-11 w-11). */
  iconClassName?: string;
}) {
  const wrappedIsA = pair.symbolA === pair.wrappedSymbol;
  const mints = wrappedIsA ? [pair.mintA, pair.mintB] : [pair.mintB, pair.mintA];
  const symbols = [pair.wrappedSymbol, pair.plainSymbol];
  return (
    <span className="flex shrink-0 -space-x-3" aria-hidden="true" data-testid="pair-token-icons">
      {mints.map((mint, index) => (
        <span key={`${mint}-${index}`} className={cn("rounded-full bg-ink ring-2", ringClassName)}>
          <TokenIcon symbol={symbols[index]!} icon={iconFor(icons, chain, mint) ?? (chain === "solana" ? raydiumIcon(mint) : null)} className={iconClassName} />
        </span>
      ))}
    </span>
  );
}
