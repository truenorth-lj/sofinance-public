import { describeDexContract } from "./dex-contract";
import { FAKE_EVM_OWNER, FAKE_SOLANA_OWNER, fakeEvmModule, fakeSolanaModule } from "./testing/fake-dex";

// The suite run against the in-memory DEXes: proves the harness end to end. Real DEXes register the same way.
describeDexContract(fakeSolanaModule, {
  owner: FAKE_SOLANA_OWNER,
  expectedPositionKeys: ["meteora-dlmm:Pos1"],
  open: { request: { poolId: "FakePool", owner: FAKE_SOLANA_OWNER, range: { kind: "preset", presetId: "standard" }, input: { token: "USDC", amountRaw: "1000000" }, slippageBps: 50 }, expectedSteps: 2 },
  positionKey: "meteora-dlmm:Pos1",
});

describeDexContract(fakeSolanaModule, {
  owner: FAKE_SOLANA_OWNER,
  expectedPositionKeys: ["meteora-dlmm:Pos1"],
  open: { request: { poolId: "FakePool", owner: FAKE_SOLANA_OWNER, range: { kind: "preset", presetId: "wide" }, input: { token: "USDC", amountRaw: "1000000" }, slippageBps: 50 }, expectedSteps: 2, blocked: true },
});

describeDexContract(fakeEvmModule, {
  owner: FAKE_EVM_OWNER,
  expectedPositionKeys: ["rhc-uniswap-v4:42"],
  positionKey: "rhc-uniswap-v4:42",
});
