import { describeDexContract } from "./dex-contract";
import { FAKE_EVM_OWNER, FAKE_EVM_TARGET, FAKE_SOLANA_OWNER, fakeEvmModule, fakeSolanaModule } from "./testing/fake-dex";

// The suite run against the in-memory DEXes: proves the harness end to end. Real DEXes register the same way.
describeDexContract(fakeSolanaModule, {
  owner: FAKE_SOLANA_OWNER,
  expectedPositionKeys: ["meteora-dlmm:Pos1"],
  open: {
    request: { poolId: "FakePool", owner: FAKE_SOLANA_OWNER, range: { kind: "preset", presetId: "standard" }, input: { token: "USDC", amountRaw: "1000000" }, slippageBps: 50 },
    expectedSteps: 2,
    expectedFeeBaseRaw: "1000000",
  },
  blockedOpens: [{ poolId: "FakePool", owner: FAKE_SOLANA_OWNER, range: { kind: "preset", presetId: "wide" }, input: { token: "USDC", amountRaw: "1000000" }, slippageBps: 50 }],
  positionKey: "meteora-dlmm:Pos1",
  stranger: "11111111111111111111111111111113",
  feeWallet: "11111111111111111111111111111112",
  // The fake steps create no token accounts; a real DEX lists every mint it touches (Token-2022 RWA mints included).
  mintPrograms: {},
});

describeDexContract(fakeEvmModule, {
  owner: FAKE_EVM_OWNER,
  expectedPositionKeys: ["uniswap-v4-rhc:42"],
  positionKey: "uniswap-v4-rhc:42",
  stranger: `0x${"b".repeat(40)}`,
  evmAllowedTargets: [FAKE_EVM_TARGET],
  feeWallet: `0x${"e".repeat(40)}`,
});
