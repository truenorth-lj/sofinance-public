import { GROWTH_EVENTS } from "../lib/analytics/events";
import { walletDistinctId, type ServerEvent, type ServerEventProperties } from "../lib/analytics/server-capture";
import { resolveToolName } from "./dispatch";
import { toolAnnotations } from "./tool-definitions";

/**
 * MCP usage events (GTM metrics spec, mcp-gtm/06-metrics-spec.md):
 * - `mcp_tool_called`: one per parsed `tools/call` (success, error or rejected). Rate-limited (429) calls are not
 *   events, so abuse cannot inflate billed volume.
 * - `open_position_success` with `source: "mcp"`: only when `submit_open_position` succeeds on /api/mcp. Same
 *   event as the web open, so north-star still counts it; `source` splits it out.
 * Write-tool success (agent-managed wallets) is `mcp_tool_called` with `outcome: "success"` on a destructive tool,
 * not a separate event.
 *
 * Never in an event: arguments, tokens, permits, transactions, sign links, client IP, raw wallet addresses.
 * distinct_id is `wallet:<sha256>` of the token wallet (or the `wallet` argument), else a shared anonymous id.
 */

export const MCP_TOOL_CALLED = "mcp_tool_called";
export const MCP_ANONYMOUS_DISTINCT_ID = "mcp:anonymous";

export type McpCallOutcome = "success" | "error" | "rejected";
export type McpCallAuth = "none" | "bearer" | "invalid";

export type McpToolCallRecord = {
  calledName: unknown;
  outcome: McpCallOutcome;
  errorCode?: string;
  auth: McpCallAuth;
  protocol: string;
  httpStatus: number;
  durationMs: number;
  tokenWallet?: string;
  args?: unknown;
  result?: unknown;
  host?: string | null;
};

const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function publicId(value: unknown): string | undefined {
  return typeof value === "string" && BASE58_ID.test(value) ? value : undefined;
}

/** Stable code for a thrown tool error. Rejections are the caller's input, not our failure. */
export function classifyToolError(message: string): { outcome: McpCallOutcome; errorCode: string } {
  const rules: [RegExp, string][] = [
    [/^Invalid arguments/, "invalid_arguments"],
    [/^Unknown tool/, "unknown_tool"],
    [/^Token wallet mismatch/, "wallet_mismatch"],
    [/confirmHighImpact/i, "high_impact_unconfirmed"],
    [/permit|authorization/i, "permit_invalid"],
    [/signature is invalid|signature mismatch/i, "signature_invalid"],
    [/expired/i, "expired"],
  ];
  for (const [pattern, errorCode] of rules) if (pattern.test(message)) return { outcome: "rejected", errorCode };
  return { outcome: "error", errorCode: "tool_failed" };
}

export function mcpToolCallEvents(record: McpToolCallRecord): ServerEvent[] {
  const resolved = typeof record.calledName === "string" ? resolveToolName(record.calledName) : null;
  const tool = resolved?.tool ?? "unknown";
  const annotations = resolved ? toolAnnotations(resolved.tool) : undefined;
  const summary = field(record.args, "summary");
  const wallet = publicId(record.tokenWallet) ?? publicId(field(record.args, "wallet"));
  const distinctId = wallet ? walletDistinctId(wallet) : MCP_ANONYMOUS_DISTINCT_ID;
  const host = typeof record.host === "string" && HOST.test(record.host.toLowerCase()) ? record.host.toLowerCase() : undefined;
  const poolId = publicId(field(record.args, "poolId")) ?? publicId(field(summary, "poolId"));
  const positionMint = publicId(field(record.args, "positionMint")) ?? publicId(field(summary, "nftMint"))
    ?? publicId(field(record.result, "positionMint"));

  const properties: ServerEventProperties = {
    tool,
    alias_used: resolved?.aliasUsed ?? false,
    outcome: record.outcome,
    auth: record.auth,
    read_only: annotations?.readOnlyHint ?? false,
    destructive: annotations?.destructiveHint ?? false,
    protocol: record.protocol,
    duration_ms: Math.max(0, Math.round(record.durationMs)),
    http_status: record.httpStatus,
    wallet_known: wallet !== undefined,
    source: "mcp",
  };
  if (record.errorCode) properties.error_code = record.errorCode;
  if (poolId) properties.pool_id = poolId;
  if (positionMint) properties.position_mint = positionMint;
  if (host) properties.$host = host;

  const events: ServerEvent[] = [{ event: MCP_TOOL_CALLED, distinctId, properties }];

  const signature = field(record.result, "signature");
  const openedMint = publicId(field(record.result, "positionMint"));
  if (tool === "submit_open_position" && record.outcome === "success" && wallet && openedMint
    && typeof signature === "string" && SIGNATURE.test(signature)) {
    const opened: ServerEventProperties = { source: "mcp", position_mint: openedMint, signature };
    if (poolId) opened.pool = poolId;
    if (host) opened.$host = host;
    events.push({ event: GROWTH_EVENTS.openSuccess, distinctId, properties: opened });
  }
  return events;
}
