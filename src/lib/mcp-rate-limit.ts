import { clientIp } from "@/lib/request-origin/client-ip";
import { slidingWindowLimiter } from "@/lib/tx-send/rate-limit";

/**
 * Per-IP limits for `POST /api/mcp`. Same in-memory sliding-minute limiter as `/api/tx-send` and the DEX routes:
 * no paid service, no platform setting.
 *
 * - Every request (initialize, tools/list, ping, tools/call…): MCP_REQUESTS_PER_IP_PER_MINUTE. Cheap, so loose; a
 *   brake on a client looping on discovery.
 * - Every tools/call: MCP_TOOL_CALLS_PER_IP_PER_MINUTE. Snapshot reads, tx_status (one status RPC; polling every 2 s
 *   is 30/min), quotes, prepares and submits.
 * - Position reads (`position-read` tools: positions_list, position_get_range_status, position_get_performance) also:
 *   MCP_POSITION_READS_PER_IP_PER_MINUTE, the same budget as the site's `/api/dex/*` positions reads. They are the
 *   costly RPC reads (account scans, signature history) and need no token, so anyone can ask.
 * A request refused by an earlier limit is not counted against a later one.
 *
 * Limits of this design (as in `dex-route-rate-limit.ts`): per server instance, not global (N warm instances allow up to
 * N times the limit; a cold start forgets the counts); keyed by `x-real-ip`, then the first `x-forwarded-for`; at most
 * 5,000 keys per limiter. A cheap brake on one client hammering, not a quota.
 */
export const MCP_REQUESTS_PER_IP_PER_MINUTE = 120;
export const MCP_TOOL_CALLS_PER_IP_PER_MINUTE = 60;
export const MCP_POSITION_READS_PER_IP_PER_MINUTE = 12;
export const MCP_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

export type McpRateScope = "requests" | "tool-calls" | "position-reads";
export type McpRateLimitHit = { scope: McpRateScope; limitPerMinute: number };

const requests = slidingWindowLimiter(MCP_REQUESTS_PER_IP_PER_MINUTE);
const toolCalls = slidingWindowLimiter(MCP_TOOL_CALLS_PER_IP_PER_MINUTE);
const positionReads = slidingWindowLimiter(MCP_POSITION_READS_PER_IP_PER_MINUTE);

/** The limit this request is over, or null. `call` is set for tools/call; `positionRead` for a position-read tool. */
export function mcpRateLimited(request: Request, call: { positionRead: boolean } | null, now = Date.now()): McpRateLimitHit | null {
  const ip = clientIp(request);
  if (requests.limited(ip, now)) return { scope: "requests", limitPerMinute: MCP_REQUESTS_PER_IP_PER_MINUTE };
  if (!call) return null;
  if (toolCalls.limited(ip, now)) return { scope: "tool-calls", limitPerMinute: MCP_TOOL_CALLS_PER_IP_PER_MINUTE };
  if (call.positionRead && positionReads.limited(ip, now)) {
    return { scope: "position-reads", limitPerMinute: MCP_POSITION_READS_PER_IP_PER_MINUTE };
  }
  return null;
}

/** Test hook. */
export function resetMcpRateLimit() { requests.reset(); toolCalls.reset(); positionReads.reset(); }
