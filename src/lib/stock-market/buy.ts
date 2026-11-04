/**
 * Which stock rows get a Buy button, and the allowlist the spot-swap engine buys from (PR B, PM rules):
 *   - candidates are the row's tokens that passed the card filters (`build.ts`), matched by exact mint;
 *   - each candidate's mint is read on-chain once; any `spotSwapMintIssues` (paused, transfer fee, frozen default,
 *     active hook, ScaledUiAmount multiplier not 1, unsupported extension) drops it, so a multiplier != 1 token
 *     never gets a Buy;
 *   - non-xStocks issuers carry Jupiter's metadata (name + tags) so the engine can require "verified" + a name;
 *   - the engine's `selectSpotSwapToken` picks the issuer (xStocks first, then the next with a 1 USDC route at
 *     <= 1% price impact). `no_route` -> no Buy.
 * Pure apart from the injected chain read and route check.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { selectSpotSwapToken, spotSwapMintIssues, type SpotSwapRouteCheck, type SpotSwapToken } from "@sofinance/engine/spot-swap";
import type { StockMarket, StockToken } from "./build";

/** A token the engine may buy for this stock (passed the filters and the mint checks). */
export type StockBuyCandidate = {
  mint: string; symbol: string; underlying: string; xstocks: boolean;
  jupiter: { name: string | null; tags: string[] };
  decimals: number; program: string;
};

/** What a row's Buy button buys by default (the engine's selection for a 1 USDC probe). */
/** One displayed stock and its candidate issuer tokens (exact mints), as the spot-swap routes need it. */
export type SpotSwapStockContext = { underlying: string; candidates: StockBuyCandidate[] };

export type StockBuyOption = { underlying: string; company: string; mint: string; mintShort: string; issuerName: string; symbol: string };

export type StockBuyEligibility = {
  checkedAt: string;
  options: Record<string, StockBuyOption>;
  candidates: Record<string, StockBuyCandidate[]>;
};

export type ReadMintAccounts = (mints: string[]) => Promise<(AccountInfo<Buffer> | null)[]>;
export type CheckRoute = (mint: string, usdcRaw: bigint) => Promise<SpotSwapRouteCheck>;

/** Engine allowlist for one stock, in candidate order (xStocks first). */
export function spotSwapAllowlistFor(candidates: readonly StockBuyCandidate[]): SpotSwapToken[] {
  return candidates.map((candidate) => ({
    mint: candidate.mint, symbol: candidate.symbol, underlying: candidate.underlying, xstocks: candidate.xstocks,
    jupiter: { name: candidate.jupiter.name, tags: candidate.jupiter.tags },
  }));
}

function candidateFor(token: StockToken, info: AccountInfo<Buffer> | null): StockBuyCandidate | null {
  try {
    const mint = spotSwapMintIssues(new PublicKey(token.mint), info);
    if (mint.issues.length) return null;
    return { mint: token.mint, symbol: token.symbol, underlying: token.underlying, xstocks: token.xstocks,
      jupiter: { name: token.jupiterName, tags: token.jupiterTags }, decimals: mint.decimals, program: mint.program.toBase58() };
  } catch {
    return null; // not an SPL / Token-2022 mint: never buyable
  }
}

/**
 * Eligibility for the given stocks. `isUnavailable` decides whether a route-check failure is an outage (rethrown, so
 * an outage is never cached as "not buyable") or a per-token refusal (that stock gets no Buy).
 */
export async function computeStockBuyEligibility(market: Pick<StockMarket, "tokensByUnderlying">, underlyings: readonly string[], deps: {
  readMints: ReadMintAccounts; checkRoute: CheckRoute; isUnavailable: (error: unknown) => boolean; now?: Date;
}): Promise<StockBuyEligibility> {
  const tokens = underlyings.flatMap((underlying) => market.tokensByUnderlying[underlying] ?? []);
  const infos = new Map<string, AccountInfo<Buffer> | null>();
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100).map((token) => token.mint);
    const values = await deps.readMints(batch);
    batch.forEach((mint, index) => infos.set(mint, values[index] ?? null));
  }
  const options: Record<string, StockBuyOption> = {};
  const candidates: Record<string, StockBuyCandidate[]> = {};
  for (const underlying of underlyings) {
    const list = (market.tokensByUnderlying[underlying] ?? [])
      .map((token) => candidateFor(token, infos.get(token.mint) ?? null))
      .filter((candidate): candidate is StockBuyCandidate => candidate !== null);
    if (!list.length) continue;
    candidates[underlying] = list;
    try {
      const selection = await selectSpotSwapToken(spotSwapAllowlistFor(list), underlying, { checkRoute: deps.checkRoute });
      if (selection.status !== "selected") continue;
      const company = market.tokensByUnderlying[underlying]?.find((token) => token.mint === selection.mint)?.company ?? underlying;
      options[underlying] = { underlying, company, mint: selection.mint, mintShort: selection.mintShort,
        issuerName: selection.issuerName, symbol: selection.token.symbol };
    } catch (error) {
      if (deps.isUnavailable(error)) throw error;
    }
  }
  return { checkedAt: (deps.now ?? new Date()).toISOString(), options, candidates };
}
