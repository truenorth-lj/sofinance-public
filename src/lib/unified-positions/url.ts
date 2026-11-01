import { parsePositionKey, type ToolId } from "./model";

type Query = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
const VIEWS: readonly ToolId[] = ["compound", "performance", "deposit", "withdraw"];

/**
 * `/app` selection from the URL: `?position=<source>:<id>&view=<tool>` (unified positions). Old `?mint=` / `?positionMint=`
 * links still select a Solana (Raydium) position; a valid `?position=` wins over them.
 */
export function initialSelectionFromQuery(query: Query): { initialView: ToolId; initialMint: string; initialPositionKey: string } {
  const view = first(query.view) as ToolId;
  const position = parsePositionKey(first(query.position));
  const raydium = position?.source === "raydium-clmm";
  return {
    initialView: VIEWS.includes(view) ? view : "compound",
    initialMint: raydium ? position.nativeId : position ? "" : first(query.mint) || first(query.positionMint),
    initialPositionKey: position && !raydium ? first(query.position) : "",
  };
}
