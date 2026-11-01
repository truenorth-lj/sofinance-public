import type { ComponentType } from "react";
import type { ActionOption } from "@/components/action-selector";
import { TOOL_IDS, type SourceCapabilities, type ToolId } from "./model";

export type ToolMeta = { label: string; icon: ComponentType<{ className?: string }>; controls: string };

/**
 * Tool tabs from a position's capabilities, in the fixed order. An unsupported tool stays visible and clickable, greyed
 * (`unavailable`); the panel then shows its reason inline. `extraDisabled` carries the existing UI guards (e.g. Withdraw while busy).
 */
export function toolOptions(capabilities: SourceCapabilities, meta: Readonly<Record<ToolId, ToolMeta>>,
  extraDisabled: Partial<Record<ToolId, boolean>> = {}): ActionOption<ToolId>[] {
  return TOOL_IDS.map((tool) => {
    const option: ActionOption<ToolId> = { value: tool, ...meta[tool] };
    if (!capabilities[tool].supported) option.unavailable = true;
    else if (tool in extraDisabled) option.disabled = Boolean(extraDisabled[tool]);
    return option;
  });
}
