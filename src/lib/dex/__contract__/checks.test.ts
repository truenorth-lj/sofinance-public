import { describe, expect, it } from "vitest";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { StepResult } from "../adapter";
import {
  descriptorContractProblems, forbiddenFetchProblems, positionContractProblems, quoteContractProblems, stepContractProblems,
} from "./checks";
import { FAKE_SOLANA_OWNER, fakeEvmDescriptor, fakeSolanaAdapter, fakeSolanaDescriptor } from "./testing/fake-dex";

describe("contract checks catch broken implementations", () => {
  it("accepts the reference descriptors", () => {
    expect(descriptorContractProblems(fakeSolanaDescriptor)).toEqual([]);
    expect(descriptorContractProblems(fakeEvmDescriptor)).toEqual([]);
  });

  it("rejects a descriptor whose signer, rent, cap or fees do not fit its chain", () => {
    const broken = {
      ...fakeEvmDescriptor,
      id: "rhc-uniswap-v4",
      capabilities: { ...fakeEvmDescriptor.capabilities, signer: "solana-wallet", claim: { supported: false, reason: " " } },
      meta: { ...fakeEvmDescriptor.meta, rangeUnit: "bin", rent: fakeSolanaDescriptor.meta.rent, feePolicy: { ...fakeEvmDescriptor.meta.feePolicy, claim: { kind: "harvest-bps", bps: 500 } } },
    } as unknown as typeof fakeEvmDescriptor;
    const problems = descriptorContractProblems(broken).join("\n");
    expect(problems).toMatch(/not a canonical DexId/);
    expect(problems).toMatch(/signer solana-wallet does not match/);
    expect(problems).toMatch(/only Solana DEXes declare rent/);
    expect(problems).toMatch(/bin-based DEXes must declare/);
    expect(problems).toMatch(/claim: 500 bps is outside/);
    expect(problems).toMatch(/harvest fees only apply to compound/);
    expect(problems).toMatch(/claim: an unsupported capability needs a reason/);
  });

  it("rejects a position from another DEX or with a malformed key", async () => {
    const [position] = await fakeSolanaAdapter().listPositions(FAKE_SOLANA_OWNER);
    const broken: UnifiedPosition = { ...position!, key: "meteora-dlmm:other", chain: "robinhood-chain", liquidity: "1.5", range: { mode: "tick", tickLower: 0, tickUpper: 1, currentTick: 0 } };
    expect(positionContractProblems(fakeSolanaDescriptor, broken)).toHaveLength(4);
    expect(positionContractProblems(fakeEvmDescriptor, position!)[0]).toMatch(/is not uniswap-v4-rhc/);
  });

  it("rejects a quote over the range cap without a reason, or with rent on a no-rent DEX", () => {
    const quote = { poolId: "p", range: { lowerPrice: 1, upperPrice: 2, units: 200 }, steps: 3, rent: null, platformFeeRaw: "x" };
    const problems = quoteContractProblems(fakeSolanaDescriptor, quote).join("\n");
    expect(problems).toMatch(/steps 3 outside 2..2/);
    expect(problems).toMatch(/rent must be present/);
    expect(problems).toMatch(/exceeds the 70 cap/);
    expect(problems).toMatch(/platformFeeRaw/);
  });

  it("rejects steps of the wrong kind, order or payer", async () => {
    const good = await fakeSolanaAdapter().prepareOpen(
      { poolId: "p", owner: FAKE_SOLANA_OWNER, range: { kind: "preset", presetId: "standard" }, input: { token: "USDC", amountRaw: "1" }, slippageBps: 50 },
      { step: 1, priorSignatures: [] },
    );
    expect(stepContractProblems(fakeSolanaDescriptor, good, FAKE_SOLANA_OWNER, { min: 2, max: 2 })).toEqual([]);
    expect(stepContractProblems(fakeSolanaDescriptor, good, "11111111111111111111111111111111")).toContain("fee payer must be the owner");
    const evm: StepResult = { step: 2, of: 1, label: "", done: false, prepared: { kind: "evm-tx", chainId: 1, to: "0x0", data: "0x", value: "0" } };
    expect(stepContractProblems(fakeSolanaDescriptor, evm, FAKE_SOLANA_OWNER).join("\n")).toMatch(/out of order[\s\S]*label[\s\S]*prepared a evm-tx step/);
    expect(stepContractProblems(fakeEvmDescriptor, good, FAKE_SOLANA_OWNER)).toContain("an EVM DEX prepared a Solana step");
  });

  it("flags GeckoTerminal reads", () => {
    expect(forbiddenFetchProblems(["https://api.geckoterminal.com/api/v2/x", "https://dlmm.datapi.meteora.ag/pools/x", "not a url"])).toEqual(["read called api.geckoterminal.com"]);
  });
});
