import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import { fakeEvmDescriptor, fakeEvmModule, fakeSolanaDescriptor, fakeSolanaModule } from "./__contract__/testing/fake-dex";
import { DEX_DESCRIPTORS } from "./descriptors";
import { bpsFeeStrategy, NO_FEE_POLICY } from "./fees";
import { DEX_MODULES } from "./modules";
import { createDexDescriptorRegistry, createDexRegistry } from "./registry";
import { DEX_IDS, normalizeDexId } from "./types";

describe("DEX ids", () => {
  it("has one canonical spelling and accepts the legacy RHC alias", () => {
    expect(DEX_IDS).toEqual(["raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc"]);
    expect(normalizeDexId("uniswap-v4-rhc")).toBe("uniswap-v4-rhc");
    expect(normalizeDexId("rhc-uniswap-v4")).toBe("uniswap-v4-rhc");
    expect(normalizeDexId("toString")).toBeNull();
    expect(normalizeDexId("")).toBeNull();
  });
});

const DEX_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every registered DEX must run the shared contract suite from `src/lib/dex/<id>/<id>.contract.test.ts`. */
function missingContractSuites(ids: readonly string[], dir = DEX_DIR): string[] {
  return ids.flatMap((id) => {
    const file = join(dir, id, `${id}.contract.test.ts`);
    if (!existsSync(file)) return [`${id}: missing src/lib/dex/${id}/${id}.contract.test.ts`];
    const source = readFileSync(file, "utf8");
    const imports = /from\s+["'](?:\.\.\/__contract__\/dex-contract|@\/lib\/dex\/__contract__\/dex-contract)["']/.test(source);
    return imports && /\bdescribeDexContract\s*\(/.test(source) ? [] : [`${id}: ${id}.contract.test.ts does not call describeDexContract`];
  });
}

describe("DEX registry", () => {
  it("client descriptors and server modules name the same DEXes", () => {
    expect(DEX_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual(DEX_MODULES.map((entry) => entry.descriptor.id));
  });

  it("runs the shared contract suite for every registered DEX", () => {
    expect(missingContractSuites(DEX_MODULES.map((entry) => entry.descriptor.id))).toEqual([]);
  });

  it("reports a registered DEX without a contract suite", () => {
    expect(missingContractSuites(["orca-whirlpool"])).toEqual(["orca-whirlpool: missing src/lib/dex/orca-whirlpool/orca-whirlpool.contract.test.ts"]);
    const dir = mkdtempSync(join(tmpdir(), "dex-contract-"));
    try {
      mkdirSync(join(dir, "meteora-dlmm"));
      writeFileSync(join(dir, "meteora-dlmm", "meteora-dlmm.contract.test.ts"), "import { it } from \"vitest\";\nit.skip(\"later\", () => {});\n");
      expect(missingContractSuites(["meteora-dlmm"], dir)).toEqual(["meteora-dlmm: meteora-dlmm.contract.test.ts does not call describeDexContract"]);
      writeFileSync(join(dir, "meteora-dlmm", "meteora-dlmm.contract.test.ts"), "import { describeDexContract } from \"../__contract__/dex-contract\";\ndescribeDexContract(meteoraModule, fixtures);\n");
      expect(missingContractSuites(["meteora-dlmm"], dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("looks DEXes up by canonical or legacy id and merges per-position overrides", async () => {
    const blocked = { supported: false, reason: "Only the owner can close this position" } as const;
    const evm = { ...fakeEvmDescriptor, positionCapabilities: (position: UnifiedPosition) => (position.nativeId === "7" ? { withdraw: blocked } : {}) };
    const registry = createDexRegistry([fakeSolanaModule, { ...fakeEvmModule, descriptor: evm }]);
    expect(registry.descriptorFor("rhc-uniswap-v4")).toBe(evm);
    expect(registry.descriptorFor("orca-whirlpool")).toBeNull();
    expect(await registry.adapterFor("orca-whirlpool")).toBeNull();
    expect((await registry.adapterFor("meteora-dlmm"))?.descriptor).toBe(fakeSolanaDescriptor);
    const position = { source: "rhc-uniswap-v4", nativeId: "7" } as UnifiedPosition;
    expect(registry.capabilitiesFor(position)?.withdraw).toBe(blocked);
    expect(registry.capabilitiesFor({ ...position, nativeId: "8" })).toBe(evm.capabilities);
    expect(registry.capabilitiesFor({ ...position, source: "orca-whirlpool" })).toBeNull();
    expect(registry.poolSources()).toEqual([]);
  });

  it("refuses duplicate ids, invalid fee policies and mismatched pool sources", () => {
    expect(() => createDexDescriptorRegistry([fakeSolanaDescriptor, fakeSolanaDescriptor])).toThrow(/registered twice/);
    const badFees = { ...fakeEvmDescriptor, meta: { ...fakeEvmDescriptor.meta, feePolicy: { ...NO_FEE_POLICY, open: { kind: "swap-input-bps", bps: 101 } } } } as typeof fakeEvmDescriptor;
    expect(() => createDexDescriptorRegistry([badFees])).toThrow(/101 bps/);
    const poolSource = { id: "raydium-clmm" } as never;
    expect(() => createDexRegistry([{ ...fakeSolanaModule, poolSource }])).toThrow(/different id/);
  });
});

describe("fee strategy hook", () => {
  it("charges each op by its declared rule, so a policy change is data only", () => {
    const strategy = bpsFeeStrategy({ ...NO_FEE_POLICY, open: { kind: "swap-input-bps", bps: 10 }, compound: { kind: "harvest-bps", bps: 10 } });
    expect(strategy.feeFor("open", 1_000_000n)).toBe(1_000n);
    expect(strategy.feeFor("compound", 999n)).toBe(0n);
    expect(strategy.feeFor("claim", 1_000_000n)).toBe(0n);
    expect(strategy.feeFor("open", -5n)).toBe(0n);
    expect(bpsFeeStrategy(NO_FEE_POLICY).feeFor("withdrawUsdc", 10n ** 12n)).toBe(0n);
  });
});
