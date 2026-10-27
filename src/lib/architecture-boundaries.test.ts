import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const restrictedPackage = /^(?:next|react|react-dom|@modelcontextprotocol\/sdk)(?:\/|$)/;
const restrictedSource = /\/src\/(?:app|mcp|components)\//;

// Include erased types too: the application layer must not depend on adapter
// contracts. External package internals are outside this bounded first-party audit.
function imports(file: string, source: string): { modules: string[]; computed: boolean } {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const modules: string[] = [];
  let computed = false;
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) modules.push(node.text);
    else computed = true;
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === "require")) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { modules, computed };
}

type GraphHost = { read(file: string): string; resolve(specifier: string, importer: string): string | undefined };
function audit(entries: string[], host: GraphHost, engineOnly = false) {
  const visited = new Set<string>();
  const errors: string[] = [];
  const walk = (file: string, chain: string[]) => {
    if (visited.has(file)) return;
    visited.add(file);
    const edges = imports(file, host.read(file));
    if (edges.computed) errors.push(`${[...chain, file].join(" -> ")}: nonliteral module dependency`);
    for (const specifier of edges.modules) {
      const trace = [...chain, file, specifier].join(" -> ");
      if (restrictedPackage.test(specifier)) { errors.push(`${trace}: adapter package`); continue; }
      const target = host.resolve(specifier, file);
      if (!target) {
        if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@sofinance/engine/")) errors.push(`${trace}: unresolved first-party dependency`);
        continue;
      }
      if (restrictedSource.test(target) || engineOnly && target.includes("/src/") && !target.includes("/packages/engine/src/")) {
        errors.push(`${trace}: adapter or reverse engine dependency (${target})`); continue;
      }
      walk(target, [...chain, file]);
    }
  };
  entries.forEach(entry => walk(entry, []));
  return { errors, visited };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) ? [file] : [];
  });
}
const disk: GraphHost = {
  read: file => readFileSync(file, "utf8"),
  resolve: (specifier, importer) => {
    const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule;
    if (!resolved) return undefined;
    const file = realpathSync(resolved.resolvedFileName);
    return file.startsWith(root + path.sep) && !file.includes("/node_modules/") ? file : undefined;
  },
};

describe("prepare dependency direction", () => {
  it("follows every new use case through first-party aliases, barrels and literal dynamic imports", () => {
    const result = audit(sourceFiles(path.join(root, "src/server/transactions")), disk);
    expect(result.errors).toEqual([]);
    expect(result.visited.has(path.join(root, "src/lib/selected-atomic.ts"))).toBe(true);
    expect(result.visited.has(path.join(root, "packages/engine/src/withdraw/build.ts"))).toBe(true);
  });
  it("keeps production engine sources independent of the public app", () => {
    expect(audit(sourceFiles(path.join(root, "packages/engine/src")), disk, true).errors).toEqual([]);
  });
});

// Use the real TypeScript resolver over an in-memory filesystem. Negative tests
// must fail for paths, not just for spelling a forbidden package at the root.
function fixture(source: string, barrel = 'export const safe = 1;', engineOnly = false) {
  const base = path.join(root, "src/server/transactions/probe.ts");
  const files: Record<string, string> = {
    [base]: source,
    [path.join(root, "src/lib/barrel.ts")]: barrel,
    [path.join(root, "src/app/api/probe/route.ts")]: "export const bad = 1;",
    [path.join(root, "src/mcp/schemas.ts")]: "export type Bad = string;",
    [path.join(root, "src/components/probe.tsx")]: "export const bad = 1;",
  };
  const resolver: ts.ModuleResolutionHost = { fileExists: file => file in files, readFile: file => files[file], directoryExists: dir => Object.keys(files).some(file => file.startsWith(dir + "/")) };
  return audit([base], {
    read: file => files[file]!,
    resolve: (specifier, importer) => ts.resolveModuleName(specifier, importer, options, resolver).resolvedModule?.resolvedFileName,
  }, engineOnly).errors;
}
describe("dependency guard negative controls", () => {
  it("allows library direction and .js source resolution", () => {
    expect(fixture('import { safe } from "../../lib/barrel.js";')).toEqual([]);
  });
  it.each([
    'import "@/app/api/probe/route";',
    'export * from "../../app/api/probe/route";',
    'import type { Bad } from "@/mcp/schemas";',
    'type Bad = import("@/mcp/schemas").Bad;',
    'import bad = require("../../app/api/probe/route");',
    'const bad = require("../../components/probe");',
    'const bad = import("../../app/api/probe/route.js");',
    'import "next/server";',
    'import "@modelcontextprotocol/sdk/server/index.js";',
    'export type { ReactNode } from "react";',
    'const bad = import(variable);',
    'const bad = require(variable);',
    'import "@/lib/missing";',
  ])("rejects %s", source => { expect(fixture(source).length).toBeGreaterThan(0); });
  it.each(['export * from "@/app/api/probe/route";', 'const route = import("../app/api/probe/route");'])
    ("rejects adapter dependencies hidden in a library barrel: %s", barrel => {
      expect(fixture('import "@/lib/barrel";', barrel).length).toBeGreaterThan(0);
    });
  it("rejects engine reaching even an otherwise permitted public library", () => {
    expect(fixture('import "@/lib/barrel";', undefined, true).length).toBeGreaterThan(0);
  });
});
