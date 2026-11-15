import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listToolDefinitions } from "./tool-definitions";

describe("MCP discovery metadata", () => {
  it("has one definition for each tool on both transports", () => {
    for (const surface of ["http", "stdio"] as const) {
      const tools = listToolDefinitions(surface);
      expect(tools).toHaveLength(16);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(16);
      expect(tools.slice(0, 2).map(tool => tool.name)).toEqual(["prepare_withdraw", "submit_withdraw"]);
      expect(tools.every(tool => tool.inputSchema.type === "object")).toBe(true);
    }
  });

  it("does not let a consumer mutate shared schemas or the other transport", () => {
    const baseline = listToolDefinitions("http");
    const first = listToolDefinitions("http");
    first[0]!.description = "changed by consumer";
    first[0]!.inputSchema.required!.push("unexpected");
    first.reverse();
    expect(listToolDefinitions("http")).toEqual(baseline);
    expect(listToolDefinitions("stdio")[0]).toEqual(baseline[0]);
  });
});

// Discovery must not load handlers, host configuration or provider clients.
// Type-only SDK imports are erased; all runtime module edges are forbidden.
function runtimeModuleEdges(text: string): string[] {
  const file = ts.createSourceFile("metadata.ts", text, ts.ScriptTarget.Latest, true);
  const edges: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) edges.push(node.getText(file));
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) edges.push(node.getText(file));
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) edges.push(node.getText(file));
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) edges.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return edges;
}

describe("metadata dependency boundary", () => {
  it("keeps the actual module free of runtime imports", () => {
    expect(runtimeModuleEdges(readFileSync(new URL("./tool-definitions.ts", import.meta.url), "utf8"))).toEqual([]);
  });

  it.each([
    'import "./tools";',
    'export { handler } from "./tools";',
    'import tools = require("./tools");',
    'const tools = import("./tools");',
    'const tools = require("./tools");',
  ])("rejects a runtime dependency: %s", (source) => {
    expect(runtimeModuleEdges(source)).toHaveLength(1);
  });

  it("allows erased type dependencies", () => {
    expect(runtimeModuleEdges('import type { Tool } from "sdk"; export type { Tool } from "sdk";')).toEqual([]);
  });
});
