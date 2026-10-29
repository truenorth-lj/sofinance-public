// Deployment gating for MCP tools. Kept out of tool-definitions.ts, which must stay free of
// runtime imports (pure discovery metadata).
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isPoolActivityEnabled, POOL_ACTIVITY_DISABLED_MESSAGE, type DeployTarget } from "../lib/protocol-flags";
import { listToolDefinitions, type McpSurface, type ToolName } from "./tool-definitions";

/** Tools behind a code-constant flag in protocol-flags.ts. Everything else is always on. */
export function isToolEnabled(name: ToolName, target?: DeployTarget): boolean {
  if (name === "get_pool_activity") return isPoolActivityEnabled(target);
  return true;
}

/** Clear, non-secret refusal for a direct call to a tool that is hidden on this deployment. */
export function disabledToolMessage(name: ToolName): string {
  return name === "get_pool_activity" ? POOL_ACTIVITY_DISABLED_MESSAGE : `${name} is disabled on this deployment.`;
}

/** tools/list for this deployment: the surface's definitions minus disabled tools, order unchanged. */
export function listEnabledToolDefinitions(surface: McpSurface, target?: DeployTarget): Tool[] {
  return listToolDefinitions(surface).filter(tool => isToolEnabled(tool.name as ToolName, target));
}
