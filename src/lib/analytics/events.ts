export const GROWTH_EVENTS = {
  rwaPairsView: "rwa_pairs_view",
  walletConnectClicked: "wallet_connect_clicked",
  walletConnectStarted: "wallet_connect_started",
  walletConnected: "wallet_connected",
  walletConnectFailed: "wallet_connect_failed",
  walletConnectAbandoned: "wallet_connect_abandoned",
  walletDeeplinkClicked: "wallet_deeplink_clicked",
  performanceView: "performance_view",
  openStarted: "open_position_started",
  openSuccess: "open_position_success",
  openFailed: "open_position_failed",
} as const;

export type GrowthEventName = (typeof GROWTH_EVENTS)[keyof typeof GROWTH_EVENTS];

export type OpenEventProperties = {
  /** Surface that broadcast the open. Web routes are `web`; /api/mcp sends `mcp` server-side (src/mcp/analytics.ts). */
  source: "web";
  /** Web open started from an MCP agent's sign link (`/app/sign/<token>`): broadcast by the app, initiated by an agent. */
  mcp_sign_link?: boolean;
  pool?: string;
  pair?: string;
  wallet_address?: string;
  input_kind?: "native" | "token";
  /** Two-step SOL open only: which step failed (1 = SOL -> pool-token swap, 2 = token-input open). */
  open_step?: 1 | 2;
  /** Two-step SOL open only: true when step 2/2 resumed from a stored step-1 receipt ("Continue open (2/2)"). */
  open_resumed?: boolean;
};

export type OpenEventContext = {
  /** Connected wallet's public address (internal/test wallets are filtered in PostHog, not here). */
  wallet?: string | null;
  inputKind?: "native" | "token" | null;
  /** True on `/app/sign/<token>` (an MCP agent's sign link). */
  mcpSignLink?: boolean;
};

export function openEventProperties(pair: {
  poolAddress: string;
  symbolA: string;
  symbolB: string;
} | null | undefined, context: OpenEventContext = {}): OpenEventProperties {
  const properties: OpenEventProperties = { source: "web" };
  if (context.wallet) properties.wallet_address = context.wallet;
  if (context.mcpSignLink) properties.mcp_sign_link = true;
  if (context.inputKind) properties.input_kind = context.inputKind;
  if (!pair) return properties;
  if (pair.poolAddress) properties.pool = pair.poolAddress;
  if (pair.symbolA && pair.symbolB) properties.pair = `${pair.symbolA}/${pair.symbolB}`;
  return properties;
}
