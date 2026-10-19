/**
 * Which requests the restricted-region gate applies to.
 *
 * Blocked from restricted regions: every API route that quotes, builds, prepares or broadcasts a
 * transaction that opens, adds to or compounds a position (i.e. new orders), and the /app UI.
 *
 * Never blocked (so existing depositors are not trapped):
 * - withdraw-quote / withdraw-prepare / withdraw-broadcast / withdraw-status (exit a position);
 * - compound-recover-* and compound-cleanup-* (return the wallet's own leftover balances and rent
 *   from earlier compounds to the wallet; they never add liquidity);
 * - read-only data and status/finality routes (wallet, positions, prices, APR history, tx status);
 * - /app/exit (exit-only UI) and /app/sign/<token> links whose token is a withdrawal;
 * - the landing page, /docs, /terms and the blocked page itself.
 */

export const REGION_BLOCKED_API_ROUTES = [
  "/api/open-quote",
  "/api/open-prepare",
  "/api/open-broadcast",
  "/api/selected-quote",
  "/api/selected-preflight",
  "/api/selected-prepare",
  "/api/selected-broadcast",
  "/api/compound-prepare",
  "/api/compound-broadcast",
] as const;

/** Exit routes kept open on purpose. Listed explicitly so tests pin the exception. */
export const REGION_EXEMPT_EXIT_API_ROUTES = [
  "/api/withdraw-quote",
  "/api/withdraw-prepare",
  "/api/withdraw-broadcast",
  "/api/withdraw-status",
  "/api/compound-recover-discover",
  "/api/compound-recover-import",
  "/api/compound-recover-prepare",
  "/api/compound-recover-broadcast",
  "/api/compound-cleanup-prepare",
  "/api/compound-cleanup-broadcast",
  "/api/compound-cleanup-confirm",
] as const;

/** MCP tools (POST /api/mcp tools/call) refused from restricted regions. Withdraw tools stay open. */
export const REGION_BLOCKED_MCP_TOOLS = [
  "quote_add_liquidity",
  "prepare_transaction",
  "submit_signed_transaction",
  "quote_compound",
  "prepare_compound_transaction",
  "submit_compound_transaction",
  "quote_open_position",
  "prepare_open_position",
  "submit_open_position",
] as const;

export const EXIT_APP_PATH = "/app/exit";
export const RESTRICTED_PAGE_PATH = "/restricted";

const stripTrailingSlash = (pathname: string) => pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

export function isRegionBlockedApi(pathname: string): boolean {
  const path = stripTrailingSlash(pathname);
  return (REGION_BLOCKED_API_ROUTES as readonly string[]).includes(path);
}

export function isRegionBlockedMcpTool(name: unknown): boolean {
  return typeof name === "string" && (REGION_BLOCKED_MCP_TOOLS as readonly string[]).includes(name);
}

export type AppPathDecision = "allow" | "block" | "sign-link";

/** Classify an /app page path. Non-/app paths are always allowed. */
export function classifyAppPath(pathname: string): AppPathDecision {
  const path = stripTrailingSlash(pathname);
  if (path !== "/app" && !path.startsWith("/app/")) return "allow";
  if (path === EXIT_APP_PATH || path.startsWith(`${EXIT_APP_PATH}/`)) return "allow";
  if (path.startsWith("/app/sign/")) return "sign-link";
  return "block";
}
