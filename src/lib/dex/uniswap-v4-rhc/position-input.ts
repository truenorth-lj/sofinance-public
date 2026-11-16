/** Native position query validation and public failure text; no RPC or cache dependencies. */
import { MAX_POSITION_VALUES } from "@sofinance/engine/protocols/uniswap-v4/position-value-limits";

/** Parses `ids=1,2,3` (decimal NFT ids, deduplicated, at most `MAX_POSITION_VALUES`); null when malformed or empty. */
export function parsePositionIds(raw: string | null): bigint[] | null {
  const parts = (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_POSITION_VALUES || parts.some(p => !/^[0-9]{1,30}$/.test(p))) return null;
  return [...new Set(parts.map(p => BigInt(p).toString()))].map(BigInt);
}

export const RHC_SCAN_FAILED_MESSAGE = "Couldn't check this wallet's Robinhood Chain positions right now. Positions saved in this browser and added by number are still shown.";
