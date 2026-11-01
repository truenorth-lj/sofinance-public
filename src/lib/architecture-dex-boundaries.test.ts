/**
 * DEX boundary guard (meteora-positions DESIGN.md §1.4–1.5): UI, API routes, server use cases, MCP and the cron job
 * reach a DEX only through the `@/lib/dex` registry, and no code outside `src/lib/dex/**` branches on a DEX id or
 * chain string.
 *
 * Existing violations are frozen in `architecture-dex-baseline.json`, which may only shrink: a new violating file or a
 * higher count fails, and so does a count that dropped without the baseline being lowered (ratchet). The totals are
 * also pinned in BASELINE_CEILING, so raising the baseline takes two deliberate edits. ESLint (`eslint.config.mjs`)
 * gives the alias/package part of the import rule as editor feedback for non-baselined files; this test also resolves
 * relative paths.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import baseline from "./architecture-dex-baseline.json";

const root = path.resolve(import.meta.dirname, "../..");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;

/** Ceiling on the baseline totals; lower these together with the JSON whenever a PR removes violations. */
const BASELINE_CEILING = { imports: 56, branches: 36 } as const;

/** Every DEX id spelling (canonical + legacy) and chain string that must not drive a branch outside src/lib/dex. */
const DEX_BRANCH_LITERALS: ReadonlySet<string> = new Set([
  "raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc", "rhc-uniswap-v4", "solana", "robinhood", "robinhood-chain",
]);

const DEX_PACKAGE = /^@(?:raydium-io|meteora-ag|orca-so|uniswap)\/|^@sofinance\/engine\/(?:protocols\/|(?:open-atomic|compound-atomic|open-state|open-quote|selected-state|lp-exit|wallet-discovery)$)/;
/** First-party files that are one specific DEX's implementation (root-relative, forward slashes). */
const DEX_MODULE_PATH = new RegExp([
  "^packages/engine/src/protocols/",
  "^packages/engine/src/(?:open-atomic|compound-atomic|open-state|open-quote|selected-state|lp-exit|wallet-discovery)\\.ts$",
  "^src/lib/dex/[^/]+/",
  "^src/lib/(?:meteora-|orca-|rhc-univ4-|rhc-position-|rhc-range-apr|rhc-apr-refresh|rhc-snapshot)[^/]*\\.ts$",
  "^src/lib/meteora-wallet/",
  "^src/lib/pool-sources/(?!types\\.ts$)",
].join("|"));
/** Files that must go through the registry: UI, routes and pages, server use cases, MCP, and the cron job. */
const REGISTRY_ONLY_PATH = /^src\/(?:app|components|server|mcp)\/|^src\/lib\/rwa-refresh[^/]*\.ts$/;
/** The only place DEX-specific branching is allowed. */
const BRANCH_ALLOWED_PATH = /^src\/lib\/dex\//;

const isTest = (file: string) => /\.test\.tsx?$/.test(file) || /(^|\/)(__contract__|test-support)\//.test(file);

type Host = { read(file: string): string; resolve(specifier: string, importer: string): string | undefined };
type Finding = { file: string; detail: string };

function moduleSpecifiers(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) found.push(node.moduleReference.expression.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

/** Direct imports of a DEX package or a DEX implementation module from a registry-only file. */
function dexImportFindings(relativeFile: string, host: Host): Finding[] {
  if (!REGISTRY_ONLY_PATH.test(relativeFile) || isTest(relativeFile)) return [];
  const absolute = path.join(root, relativeFile);
  return moduleSpecifiers(absolute, host.read(absolute)).flatMap((specifier) => {
    if (DEX_PACKAGE.test(specifier)) return [{ file: relativeFile, detail: specifier }];
    const target = host.resolve(specifier, absolute);
    if (!target) return [];
    const relativeTarget = path.relative(root, target).split(path.sep).join("/");
    return DEX_MODULE_PATH.test(relativeTarget) ? [{ file: relativeFile, detail: specifier }] : [];
  });
}

/** `x === "<dex id or chain>"` (any equality operator, either side) and `case "<dex id or chain>":` outside src/lib/dex. */
function dexBranchFindings(relativeFile: string, source: string): Finding[] {
  if (BRANCH_ALLOWED_PATH.test(relativeFile) || isTest(relativeFile)) return [];
  const ast = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const literal = (node: ts.Node) => ts.isStringLiteralLike(node) && DEX_BRANCH_LITERALS.has(node.text) ? node.text : null;
  const equality = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
  const line = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && equality.has(node.operatorToken.kind)) {
      const value = literal(node.left) ?? literal(node.right);
      if (value) findings.push({ file: relativeFile, detail: `line ${line(node)}: compares "${value}"` });
    }
    if (ts.isCaseClause(node)) {
      const value = literal(node.expression);
      if (value) findings.push({ file: relativeFile, detail: `line ${line(node)}: case "${value}"` });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(entry.name) ? [path.relative(root, file).split(path.sep).join("/")] : [];
  });
}

const disk: Host = {
  read: (file) => readFileSync(file, "utf8"),
  resolve: (specifier, importer) => {
    const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule;
    if (!resolved) return undefined;
    const file = realpathSync(resolved.resolvedFileName);
    return file.startsWith(root + path.sep) && !file.includes("/node_modules/") ? file : undefined;
  },
};

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
      problems.push(`${kind}: ${file} has ${count} (baseline ${allowed}): ${details}. Go through the @/lib/dex registry and capabilities instead.`);
    }
  }
  for (const [file, allowed] of Object.entries(frozen)) {
    const count = current[file] ?? 0;
    if (count < allowed) problems.push(`${kind}: ${file} is down to ${count} from ${allowed}; lower architecture-dex-baseline.json and BASELINE_CEILING to lock it in.`);
  }
  return problems;
}

describe("DEX boundaries (shrink-only baseline)", () => {
  const files = sourceFiles(path.join(root, "src"));

  it("adds no direct DEX import to UI, routes, server, MCP or cron", () => {
    const findings = files.flatMap((file) => dexImportFindings(file, disk));
    expect(ratchet("import", findings, baseline.imports)).toEqual([]);
  });

  it("adds no DEX-id or chain-string branch outside src/lib/dex", () => {
    const findings = files.flatMap((file) => dexBranchFindings(file, readFileSync(path.join(root, file), "utf8")));
    expect(ratchet("branch", findings, baseline.branches)).toEqual([]);
  });

  it("only ever lowers the baseline", () => {
    expect(total(baseline.imports)).toBeLessThanOrEqual(BASELINE_CEILING.imports);
    expect(total(baseline.branches)).toBeLessThanOrEqual(BASELINE_CEILING.branches);
  });
});

// Negative controls over an in-memory tree resolved by the real TypeScript resolver.
function probe(file: string, source: string): Finding[] {
  const files: Record<string, string> = {
    [path.join(root, file)]: source,
    [path.join(root, "src/lib/meteora-positions.ts")]: "export const x = 1;",
    [path.join(root, "src/lib/dex/index.ts")]: "export const dexRegistry = {};",
    [path.join(root, "src/lib/dex/client.ts")]: "export const dexDescriptors = {};",
    [path.join(root, "src/lib/dex/meteora-dlmm/adapter.server.ts")]: "export const adapter = {};",
    [path.join(root, "src/lib/pool-sources/types.ts")]: "export type PoolSource = {};",
    [path.join(root, "src/lib/pool-sources/meteora.ts")]: "export const meteora = {};",
    [path.join(root, "packages/engine/src/protocols/meteora/open.ts")]: "export const open = 1;",
    [path.join(root, "src/lib/unrelated.ts")]: "export const ok = 1;",
  };
  const resolver: ts.ModuleResolutionHost = { fileExists: (name) => name in files, readFile: (name) => files[name], directoryExists: (dir) => Object.keys(files).some((name) => name.startsWith(dir + "/")) };
  return dexImportFindings(file, {
    read: (name) => files[name]!,
    resolve: (specifier, importer) => ts.resolveModuleName(specifier, importer, options, resolver).resolvedModule?.resolvedFileName,
  });
}

describe("DEX boundary guard negative controls", () => {
  it.each([
    ["src/components/probe.tsx", 'import { x } from "@/lib/meteora-positions";'],
    ["src/components/probe.tsx", 'import { x } from "../lib/meteora-positions";'],
    ["src/app/api/probe/route.ts", 'export * from "@/lib/dex/meteora-dlmm/adapter.server";'],
    ["src/server/transactions/probe.ts", 'const m = import("@sofinance/engine/protocols/meteora/open");'],
    ["src/mcp/probe.ts", 'import type { X } from "@/lib/pool-sources/meteora";'],
    ["src/lib/rwa-refresh.ts", 'type T = import("@/lib/meteora-positions").X;'],
    ["src/components/probe.tsx", 'import DLMM from "@meteora-ag/dlmm";'],
    ["src/components/probe.tsx", 'const sdk = require("@raydium-io/raydium-sdk-v2");'],
  ])("flags %s importing %s", (file, source) => {
    expect(probe(file, source)).toHaveLength(1);
  });

  it("allows the registry entry points, shared types and non-DEX libraries", () => {
    expect(probe("src/components/probe.tsx", 'import { dexDescriptors } from "@/lib/dex/client"; import type { PoolSource } from "@/lib/pool-sources/types"; import { ok } from "@/lib/unrelated";')).toEqual([]);
    expect(probe("src/app/api/probe/route.ts", 'import { dexRegistry } from "@/lib/dex";')).toEqual([]);
  });

  it("does not police DEX implementations, plain libraries or tests", () => {
    expect(probe("src/lib/dex/meteora-dlmm/module.ts", 'import { x } from "@/lib/meteora-positions";')).toEqual([]);
    expect(probe("src/lib/unrelated-two.ts", 'import { x } from "@/lib/meteora-positions";')).toEqual([]);
    expect(probe("src/components/probe.test.tsx", 'import { x } from "@/lib/meteora-positions";')).toEqual([]);
  });

  it.each([
    'if (pool.protocol === "meteora-dlmm") go();',
    'const raydium = "raydium-clmm" == source;',
    'const evm = chain !== "solana";',
    'switch (id) { case "rhc-uniswap-v4": break; }',
    'const ok = row.chain === "robinhood" ? 1 : 2;',
  ])("flags the branch %s", (source) => {
    expect(dexBranchFindings("src/components/probe.tsx", source)).toHaveLength(1);
  });

  it("ignores non-DEX literals, src/lib/dex and tests", () => {
    expect(dexBranchFindings("src/lib/x.ts", 'if (event.source === "geckoterminal") stop(); const label = "meteora-dlmm";')).toEqual([]);
    expect(dexBranchFindings("src/lib/dex/meteora-dlmm/adapter.server.ts", 'if (id === "meteora-dlmm") go();')).toEqual([]);
    expect(dexBranchFindings("src/lib/x.test.ts", 'if (id === "meteora-dlmm") go();')).toEqual([]);
  });

  it("ratchets both ways against the baseline", () => {
    const findings = [{ file: "a.ts", detail: "x" }, { file: "a.ts", detail: "y" }, { file: "b.ts", detail: "z" }];
    expect(ratchet("import", findings, { "a.ts": 2, "b.ts": 1 })).toEqual([]);
    expect(ratchet("import", findings, { "a.ts": 2 })).toEqual([expect.stringContaining("b.ts has 1 (baseline 0)")]);
    expect(ratchet("import", findings, { "a.ts": 1, "b.ts": 1 })).toEqual([expect.stringContaining("a.ts has 2 (baseline 1)")]);
    expect(ratchet("import", findings, { "a.ts": 3, "b.ts": 1 })).toEqual([expect.stringContaining("down to 2 from 3")]);
  });
});
