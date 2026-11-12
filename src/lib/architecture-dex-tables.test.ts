/**
 * Protocol-keyed table guard (Phase E, docs/refactor/phase-e-dex-registry.md §3):
 * static object-literal tables whose keys include a canonical or legacy DEX id,
 * living outside `src/lib/dex/**`, are frozen in `architecture-dex-tables-baseline.json`
 * and may only shrink.
 *
 * A new violating file or a higher count fails, and so does a count that dropped
 * without the baseline being lowered (ratchet). The total is also pinned in
 * BASELINE_CEILING, so raising the baseline takes two deliberate edits.
 *
 * What counts: a module-scope object literal (including `as const`, `satisfies`,
 * and `Object.freeze(…)`) whose keys include at least one of `raydium-clmm`,
 * `orca-whirlpool`, `meteora-dlmm`, `uniswap-v4-rhc`, `rhc-uniswap-v4`. One
 * finding per table, not per key.
 *
 * What does not count (reviewers need not re-litigate):
 * - chain-keyed tables (`CHAIN_META`, `CHAIN_LABELS`);
 * - source-alias tables (`SOURCE_ERROR`, `POOL_SOURCES`; keys `raydium` / `orca` /
 *   `meteora` / `rhc`, not a DexId);
 * - runtime-built Records and `useState`;
 * - price-source / error-code maps whose keys only share a substring like "raydium";
 * - files under `src/lib/dex/**`;
 * - engine paths under `packages/` (this scan, like architecture-dex-boundaries,
 *   is `src/`);
 * - object literals inside functions (not module-scope / not static).
 *
 * Ceiling started at the shipped scanner's count of 3 (PM 2026-11-12).
 * E-move lowered it to 2 when `PROTOCOL_META` moved into `src/lib/dex`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import baseline from "./architecture-dex-tables-baseline.json";

const root = path.resolve(import.meta.dirname, "../..");

/** Ceiling on the baseline total; lower this together with the JSON whenever a PR removes a table. */
const BASELINE_CEILING = { tables: 2 } as const;

/** Canonical DEX ids plus the one-release legacy alias; chain strings are not keys of these tables. */
const DEX_TABLE_KEYS: ReadonlySet<string> = new Set([
  "raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc", "rhc-uniswap-v4",
]);

/** Real test files, plus the contract-suite harness. Nothing else is exempt. */
const isTest = (file: string) => /\.test\.tsx?$/.test(file) || file.startsWith("src/lib/dex/__contract__/");

const DEX_DIR = "src/lib/dex/";

type Finding = { file: string; detail: string };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(entry.name) ? [path.relative(root, file).split(path.sep).join("/")] : [];
  });
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
      && ts.isIdentifier(current.expression.expression) && current.expression.expression.text === "Object"
      && current.expression.name.text === "freeze" && current.arguments[0]) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression))) {
    return name.expression.text;
  }
  return null;
}

function protocolKeys(literal: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)
      && !ts.isMethodDeclaration(property) && !ts.isGetAccessorDeclaration(property) && !ts.isSetAccessorDeclaration(property)) {
      continue;
    }
    const key = propertyKey(property.name);
    if (key && DEX_TABLE_KEYS.has(key)) keys.push(key);
  }
  return keys;
}

function bindingName(name: ts.BindingName): string {
  return ts.isIdentifier(name) ? name.text : "(binding)";
}

/** Module-scope static tables in `source`. Exported so probe tests can call it on planted snippets. */
function tableFindings(file: string, source: string): Finding[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const consider = (expression: ts.Expression, label: string) => {
    const literal = unwrap(expression);
    if (!ts.isObjectLiteralExpression(literal)) return;
    const keys = protocolKeys(literal);
    if (keys.length) findings.push({ file, detail: `${label} keys ${keys.join(", ")}` });
  };
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) consider(declaration.initializer, bindingName(declaration.name));
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) consider(statement.expression, "default export");
  }
  return findings;
}

const countByFile = (findings: Finding[]) => {
  const counts: Record<string, number> = {};
  for (const { file } of findings) counts[file] = (counts[file] ?? 0) + 1;
  return counts;
};
const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);

/** Differences against the baseline: new files, higher counts, and lowered counts the baseline still has to record. */
function ratchet(kind: string, findings: Finding[], frozen: Record<string, number>): string[] {
  const current = countByFile(findings);
  const problems: string[] = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = frozen[file] ?? 0;
    if (count > allowed) {
      const details = findings.filter((finding) => finding.file === file).map((finding) => finding.detail).join("; ");
      problems.push(`${kind}: ${file} has ${count} (baseline ${allowed}): ${details}. Move the table into src/lib/dex.`);
    }
  }
  for (const [file, allowed] of Object.entries(frozen)) {
    const count = current[file] ?? 0;
    if (count < allowed) problems.push(`${kind}: ${file} is down to ${count} from ${allowed}; lower architecture-dex-tables-baseline.json and BASELINE_CEILING to lock it in.`);
  }
  return problems;
}

const SCAN_TIMEOUT_MS = 30_000;

describe("protocol-keyed tables outside src/lib/dex (shrink-only baseline)", () => {
  const files = sourceFiles(path.join(root, "src")).filter((file) => !isTest(file) && !file.startsWith(DEX_DIR));
  const findings = files.flatMap((file) => tableFindings(file, readFileSync(path.join(root, file), "utf8")));

  it("adds no protocol-keyed table outside src/lib/dex beyond the baseline", () => {
    expect(ratchet("table", findings, baseline.tables)).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("only ever lowers the baseline", () => {
    expect(total(baseline.tables)).toBeLessThanOrEqual(BASELINE_CEILING.tables);
    expect(total(countByFile(findings))).toBe(total(baseline.tables));
  });
});

describe("protocol-keyed table scanner (probe snippets)", () => {
  const file = "src/components/probe.ts";

  it("counts a module-scope table keyed by a DEX id", () => {
    expect(tableFindings(file, `export const META = { "raydium-clmm": true, "uniswap-v4-rhc": true };`)).toEqual([
      { file, detail: "META keys raydium-clmm, uniswap-v4-rhc" },
    ]);
  });

  it("counts Object.freeze and as const wrappers, and a default export", () => {
    expect(tableFindings(file, `export const META = Object.freeze({ "meteora-dlmm": { open: true } } as const);`)).toEqual([
      { file, detail: "META keys meteora-dlmm" },
    ]);
    expect(tableFindings(file, `export default { "rhc-uniswap-v4": true } as const;`)).toEqual([
      { file, detail: "default export keys rhc-uniswap-v4" },
    ]);
  });

  it("counts two tables in one file separately", () => {
    const source = `export const A = { "orca-whirlpool": 1 };\nexport const B = { "raydium-clmm": 2 };`;
    expect(tableFindings(file, source)).toHaveLength(2);
  });

  it("excludes src/lib/dex and test files from the repo scan the way the baseline test does", () => {
    const rows = [
      { file: "src/lib/dex/ui.ts", source: `export const META = { "raydium-clmm": true };` },
      { file: "src/components/probe.test.ts", source: `export const META = { "orca-whirlpool": true };` },
      { file: "src/components/probe.ts", source: `export const META = { "meteora-dlmm": true };` },
    ];
    const scanned = rows
      .filter((row) => !isTest(row.file) && !row.file.startsWith(DEX_DIR))
      .flatMap((row) => tableFindings(row.file, row.source));
    expect(scanned).toEqual([{ file: "src/components/probe.ts", detail: "META keys meteora-dlmm" }]);
  });

  it("does not count a chain-keyed table, a source-alias table, or a price-source map", () => {
    expect(tableFindings(file, `export const CHAIN_META = { solana: { showHighestRange: true }, robinhood: { showHighestRange: false } };`)).toEqual([]);
    expect(tableFindings(file, `export const SOURCE_ERROR = { raydium: "x", orca: "y", meteora: "z", rhc: "w" };`)).toEqual([]);
    expect(tableFindings(file, `export const PRICE_SOURCE_ID = { raydium: "raydium-pool-stable", jupiter: "jupiter-price-v3" };`)).toEqual([]);
  });

  it("does not count an object literal inside a function", () => {
    expect(tableFindings(file, `export function build() { return { "raydium-clmm": true }; }`)).toEqual([]);
    expect(tableFindings(file, `export const build = () => ({ "meteora-dlmm": true });`)).toEqual([]);
  });

  it("does not count a computed key that is not a string literal", () => {
    expect(tableFindings(file, `const id = "raydium-clmm"; export const META = { [id]: true };`)).toEqual([]);
  });

  it("fails the ratchet when a new table appears or a count drops without lowering the baseline", () => {
    const planted = tableFindings(file, `export const META = { "raydium-clmm": true };`);
    expect(ratchet("table", planted, {})).toEqual([
      `table: ${file} has 1 (baseline 0): META keys raydium-clmm. Move the table into src/lib/dex.`,
    ]);
    expect(ratchet("table", [], { [file]: 1 })).toEqual([
      `table: ${file} is down to 0 from 1; lower architecture-dex-tables-baseline.json and BASELINE_CEILING to lock it in.`,
    ]);
  });
});
