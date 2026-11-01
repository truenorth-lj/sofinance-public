import type { RhcPositionValueRow } from "@sofinance/engine/protocols/uniswap-v4/position-value";

export type { RhcPositionValueRow };
const CHUNK = 10;

/**
 * Liquidity amounts, unclaimed fees and token USD prices per Robinhood Chain position NFT id (read-only server read on
 * the public RPC). Ids whose read failed are simply absent, so the detail panel shows a dash for them.
 */
export async function fetchPositionValues(ids: readonly string[]): Promise<Map<string, RhcPositionValueRow>> {
  const out = new Map<string, RhcPositionValueRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    try {
      const response = await fetch(`/api/rhc-univ4-position-values?ids=${ids.slice(i, i + CHUNK).join(",")}`, { cache: "no-store" });
      const json = await response.json().catch(() => null) as { state?: string; values?: RhcPositionValueRow[] } | null;
      if (response.ok && json?.state === "values" && Array.isArray(json.values)) for (const row of json.values) out.set(row.tokenId, row);
    } catch { /* a dash per field */ }
  }
  return out;
}
