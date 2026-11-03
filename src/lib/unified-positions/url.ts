import { parsePositionKey, type ToolId } from "./model";

type Query = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
const VIEWS: readonly ToolId[] = ["compound", "performance", "deposit", "withdraw"];

/**
 * `/app` selection from the URL: `?position=<source>:<id>&view=<tool>` (unified positions). A valid `?position=` key is
 * passed through as is, whatever its source (the panel maps its own inline source's key to that source's selection). Old
 * `?mint=` / `?positionMint=` links still select a Solana (Raydium) position; a valid `?position=` wins over them.
 */
export function initialSelectionFromQuery(query: Query): { initialView: ToolId; initialMint: string; initialPositionKey: string } {
  const view = first(query.view) as ToolId;
  const position = parsePositionKey(first(query.position));
  return {
    initialView: VIEWS.includes(view) ? view : "compound",
    initialMint: position ? "" : first(query.mint) || first(query.positionMint),
    initialPositionKey: position ? first(query.position) : "",
  };
}
