import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deployTarget, isOrcaDiscoveryEnabled, ORCA_DISCOVERY_ENABLED } from "./protocol-flags";

describe("ORCA_DISCOVERY_ENABLED", () => {
  it("is a code constant that is OFF in production", () => {
    expect(ORCA_DISCOVERY_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(ORCA_DISCOVERY_ENABLED)).toBe(true);
    expect(isOrcaDiscoveryEnabled("production")).toBe(false);
    expect(isOrcaDiscoveryEnabled("preview")).toBe(true);
  });
  it("treats anything that is not an explicit Vercel preview/development as production", () => {
    for (const env of [undefined, "", "production", "staging", "PREVIEW"]) expect(deployTarget(env)).toBe("production");
    expect(deployTarget("preview")).toBe("preview");
    expect(deployTarget("development")).toBe("development");
  });
  it("is not driven by a SOFINANCE_* env var", () => {
    const source = readFileSync(join(__dirname, "protocol-flags.ts"), "utf8");
    expect(source.match(/process\.env\.[A-Z_]+/g)).toEqual(["process.env.VERCEL_ENV"]);
  });
});

describe("Raydium discovery is untouched by Orca", () => {
  it("the /api/rwa-pairs feed never imports Orca discovery or the protocol flag", () => {
    for (const file of ["src/lib/rwa-pairs.ts", "src/lib/rwa-store.ts", "src/lib/rwa-postgres-store.ts", "src/app/api/rwa-pairs/route.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/orca|protocol-flags|protocol-pools/i);
    }
  });
});
