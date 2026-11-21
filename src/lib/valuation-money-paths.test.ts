import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * X3-5 rule (PM): the withdraw targetUSDC estimate and every signed amount never use a pair-guard-corrected price
 * (that is display only); signed amounts keep going through the quote + slippage. Encoded structurally: no module
 * reachable at runtime from these money-path entries may import the pair guard. Type-only imports carry no values and
 * are not followed (the DEX adapter contract names the guard's result type for its reports).
 */
const root = path.resolve(import.meta.dirname, "../..");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const PAIR_GUARD = path.join(root, "packages/engine/src/valuation/pair-pricing.ts");
const MONEY_PATH_ENTRIES = [
  "packages/engine/src/withdraw/build.ts",
  "packages/engine/src/withdraw/quote.ts",
  "packages/engine/src/selected-state.ts",
  "src/lib/dex/meteora-dlmm/minimum.server.ts",
].map((file) => path.join(root, file));

function typeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function importsOf(file: string): string[] {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && !typeOnlyImport(node)) out.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) out.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

/** First-party modules reachable from `entry`, with the import chain that reached each one. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const specifier of importsOf(file)) {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || resolved.includes("node_modules") || resolved.endsWith(".d.ts") || !existsSync(resolved)) continue;
      const real = path.resolve(resolved);
      if (seen.has(real)) continue;
      seen.set(real, [...seen.get(file)!, real]);
      queue.push(real);
    }
  }
  return seen;
}

describe("money paths never see the pair guard (X3-5)", () => {
  it.each(MONEY_PATH_ENTRIES)("%s cannot reach valuation/pair-pricing", (entry) => {
    const graph = reachable(entry);
    expect(graph.size).toBeGreaterThan(1);
    const chain = graph.get(PAIR_GUARD)?.map((file) => path.relative(root, file));
    expect(chain).toBeUndefined();
  });
  it("the guard module exists where this test looks for it", () => {
    expect(existsSync(PAIR_GUARD)).toBe(true);
  });
});
