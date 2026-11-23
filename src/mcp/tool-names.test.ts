import { describe, expect, it } from "vitest";
import { listToolDefinitions, TOOL_ALIASES } from "./tool-definitions";
import { HTTP_TOOL_NAMES, MCP_TOOL_COUNT } from "./tool-names";

describe("client-side tool names", () => {
  it("equal the names tools/list serves, in order (17 tools)", () => {
    expect([...HTTP_TOOL_NAMES]).toEqual(listToolDefinitions("http").map((tool) => tool.name));
    expect(new Set(listToolDefinitions("stdio").map((tool) => tool.name))).toEqual(new Set(HTTP_TOOL_NAMES));
    expect(MCP_TOOL_COUNT).toBe(17);
  });

  it("every tool has a non-empty title; aliases are hidden and point at a listed tool", () => {
    for (const tool of listToolDefinitions("http")) expect(tool.title, tool.name).toMatch(/^\S.{2,40}$/);
    for (const [alias, tool] of Object.entries(TOOL_ALIASES)) {
      expect(HTTP_TOOL_NAMES, alias).not.toContain(alias);
      expect(HTTP_TOOL_NAMES, alias).toContain(tool);
    }
    expect(Object.keys(TOOL_ALIASES)).toHaveLength(16);
  });
});
