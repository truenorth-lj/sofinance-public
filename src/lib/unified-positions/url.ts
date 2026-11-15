import { parsePositionKey } from "./model";

type Query = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";

/**
 * Portfolio has one page (LJ 11/14): every operation is a row popup and a position's Performance is a popup opened from
 * its row. Old `view=compound`, `view=deposit` / `add`, `view=withdraw` links land on Portfolio (nothing opens or runs);
 * `view=performance` (also /app/position-performance) opens the linked position's Performance detail.
 */
export type PortfolioView = "portfolio" | "performance";

/**
 * `/app` selection from the URL: `?position=<source>:<id>&view=performance` (unified positions). A valid `?position=` key is
 * passed through as is, whatever its source (the panel maps its own inline source's key to that source's selection). Old
 * `?mint=` / `?positionMint=` links still select a Solana (Raydium) position; a valid `?position=` wins over them.
 */
export function initialSelectionFromQuery(query: Query): { initialView: PortfolioView; initialMint: string; initialPositionKey: string } {
  const position = parsePositionKey(first(query.position));
  return {
    initialView: first(query.view) === "performance" ? "performance" : "portfolio",
    initialMint: position ? "" : first(query.mint) || first(query.positionMint),
    initialPositionKey: position ? first(query.position) : "",
  };
}
