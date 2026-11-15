// MCP server identity, protocol-version negotiation and auth guidance shared by the remote route, the stdio server
// and the server card. No runtime imports beyond plain data helpers.
import { APP_ROUTES, CANONICAL_SITE_URL, getPublicBaseUrl } from "@/lib/public-urls";
import { PUBLIC_TOOL_NAMES } from "./tool-definitions";

export const SERVER_INFO = {
  name: "sofinance-mcp-server",
  title: "SoFinance",
  version: "0.2.0",
} as const;

/**
 * Protocol revisions the remote server implements, newest first. Per the MCP lifecycle spec the server answers with
 * the client's requested version when it supports it, otherwise with its own latest; it never echoes a version it does
 * not implement. 2025-11-25 is not listed: this stateless JSON-only server does not implement that revision's
 * additions, so such clients are offered 2025-06-18 (which they also support) and can disconnect if they cannot use it.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function isSupportedProtocolVersion(value: unknown): value is (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] {
  return typeof value === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

export function negotiateProtocolVersion(requested: unknown): string {
  return isSupportedProtocolVersion(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/** Where a person mints the wallet-bound token (preview deployments point at themselves). */
export function mcpSetupUrl(): string {
  return `${getPublicBaseUrl() || CANONICAL_SITE_URL}${APP_ROUTES.ai}`;
}

export function authSteps(): string[] {
  return [
    `Open ${mcpSetupUrl()} in a browser and connect the Solana wallet the agent will act for.`,
    "Click \"Sign to get MCP config\" and approve the sign-in message in the wallet (no transaction, no fee).",
    "Add the config it shows to the MCP client: header Authorization: Bearer <token>.",
    "The token works only for that wallet's address and expires after 24 hours; repeat to renew.",
  ];
}

export function serverInstructions(): string {
  return [
    "SoFinance: same-stock liquidity pools of tokenized stocks on Solana (Raydium CLMM and Meteora DLMM).",
    `No token needed for ${PUBLIC_TOOL_NAMES.join(" and ")}: the listed pools and their 7-day range APR estimates from the site's saved snapshot.`,
    `Every other tool is bound to one wallet and needs Authorization: Bearer <token> from ${mcpSetupUrl()} (connect wallet, Sign to get MCP config; valid 24h).`,
    "Prepare tools return unsigned, simulated transactions and a sign link; nothing moves until the user's wallet signs.",
    "APR figures are estimates from past trading, not a promise of future fees.",
  ].join(" ");
}
