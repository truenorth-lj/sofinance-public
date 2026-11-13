/**
 * DEX boundary guard (meteora-positions DESIGN.md §1.4–1.5): UI, API routes, server use cases, MCP and the cron job
 * reach a DEX only through the `@/lib/dex` registry, and no code outside `src/lib/dex/**` branches on a DEX id or
 * chain string.
 *
 * Existing violations are frozen in `architecture-dex-baseline.json`, which may only shrink: a new violating file or a
 * higher count fails, and so does a count that dropped without the baseline being lowered (ratchet). The totals are
 * also pinned in BASELINE_CEILING, so raising the baseline takes two deliberate edits. ESLint (`eslint.config.mjs`)
 * gives the alias/package part of the import rule as editor feedback for non-baselined files; this test also resolves
 * relative paths, follows `export … from` chains, auto-classifies any lib/engine module with a runtime DEX SDK or
 * `protocols/<dex>/` import, and checks the layering inside `src/lib/dex` (including what client.ts can reach).
 *
 * Known blind spots (reviewers still check these by hand):
 * - a branch that compares through a constant, `.includes`, a lookup map or `startsWith`;
 * - a DEX call wrapped in a function (or object) that a non-DEX module exports, e.g. `export const run = () => dexCall()`;
 *   only `export … from`, `export { imported }` and `export default imported` re-exports are followed;
 * - type-only re-exports (`export type … from`) are intentionally not followed, since they are erased at runtime; direct
 *   type imports of DEX modules (`import type … from` a DEX SDK or `protocols/<dex>/`) still count as violations.
 *
 * Auto-classification resolves `@sofinance/engine/*` to `packages/engine/src` inside this repo (the pnpm workspace
 * link); if the engine ever resolved outside the repo (a published package, a symlink to another checkout), engine
 * DEX modules would no longer be classified by path.
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
const BASELINE_CEILING = { imports: 78, branches: 28 } as const;

/** Every DEX id spelling (canonical + legacy) and chain string that must not drive a branch outside src/lib/dex. */
const DEX_BRANCH_LITERALS: ReadonlySet<string> = new Set([
  "raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc", "rhc-uniswap-v4", "solana", "robinhood", "robinhood-chain",
]);

/** Third-party DEX SDKs. */
const DEX_SDK = /^@(?:raydium-io|meteora-ag|orca-so|uniswap)\//;
/** Engine modules that are one DEX's implementation (Raydium CLMM engine); keep in sync with eslint.config.mjs. */
const ENGINE_DEX_MODULES = [
  "open-atomic", "compound-atomic", "compound-state", "compound-recovery-import", "open-state", "open-quote", "open-range",
  "selected-state", "lp-exit", "lp-exit-data", "wallet-discovery",
].join("|");
const DEX_PACKAGE = new RegExp(`${DEX_SDK.source}|^@sofinance/engine/(?:protocols/|(?:${ENGINE_DEX_MODULES})$)`);
/** First-party files that are one specific DEX's implementation (root-relative, forward slashes). */
const DEX_MODULE_PATH = new RegExp([
  "^packages/engine/src/protocols/",
  `^packages/engine/src/(?:${ENGINE_DEX_MODULES})\\.ts$`,
  "^src/lib/dex/(?!__contract__/)[^/]+/",
  "^src/lib/(?:meteora-|orca-|rhc-univ4-|rhc-position-|rhc-range-apr|rhc-apr-refresh|rhc-snapshot)[^/]*\\.ts$",
  "^src/lib/meteora-wallet/",
  // Uniswap v4 on Robinhood Chain wallet flow (the generic EVM session / EIP-1193 helpers stay shared).
  "^src/lib/rhc-wallet/(?:open-execute|exit-execute|open-steps|open-attempt|pool-view)\\.ts$",
  "^src/lib/pool-sources/(?!types\\.ts$)",
].join("|"));
/** One specific protocol's engine code (not the shared `protocols/types.ts`). */
const ONE_PROTOCOL_PATH = /^packages\/engine\/src\/protocols\/[^/]+\//;
/** Library code that may be auto-classified as a DEX module when it imports a DEX SDK or engine protocol directly. */
const AUTO_CLASSIFIED_PATH = /^(?:src\/lib|packages\/engine\/src)\//;
/** Files that must go through the registry: UI, routes and pages, server use cases, MCP, and the cron job. */
const REGISTRY_ONLY_PATH = /^src\/(?:app|components|server|mcp)\/|^src\/lib\/rwa-refresh[^/]*\.ts$/;
/** UI components: client-side, so only the client registry entry point. */
const COMPONENT_PATH = /^src\/components\//;
const DEX_DIR = "src/lib/dex/";
const DEX_CLIENT_ENTRY = "src/lib/dex/client.ts";
/** The only place DEX-specific branching is allowed. */
const BRANCH_ALLOWED_PATH = /^src\/lib\/dex\//;

/** Real test files, plus the contract-suite harness. Nothing else is exempt (no `test-support/` escape hatch). */
const isTest = (file: string) => /\.test\.tsx?$/.test(file) || file.startsWith("src/lib/dex/__contract__/");

type Host = { read(file: string): string; resolve(specifier: string, importer: string): string | undefined };
type Finding = { file: string; detail: string };
type Specifier = { text: string; typeOnly: boolean; reexport: boolean };

const rel = (absolute: string) => path.relative(root, absolute).split(path.sep).join("/");

function moduleSpecifiers(file: string, source: string): Specifier[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Specifier[] = [];
  // Local import bindings, so a two-step re-export (`import { x } from "./m"; export { x };`) counts as re-exporting "./m".
  const bindings = new Map<string, Specifier>();
  const reexportedLocals: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
      const typeOnly = Boolean(clause && (clause.isTypeOnly || (!clause.name && named && named.length > 0 && named.every((element) => element.isTypeOnly))));
      const specifier: Specifier = { text: node.moduleSpecifier.text, typeOnly, reexport: false };
      found.push(specifier);
      if (clause?.name) bindings.set(clause.name.text, specifier);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.set(clause.namedBindings.name.text, specifier);
      for (const element of named ?? []) bindings.set(element.name.text, specifier);
    }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) reexportedLocals.push((element.propertyName ?? element.name).text);
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) reexportedLocals.push(node.expression.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      const typeOnly = node.isTypeOnly || Boolean(named && named.length > 0 && named.every((element) => element.isTypeOnly));
      found.push({ text: node.moduleSpecifier.text, typeOnly, reexport: true });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) found.push({ text: node.moduleReference.expression.text, typeOnly: node.isTypeOnly, reexport: false });
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push({ text: node.argument.literal.text, typeOnly: true, reexport: false });
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push({ text: node.arguments[0].text, typeOnly: false, reexport: false });
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const local of reexportedLocals) {
    const specifier = bindings.get(local);
    if (specifier) specifier.reexport = true;
  }
  return found;
}

/** Classifies first-party files as DEX implementation modules: by path, or because they import a DEX SDK / engine protocol. */
function dexClassifier(host: Host) {
  const auto = new Map<string, boolean>();
  const importsDexDirectly = (relativeFile: string): boolean => {
    if (!AUTO_CLASSIFIED_PATH.test(relativeFile) || REGISTRY_ONLY_PATH.test(relativeFile) || isTest(relativeFile)) return false;
    if (relativeFile.startsWith(DEX_DIR)) return false;
    const cached = auto.get(relativeFile);
    if (cached !== undefined) return cached;
    const absolute = path.join(root, relativeFile);
    let source: string;
    try { source = host.read(absolute); } catch { return false; }
    // Runtime imports only: a type-only import is erased, and `protocols/types.ts` is the shared protocol-id list.
    const result = moduleSpecifiers(absolute, source).some(({ text, typeOnly }) => {
      if (typeOnly) return false;
      if (DEX_SDK.test(text)) return true;
      const target = host.resolve(text, absolute);
      return Boolean(target && ONE_PROTOCOL_PATH.test(rel(target)));
    });
    auto.set(relativeFile, result);
    return result;
  };
  const isDexModule = (relativeTarget: string) => DEX_MODULE_PATH.test(relativeTarget) || importsDexDirectly(relativeTarget);

  /** Follows `export … from` chains from a non-DEX module; returns the chain that ends in a DEX module or package. */
  const reexportedDex = (absolute: string, seen = new Set<string>()): string[] | null => {
    if (seen.has(absolute)) return null;
    seen.add(absolute);
    let source: string;
    try { source = host.read(absolute); } catch { return null; }
    for (const specifier of moduleSpecifiers(absolute, source)) {
      // Type-only re-exports are erased at runtime (a direct type import of a DEX module is still counted).
      if (!specifier.reexport || specifier.typeOnly) continue;
      if (DEX_PACKAGE.test(specifier.text)) return [specifier.text];
      const target = host.resolve(specifier.text, absolute);
      if (!target) continue;
      const relativeTarget = rel(target);
      if (isDexModule(relativeTarget)) return [relativeTarget];
      const deeper = reexportedDex(target, seen);
      if (deeper) return [relativeTarget, ...deeper];
    }
    return null;
  };
  return { isDexModule, reexportedDex };
}

/** Direct (or re-exported) imports of a DEX package or a DEX implementation module from a registry-only file. */
function dexImportFindings(relativeFile: string, host: Host, classify = dexClassifier(host)): Finding[] {
  if (!REGISTRY_ONLY_PATH.test(relativeFile) || isTest(relativeFile)) return [];
  const absolute = path.join(root, relativeFile);
  const component = COMPONENT_PATH.test(relativeFile);
  return moduleSpecifiers(absolute, host.read(absolute)).flatMap(({ text }) => {
    if (DEX_PACKAGE.test(text)) return [{ file: relativeFile, detail: text }];
    const target = host.resolve(text, absolute);
    if (!target) return [];
    const relativeTarget = rel(target);
    if (component && relativeTarget.startsWith(DEX_DIR) && relativeTarget !== DEX_CLIENT_ENTRY) {
      return [{ file: relativeFile, detail: `${text} (components import only @/lib/dex/client)` }];
    }
    if (classify.isDexModule(relativeTarget)) return [{ file: relativeFile, detail: text }];
    const chain = classify.reexportedDex(target);
    return chain ? [{ file: relativeFile, detail: `${text} (re-exports ${chain.join(" -> ")})` }] : [];
  });
}

/**
 * Rules inside src/lib/dex (no baseline; must stay at zero):
 * - `dex/<a>/**` never imports `dex/<b>/**`, and non-test code never imports the `__contract__` harness;
 * - shared top-level files (client, registry, descriptors, modules, …) import from `dex/<id>/` only `module.ts` or
 *   `descriptor.ts`, and no DEX SDK or DEX module outside src/lib/dex;
 * - nothing reachable from `client.ts` at runtime touches `server-only`, a DEX SDK, or a `*.server.ts` file.
 */
function dexInternalFindings(files: readonly string[], host: Host, classify = dexClassifier(host)): Finding[] {
  const findings: Finding[] = [];
  const dexDirOf = (relativeFile: string) => relativeFile.startsWith(DEX_DIR) ? relativeFile.slice(DEX_DIR.length).split("/").slice(0, -1)[0] ?? null : null;
  for (const relativeFile of files) {
    if (!relativeFile.startsWith(DEX_DIR) || isTest(relativeFile)) continue;
    const absolute = path.join(root, relativeFile);
    const own = dexDirOf(relativeFile);
    for (const { text } of moduleSpecifiers(absolute, host.read(absolute))) {
      if (!own && DEX_PACKAGE.test(text)) { findings.push({ file: relativeFile, detail: `${text}: shared DEX files import no DEX SDK or engine DEX module` }); continue; }
      const target = host.resolve(text, absolute);
      if (!target) continue;
      const relativeTarget = rel(target);
      const other = relativeTarget.startsWith(DEX_DIR) ? dexDirOf(relativeTarget) : null;
      if (other === "__contract__") { findings.push({ file: relativeFile, detail: `${text}: only tests import the contract harness` }); continue; }
      if (own && other && other !== own) { findings.push({ file: relativeFile, detail: `${text}: dex/${own} must not import dex/${other}` }); continue; }
      if (!own && other && !/\/(?:module|descriptor)\.ts$/.test(relativeTarget)) findings.push({ file: relativeFile, detail: `${text}: shared DEX files import only <id>/module.ts or <id>/descriptor.ts` });
      if (!own && !relativeTarget.startsWith(DEX_DIR) && classify.isDexModule(relativeTarget)) findings.push({ file: relativeFile, detail: `${text}: shared DEX files import no DEX implementation module` });
    }
  }
  // Runtime reachability from the client entry point (type-only imports are erased and skipped).
  const entry = path.join(root, DEX_CLIENT_ENTRY);
  const seen = new Set<string>();
  const walk = (absolute: string, chain: readonly string[]) => {
    if (seen.has(absolute)) return;
    seen.add(absolute);
    let source: string;
    try { source = host.read(absolute); } catch { return; }
    const trail = [...chain, rel(absolute)];
    for (const { text, typeOnly } of moduleSpecifiers(absolute, source)) {
      if (typeOnly) continue;
      if (text === "server-only" || DEX_SDK.test(text)) { findings.push({ file: DEX_CLIENT_ENTRY, detail: `reaches ${text} via ${trail.join(" -> ")}` }); continue; }
      const target = host.resolve(text, absolute);
      if (!target) continue;
      if (/\.server\.tsx?$/.test(target)) { findings.push({ file: DEX_CLIENT_ENTRY, detail: `reaches ${rel(target)} via ${trail.join(" -> ")}` }); continue; }
      walk(target, trail);
    }
  };
  if (files.includes(DEX_CLIENT_ENTRY)) walk(entry, []);
  return findings;
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

const SCAN_TIMEOUT_MS = 30_000;

describe("DEX boundaries (shrink-only baseline)", () => {
  const files = sourceFiles(path.join(root, "src"));
  const classify = dexClassifier(disk);

  // Whole-repo scans: ~1.7 s alone, but over vitest's 5 s default when CI runs the full suite in parallel.
  it("adds no direct DEX import to UI, routes, server, MCP or cron", () => {
    const findings = files.flatMap((file) => dexImportFindings(file, disk, classify));
    expect(ratchet("import", findings, baseline.imports)).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("adds no DEX-id or chain-string branch outside src/lib/dex", () => {
    const findings = files.flatMap((file) => dexBranchFindings(file, readFileSync(path.join(root, file), "utf8")));
    expect(ratchet("branch", findings, baseline.branches)).toEqual([]);
  });

  it("keeps src/lib/dex layered: no cross-DEX imports, registry files import only module/descriptor, client stays client-safe", () => {
    expect(dexInternalFindings(files, disk, classify)).toEqual([]);
  });

  it("only ever lowers the baseline", () => {
    expect(total(baseline.imports)).toBeLessThanOrEqual(BASELINE_CEILING.imports);
    expect(total(baseline.branches)).toBeLessThanOrEqual(BASELINE_CEILING.branches);
  });

  it("keeps the ESLint DEX module list in sync with this guard", () => {
    const eslintConfig = readFileSync(path.join(root, "eslint.config.mjs"), "utf8");
    const expected = [
      ...ENGINE_DEX_MODULES.split("|").map((name) => `"@sofinance/engine/${name}"`),
      ...["open-execute", "exit-execute", "open-steps", "open-attempt", "pool-view"].map((name) => `"@/lib/rhc-wallet/${name}"`),
    ];
    expect(expected.filter((specifier) => !eslintConfig.includes(specifier))).toEqual([]);
  });
});

// Negative controls over an in-memory tree resolved by the real TypeScript resolver.
const PROBE_TREE: Readonly<Record<string, string>> = {
  "src/lib/meteora-positions.ts": "export const x = 1;",
  "src/lib/dex/index.ts": "export const dexRegistry = {};",
  "src/lib/dex/client.ts": "export const dexDescriptors = {};",
  "src/lib/dex/types.ts": "export type DexId = string;",
  "src/lib/dex/meteora-dlmm/adapter.server.ts": "export const adapter = {};",
  "src/lib/pool-sources/types.ts": "export type PoolSource = {};",
  "src/lib/pool-sources/meteora.ts": "export const meteora = {};",
  "packages/engine/src/protocols/meteora/open.ts": "export const open = 1;",
  "packages/engine/src/compound-state.ts": "export const state = 1;",
  "packages/engine/src/lp-exit-data.ts": "export const data = 1;",
  "packages/engine/src/open-range.ts": "export const range = 1;",
  "packages/engine/src/compound-recovery-import.ts": "export const recovery = 1;",
  "src/lib/rhc-wallet/open-execute.ts": "export const run = 1;",
  "src/lib/rhc-wallet/pool-view.ts": "export const view = 1;",
  "src/lib/rhc-wallet/evm-session.ts": "export const session = 1;",
  "src/lib/uses-sdk.ts": 'import { Raydium } from "@raydium-io/raydium-sdk-v2"; export const r = Raydium;',
  "src/lib/uses-protocol.ts": 'import { open } from "../../packages/engine/src/protocols/meteora/open"; export const o = open;',
  "src/lib/barrel.ts": 'export * from "./meteora-positions";',
  "src/lib/barrel-of-barrel.ts": 'export { x as y } from "./barrel";',
  "src/lib/two-step.ts": 'import { x } from "./meteora-positions"; export { x };',
  "src/lib/two-step-alias.ts": 'import { x as local } from "./meteora-positions"; export { local as z };',
  "src/lib/two-step-namespace.ts": 'import * as positions from "./meteora-positions"; export { positions };',
  "src/lib/two-step-default.ts": 'import positions from "./meteora-positions"; export default positions;',
  "src/lib/two-step-of-barrel.ts": 'import { x } from "./barrel"; export { x };',
  "src/lib/type-reexport.ts": 'import type { X } from "./meteora-positions"; export type { X };',
  "src/lib/wraps-dex.ts": 'import { x } from "./meteora-positions"; export const wrapped = () => x;',
  "src/lib/unrelated.ts": "export const ok = 1;",
  "src/lib/test-support/dex.ts": 'export * from "../meteora-positions";',
};

function memoryHost(extra: Readonly<Record<string, string>>): Host {
  const files = Object.fromEntries(Object.entries({ ...PROBE_TREE, ...extra }).map(([file, source]) => [path.join(root, file), source]));
  const resolver: ts.ModuleResolutionHost = { fileExists: (name) => name in files, readFile: (name) => files[name], directoryExists: (dir) => Object.keys(files).some((name) => name.startsWith(dir + "/")) };
  return {
    read: (name) => { if (!(name in files)) throw new Error(`no ${name}`); return files[name]!; },
    resolve: (specifier, importer) => ts.resolveModuleName(specifier, importer, options, resolver).resolvedModule?.resolvedFileName,
  };
}

function probe(file: string, source: string): Finding[] {
  return dexImportFindings(file, memoryHost({ [file]: source }));
}

function probeDex(tree: Readonly<Record<string, string>>): string[] {
  return dexInternalFindings(Object.keys(tree), memoryHost(tree)).map((finding) => `${finding.file}: ${finding.detail}`);
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
    // Uniswap v4 (Robinhood Chain) wallet flow modules.
    ["src/components/probe.tsx", 'import { run } from "@/lib/rhc-wallet/open-execute";'],
    ["src/app/probe/page.tsx", 'import { view } from "@/lib/rhc-wallet/pool-view";'],
    // Raydium engine modules, by package name and by path.
    ["src/server/transactions/probe.ts", 'import { state } from "@sofinance/engine/compound-state";'],
    ["src/server/transactions/probe.ts", 'import { data } from "@sofinance/engine/lp-exit-data";'],
    ["src/components/probe.tsx", 'import { range } from "@sofinance/engine/open-range";'],
    ["src/components/probe.tsx", 'import { recovery } from "../../packages/engine/src/compound-recovery-import";'],
    // Auto-classified: a library that imports a DEX SDK or an engine protocol is a DEX module.
    ["src/components/probe.tsx", 'import { r } from "@/lib/uses-sdk";'],
    ["src/mcp/probe.ts", 'import { o } from "@/lib/uses-protocol";'],
    // Barrels: re-exports are followed transitively.
    ["src/components/probe.tsx", 'import { x } from "@/lib/barrel";'],
    ["src/app/api/probe/route.ts", 'import { y } from "@/lib/barrel-of-barrel";'],
    // Two-step re-exports: import a binding, then export it.
    ["src/components/probe.tsx", 'import { x } from "@/lib/two-step";'],
    ["src/components/probe.tsx", 'import { z } from "@/lib/two-step-alias";'],
    ["src/server/transactions/probe.ts", 'import { positions } from "@/lib/two-step-namespace";'],
    ["src/mcp/probe.ts", 'import positions from "@/lib/two-step-default";'],
    ["src/app/api/probe/route.ts", 'import { x } from "@/lib/two-step-of-barrel";'],
    // test-support/ is not a test file.
    ["src/components/probe.tsx", 'import { x } from "@/lib/test-support/dex";'],
    ["src/components/test-support/probe.tsx", 'import { x } from "@/lib/meteora-positions";'],
    // Components import only the client entry point.
    ["src/components/probe.tsx", 'import { dexRegistry } from "@/lib/dex";'],
    ["src/components/probe.tsx", 'import type { DexId } from "@/lib/dex/types";'],
  ])("flags %s importing %s", (file, source) => {
    expect(probe(file, source)).toHaveLength(1);
  });

  it("allows the registry entry points, shared types and non-DEX libraries", () => {
    expect(probe("src/components/probe.tsx", 'import { dexDescriptors } from "@/lib/dex/client"; import type { PoolSource } from "@/lib/pool-sources/types"; import { ok } from "@/lib/unrelated"; import { session } from "@/lib/rhc-wallet/evm-session";')).toEqual([]);
    expect(probe("src/app/api/probe/route.ts", 'import { dexRegistry } from "@/lib/dex";')).toEqual([]);
  });

  it("does not police DEX implementations, plain libraries or tests", () => {
    expect(probe("src/lib/dex/meteora-dlmm/module.ts", 'import { x } from "@/lib/meteora-positions";')).toEqual([]);
    expect(probe("src/lib/unrelated-two.ts", 'import { x } from "@/lib/meteora-positions";')).toEqual([]);
    expect(probe("src/components/probe.test.tsx", 'import { x } from "@/lib/meteora-positions";')).toEqual([]);
  });

  it("documents the known blind spot: a DEX call wrapped in a function is not followed", () => {
    expect(probe("src/components/probe.tsx", 'import { wrapped } from "@/lib/wraps-dex";')).toEqual([]);
    expect(probe("src/components/probe.tsx", 'import type { X } from "@/lib/type-reexport";')).toEqual([]);
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

  it("ignores non-DEX literals, src/lib/dex and real tests, but not test-support/", () => {
    expect(dexBranchFindings("src/lib/x.ts", 'if (event.source === "geckoterminal") stop(); const label = "meteora-dlmm";')).toEqual([]);
    expect(dexBranchFindings("src/lib/dex/meteora-dlmm/adapter.server.ts", 'if (id === "meteora-dlmm") go();')).toEqual([]);
    expect(dexBranchFindings("src/lib/x.test.ts", 'if (id === "meteora-dlmm") go();')).toEqual([]);
    expect(dexBranchFindings("src/lib/test-support/x.ts", 'if (id === "meteora-dlmm") go();')).toHaveLength(1);
  });

  it("keeps src/lib/dex layered", () => {
    const clean = {
      "src/lib/dex/types.ts": "export type DexId = string;",
      "src/lib/dex/registry.ts": 'import type { DexId } from "./types"; export const make = (ids: DexId[]) => ids;',
      "src/lib/dex/descriptors.ts": 'import { meteoraDescriptor } from "./meteora-dlmm/descriptor"; export const DEX_DESCRIPTORS = [meteoraDescriptor];',
      "src/lib/dex/client.ts": 'import { DEX_DESCRIPTORS } from "./descriptors"; import { make } from "./registry"; import type { DexAdapter } from "./adapter"; export const c = make(DEX_DESCRIPTORS);',
      "src/lib/dex/adapter.ts": "export type DexAdapter = {};",
      "src/lib/dex/modules.ts": 'import { meteoraModule } from "./meteora-dlmm/module"; export const DEX_MODULES = [meteoraModule];',
      "src/lib/dex/index.ts": 'import "server-only"; import { DEX_MODULES } from "./modules"; export const r = DEX_MODULES;',
      "src/lib/dex/meteora-dlmm/descriptor.ts": 'import type { DexId } from "../types"; export const meteoraDescriptor = { id: "meteora-dlmm" as DexId };',
      "src/lib/dex/meteora-dlmm/module.ts": 'import { meteoraDescriptor } from "./descriptor"; export const meteoraModule = { descriptor: meteoraDescriptor, adapter: () => import("./adapter.server") };',
      "src/lib/dex/meteora-dlmm/adapter.server.ts": 'import "server-only"; import DLMM from "@meteora-ag/dlmm"; import { open } from "@sofinance/engine/protocols/meteora/open"; export const a = [DLMM, open];',
      "src/lib/dex/meteora-dlmm/meteora-dlmm.contract.test.ts": 'import { describeDexContract } from "../__contract__/dex-contract"; import { x } from "../raydium-clmm/fixtures";',
      "src/lib/dex/__contract__/dex-contract.ts": "export const describeDexContract = () => {};",
    };
    expect(probeDex(clean)).toEqual([]);

    expect(probeDex({ ...clean, "src/lib/dex/meteora-dlmm/pool-source.ts": 'import { x } from "../raydium-clmm/shared";', "src/lib/dex/raydium-clmm/shared.ts": "export const x = 1;" }))
      .toEqual(["src/lib/dex/meteora-dlmm/pool-source.ts: ../raydium-clmm/shared: dex/meteora-dlmm must not import dex/raydium-clmm"]);
    expect(probeDex({ ...clean, "src/lib/dex/meteora-dlmm/adapter.server.ts": 'import { describeDexContract } from "../__contract__/dex-contract";' }))
      .toEqual(["src/lib/dex/meteora-dlmm/adapter.server.ts: ../__contract__/dex-contract: only tests import the contract harness"]);
    expect(probeDex({ ...clean, "src/lib/dex/registry.ts": 'import { a } from "./meteora-dlmm/adapter.server"; export const make = (ids: string[]) => [ids, a];' })).toEqual([
      "src/lib/dex/registry.ts: ./meteora-dlmm/adapter.server: shared DEX files import only <id>/module.ts or <id>/descriptor.ts",
      "src/lib/dex/client.ts: reaches src/lib/dex/meteora-dlmm/adapter.server.ts via src/lib/dex/client.ts -> src/lib/dex/registry.ts",
    ]);
    expect(probeDex({ ...clean, "src/lib/dex/descriptors.ts": 'import { meteoraModule } from "./meteora-dlmm/module"; export const DEX_DESCRIPTORS = [meteoraModule.descriptor];' }))
      .toEqual(["src/lib/dex/client.ts: reaches src/lib/dex/meteora-dlmm/adapter.server.ts via src/lib/dex/client.ts -> src/lib/dex/descriptors.ts -> src/lib/dex/meteora-dlmm/module.ts"]);
    expect(probeDex({ ...clean, "src/lib/dex/meteora-dlmm/descriptor.ts": 'import "server-only"; export const meteoraDescriptor = {};' }))
      .toEqual(["src/lib/dex/client.ts: reaches server-only via src/lib/dex/client.ts -> src/lib/dex/descriptors.ts -> src/lib/dex/meteora-dlmm/descriptor.ts"]);
    expect(probeDex({ ...clean, "src/lib/dex/meteora-dlmm/descriptor.ts": 'import DLMM from "@meteora-ag/dlmm"; export const meteoraDescriptor = { DLMM };' }))
      .toEqual(["src/lib/dex/client.ts: reaches @meteora-ag/dlmm via src/lib/dex/client.ts -> src/lib/dex/descriptors.ts -> src/lib/dex/meteora-dlmm/descriptor.ts"]);
    expect(probeDex({ ...clean, "src/lib/dex/fees.ts": 'import { Raydium } from "@raydium-io/raydium-sdk-v2"; export const f = Raydium;' }))
      .toEqual(["src/lib/dex/fees.ts: @raydium-io/raydium-sdk-v2: shared DEX files import no DEX SDK or engine DEX module"]);
  });

  it("ratchets both ways against the baseline", () => {
    const findings = [{ file: "a.ts", detail: "x" }, { file: "a.ts", detail: "y" }, { file: "b.ts", detail: "z" }];
    expect(ratchet("import", findings, { "a.ts": 2, "b.ts": 1 })).toEqual([]);
    expect(ratchet("import", findings, { "a.ts": 2 })).toEqual([expect.stringContaining("b.ts has 1 (baseline 0)")]);
    expect(ratchet("import", findings, { "a.ts": 1, "b.ts": 1 })).toEqual([expect.stringContaining("a.ts has 2 (baseline 1)")]);
    expect(ratchet("import", findings, { "a.ts": 3, "b.ts": 1 })).toEqual([expect.stringContaining("down to 2 from 3")]);
  });
});
