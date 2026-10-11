// RATCHET (not a fix): secret-bearing environment variables may only be read in the files listed
// below, with exactly the listed number of reads. The list documents today's offenders so the
// refactor can shrink it step by step:
//   - a NEW read (new file, or more reads in a listed file) fails the test: use the config helper;
//   - REMOVING a read also fails until the allowlist is lowered: that is the ratchet, delete the line.
// Target end state (architecture review R3): only lib/config/server-env.ts, lib/rpc, lib/jupiter,
// lib/solami, and the swap-fee reader appear here. "env.X" parameter-style reads inside those
// encapsulated modules are listed too, because they are secret reads all the same.
// The scan is AST based (comments and strings never count) and covers every non-test .ts/.tsx file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

/** Names whose values are credentials (or embed credentials, like an RPC URL with an api key). */
const SECRET_ENV_NAMES = [
  "JUPITER_API_KEY", "SOLAMI_API_KEY", "SOLAMI_DATA_API_KEY", "SOLANA_RPC_URL", "SOFINANCE_MCP_TOKEN",
] as const;

/** `*` = the whole `process.env` object handed on to a function (can reach any secret). */
type Reads = Record<string, number>;
const ALLOWED_SECRET_READS: Record<string, Reads> = {
  JUPITER_API_KEY: {
    // the single reader (lib/config/server-env.ts)
    "lib/config/server-env.ts": 1,
    // allowed long-term: the Jupiter client's own env fallback (env param, injectable in tests)
    "lib/jupiter/urls.ts": 1,
  },
  SOLAMI_API_KEY: {
    // allowed long-term: encapsulated provider/Beam readers that take an `env` argument
    "lib/rpc/providers.ts": 1,
    "lib/solami/beam.ts": 2,
  },
  SOLAMI_DATA_API_KEY: {
    "lib/solami/blur.ts": 1,
  },
  SOLANA_RPC_URL: {
    "lib/rpc/providers.ts": 1,
  },
  SOFINANCE_MCP_TOKEN: {
    // local stdio-to-remote shim: reads the user's own token from its own process env
    "mcp/remote-shim.ts": 1,
  },
};

/** Files that pass the whole `process.env` object to a callee (callee then reads secrets by name). */
const ALLOWED_WHOLE_ENV_PASSES: Reads = {
  "lib/jupiter/logger.ts": 1,
  "lib/jupiter/urls.ts": 1,
  "lib/lp-exit-data.ts": 1,
  "lib/rpc/index.ts": 3,
  "lib/rpc/json-rpc.ts": 1,
  "lib/rpc/logger.ts": 1,
  "lib/rpc/providers.ts": 5,
  "lib/solami/beam.ts": 4,
  "lib/solami/blur.ts": 6,
};

type EnvRead = { name: string; line: number };

/** Every `process.env.X`, `process.env["X"]`, `<anything>env.X` / `env["X"]` read, plus whole-`process.env` uses (name "*"). */
function scanEnvReads(sourceText: string, fileName = "x.ts"): EnvRead[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const reads: EnvRead[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const isProcessEnv = (node: ts.Node): boolean => ts.isPropertyAccessExpression(node) && node.name.text === "env" &&
    ts.isIdentifier(node.expression) && node.expression.text === "process";
  const isEnvLike = (node: ts.Node): boolean => isProcessEnv(node) ||
    (ts.isIdentifier(node) && /(^|[a-z])env$/i.test(node.text)) ||
    (ts.isPropertyAccessExpression(node) && /(^|[a-z])env$/i.test(node.name.text));
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isEnvLike(node.initializer)) {
      // const { JUPITER_API_KEY } = process.env
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        reads.push({ name: ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : "*", line: lineOf(element) });
      }
    } else if (ts.isPropertyAccessExpression(node) && isEnvLike(node.expression)) {
      reads.push({ name: node.name.text, line: lineOf(node) });
    } else if (ts.isElementAccessExpression(node) && isEnvLike(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)) {
      reads.push({ name: node.argumentExpression.text, line: lineOf(node) });
    } else if (isProcessEnv(node)) {
      const parent = node.parent;
      const accessed = (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
        (ts.isElementAccessExpression(parent) && parent.expression === node) ||
        (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name));
      if (!accessed) reads.push({ name: "*", line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !path.includes("/test-support/")) files.push(path);
  }
  return files;
}

function inventory() {
  const secretReads: Record<string, Reads> = Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, {}]));
  const wholeEnv: Reads = {};
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replaceAll("\\", "/");
    for (const read of scanEnvReads(readFileSync(file, "utf8"), file)) {
      if (read.name === "*") wholeEnv[rel] = (wholeEnv[rel] ?? 0) + 1;
      else if ((SECRET_ENV_NAMES as readonly string[]).includes(read.name)) {
        const bucket = secretReads[read.name]!;
        bucket[rel] = (bucket[rel] ?? 0) + 1;
      }
    }
  }
  return { secretReads, wholeEnv };
}

const sortedEntries = (reads: Reads) => Object.fromEntries(Object.entries(reads).sort(([a], [b]) => a.localeCompare(b)));

describe("secret env var read ratchet", () => {
  const { secretReads, wholeEnv } = inventory();

  it.each(SECRET_ENV_NAMES)("%s is read only where the allowlist says (exact match: shrink the list when you remove a read)", (name) => {
    expect(sortedEntries(secretReads[name]!)).toEqual(sortedEntries(ALLOWED_SECRET_READS[name] ?? {}));
  });

  it("process.env is handed whole to other functions only in the listed (encapsulated) modules", () => {
    expect(sortedEntries(wholeEnv)).toEqual(sortedEntries(ALLOWED_WHOLE_ENV_PASSES));
  });

  it("documents the end state: no raw JUPITER_API_KEY reads outside lib/jupiter and lib/config (the review counted 23-24 by grep; one hit was a doc comment)", () => {
    const outside = Object.entries(secretReads.JUPITER_API_KEY!).filter(([file]) => !file.startsWith("lib/jupiter/") && !file.startsWith("lib/config/"));
    expect(outside.reduce((sum, [, count]) => sum + count, 0)).toBe(0);
  });
});

describe("scanEnvReads (the scanner itself)", () => {
  it("finds direct, element, parameter-style and whole-env reads but ignores comments and strings", () => {
    const reads = scanEnvReads([
      "const a = process.env.JUPITER_API_KEY;",
      "const b = process.env['SOLAMI_API_KEY'];",
      "const c = env.SOLANA_RPC_URL;",
      "const d = options.env.SOLAMI_DATA_API_KEY;",
      "const e = foo(process.env);",
      "// process.env.JUPITER_API_KEY in a comment",
      "const s = 'process.env.JUPITER_API_KEY in a string';",
      "const f = process.env as Record<string, string>;",
    ].join("\n"));
    expect(reads.map((read) => read.name)).toEqual(["JUPITER_API_KEY", "SOLAMI_API_KEY", "SOLANA_RPC_URL", "SOLAMI_DATA_API_KEY", "*", "*"]);
  });

  it("finds destructured reads", () => {
    expect(scanEnvReads("const { JUPITER_API_KEY, SOLAMI_API_KEY: key } = process.env;").map((read) => read.name))
      .toEqual(["JUPITER_API_KEY", "SOLAMI_API_KEY"]);
  });

  it("an `env.X` read on an unrelated identifier is not counted", () => {
    expect(scanEnvReads("const a = environment.JUPITER_API_KEY; const b = config.JUPITER_API_KEY;")).toEqual([]);
  });
});
