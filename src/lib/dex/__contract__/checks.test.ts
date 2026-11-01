import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { StepResult } from "../adapter";
import { DexError, DexUnsupportedError } from "../errors";
import {
  descriptorContractProblems, forbiddenFetchProblems, positionContractProblems, quoteContractProblems, stepContractProblems,
  thrownErrorProblems,
} from "./checks";
import { missingFixtureProblems } from "./dex-contract";
import {
  FAKE_EVM_TARGET, FAKE_SOLANA_OWNER, fakeEvmDescriptor, fakeEvmModule, fakeSolanaAdapter, fakeSolanaDescriptor, fakeSolanaModule,
} from "./testing/fake-dex";

function solanaStep(instructions: TransactionInstruction[], extraSigners = 0): StepResult {
  const owner = new PublicKey(FAKE_SOLANA_OWNER);
  const signerIxs = Array.from({ length: extraSigners }, () => SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: owner, lamports: 0 }));
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: [...instructions, ...signerIxs] }).compileToV0Message();
  return { step: 1, of: 1, label: "Step", done: true, prepared: { kind: "solana-tx", transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), lastValidBlockHeight: 1 } };
}

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

  it("requires the canonical id as position.source (no legacy alias)", () => {
    const legacy = { key: "rhc-uniswap-v4:42", source: "rhc-uniswap-v4", chain: "robinhood-chain", nativeId: "42", poolId: "0x1", liquidity: "1", range: { mode: "tick", tickLower: 0, tickUpper: 1, currentTick: 0 } } as unknown as UnifiedPosition;
    expect(positionContractProblems(fakeEvmDescriptor, legacy)).toEqual(["position rhc-uniswap-v4:42: source rhc-uniswap-v4 is not uniswap-v4-rhc"]);
    expect(positionContractProblems(fakeEvmDescriptor, { ...legacy, key: "uniswap-v4-rhc:42", source: "uniswap-v4-rhc" })).toEqual([]);
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

  it("rejects a compute budget over 1.4M and signers other than the owner and one declared cosigner", () => {
    const tooMuch = solanaStep([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 })]);
    expect(stepContractProblems(fakeSolanaDescriptor, tooMuch, FAKE_SOLANA_OWNER)).toEqual(["compute unit limit 1400001 > 1400000"]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })], 1), FAKE_SOLANA_OWNER)).toEqual([]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([], 2), FAKE_SOLANA_OWNER)).toEqual(["2 signer(s) besides the owner; ephemeral-keypair allows 1"]);
    const noCosigner = { ...fakeSolanaDescriptor, meta: { ...fakeSolanaDescriptor.meta, positionCosigner: "none" } } as typeof fakeSolanaDescriptor;
    expect(stepContractProblems(noCosigner, solanaStep([], 1), FAKE_SOLANA_OWNER)).toEqual(["1 signer(s) besides the owner; none allows 0"]);
  });

  it("rejects direct fee-wallet instructions and ATAs on the wrong token program", () => {
    const owner = new PublicKey(FAKE_SOLANA_OWNER);
    const feeWallet = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
    const pay = solanaStep([SystemProgram.transfer({ fromPubkey: owner, toPubkey: feeWallet, lamports: 1 })]);
    expect(stepContractProblems(fakeSolanaDescriptor, pay, FAKE_SOLANA_OWNER, { feeWallet: feeWallet.toBase58() })).toEqual(["an instruction pays or creates an account for the fee wallet directly"]);
    expect(stepContractProblems(fakeSolanaDescriptor, pay, FAKE_SOLANA_OWNER)).toEqual([]);

    const mint = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
    const ataIx = (program: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(mint, owner, true, program), owner, mint, program);
    const mintPrograms = { [mint.toBase58()]: "token-2022" } as const;
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ataIx(TOKEN_2022_PROGRAM_ID)]), FAKE_SOLANA_OWNER, { mintPrograms })).toEqual([]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ataIx(TOKEN_PROGRAM_ID)]), FAKE_SOLANA_OWNER, { mintPrograms })).toEqual([`ATA for ${mint.toBase58()} uses the wrong token program (mint is token-2022)`]);
    const mismatched = createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID), owner, mint, TOKEN_2022_PROGRAM_ID);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([mismatched]), FAKE_SOLANA_OWNER).join("\n")).toMatch(/is not derived from its owner, mint and token program/);
  });

  it("rejects EVM calls outside the allowlist and approvals to anyone but Permit2", () => {
    const permit2 = `0x${"3".repeat(40)}`;
    const step = (to: `0x${string}`, data: `0x${string}`): StepResult => ({ step: 1, of: 1, label: "Approve", done: true, prepared: { kind: "evm-tx", chainId: 4663, to, data, value: "0" } });
    const approve = (spender: string) => `0x095ea7b3${spender.slice(2).padStart(64, "0")}${"f".repeat(64)}` as `0x${string}`;
    const options = { evmAllowedTargets: [FAKE_EVM_TARGET.toUpperCase()], evmApproveSpender: permit2 };
    expect(stepContractProblems(fakeEvmDescriptor, step(FAKE_EVM_TARGET, approve(permit2)), "0xaa", options)).toEqual([]);
    expect(stepContractProblems(fakeEvmDescriptor, step(`0x${"4".repeat(40)}`, "0x"), "0xaa", options)).toEqual([`evm-tx calls 0x${"4".repeat(40)}, which is not an allowlisted contract`]);
    expect(stepContractProblems(fakeEvmDescriptor, step(FAKE_EVM_TARGET, approve(`0x${"5".repeat(40)}`)), "0xaa", options)).toEqual([`approve names spender 0x${"5".repeat(40)}, not Permit2`]);
  });

  it("only accepts DexError from adapters", () => {
    expect(thrownErrorProblems(new DexUnsupportedError())).toEqual([]);
    expect(thrownErrorProblems(new DexError("UPSTREAM", "RPC unavailable"))).toEqual([]);
    expect(thrownErrorProblems(new TypeError("x is undefined"))).toEqual(["threw TypeError instead of a DexError"]);
  });

  it("fails (does not skip) when a supported capability has no fixture", () => {
    const owner = FAKE_SOLANA_OWNER;
    expect(missingFixtureProblems(fakeSolanaModule, { owner, expectedPositionKeys: [] })).toEqual([
      "open is supported but fixtures.open is missing",
      "deposit, withdraw, claim, compound, performance supported but fixtures.positionKey is missing",
      "deposit is supported but fixtures.addInput (or fixtures.open) is missing",
    ]);
    expect(missingFixtureProblems(fakeEvmModule, { owner, expectedPositionKeys: [] })).toEqual(["withdraw supported but fixtures.positionKey is missing"]);
    expect(missingFixtureProblems({ descriptor: fakeEvmDescriptor }, { owner, expectedPositionKeys: [], positionKey: "uniswap-v4-rhc:1" })).toEqual(["no server adapter registered"]);
  });

  it("flags GeckoTerminal reads", () => {
    expect(forbiddenFetchProblems(["https://api.geckoterminal.com/api/v2/x", "https://dlmm.datapi.meteora.ag/pools/x", "not a url"])).toEqual(["read called api.geckoterminal.com"]);
  });
});
