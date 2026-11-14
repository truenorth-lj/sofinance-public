import { CANONICAL_SITE_URL, APP_ROUTES } from "@/lib/public-urls";
import { LATEST_PROTOCOL_VERSION, SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS, serverInstructions } from "./protocol";
import { listToolDefinitions, PUBLIC_TOOL_NAMES } from "./tool-definitions";

const MCP_ENDPOINT = `${CANONICAL_SITE_URL}/api/mcp`;
const SERVER_DESCRIPTION =
  "Same-stock liquidity pools of tokenized stocks on Solana: list pools and 7-day range APR estimates, quote, and prepare unsigned transactions your wallet signs.";

/**
 * `/.well-known/mcp/server-card.json`: lets directories describe the server without a live scan. Tools come from the
 * same definitions `tools/list` serves, so the card cannot drift from the server.
 */
export function buildServerCard() {
  return {
    serverInfo: { ...SERVER_INFO },
    description: SERVER_DESCRIPTION,
    websiteUrl: CANONICAL_SITE_URL,
    documentationUrl: `${CANONICAL_SITE_URL}${APP_ROUTES.ai}`,
    iconUrl: `${CANONICAL_SITE_URL}/icon-512.png`,
    protocolVersion: LATEST_PROTOCOL_VERSION,
    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    transport: { type: "streamable-http", endpoint: MCP_ENDPOINT },
    capabilities: { tools: {} },
    authentication: {
      // Not required for the public read-only tools; every wallet-bound tool needs the bearer token.
      required: false,
      schemes: ["bearer"],
      publicTools: [...PUBLIC_TOOL_NAMES],
      setupUrl: `${CANONICAL_SITE_URL}${APP_ROUTES.ai}`,
    },
    instructions: serverInstructions(),
    tools: listToolDefinitions("http"),
    resources: [],
    prompts: [],
  };
}
