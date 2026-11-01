import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { StepResult } from "../adapter";
import { DexError, DexUnsupportedError } from "../errors";
import { NO_FEE_POLICY } from "../fees";
import {
  descriptorContractProblems, forbiddenFetchProblems, positionContractProblems, quoteContractProblems, stepContractProblems,
  thrownErrorProblems,
} from "./checks";
import { missingFixtureProblems } from "./dex-contract";
import {
  FAKE_EVM_TARGET, FAKE_SOLANA_OWNER, fakeEvmDescriptor, fakeEvmModule, fakeSolanaAdapter, fakeSolanaDescriptor, fakeSolanaModule,
} from "./testing/fake-dex";

const FEE_WALLET = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
/** What every Solana fixture must provide (the fake DEX charges an open fee, so a fee wallet is required). */
const SOLANA_FACTS = { feeWallet: FEE_WALLET.toBase58(), mintPrograms: {} } as const;
const EVM_FEE_WALLET = `0x${"e".repeat(40)}`;

/** A one-step Solana tx; adds a 200k compute-unit limit unless the instructions set their own. */
function solanaStep(instructions: TransactionInstruction[], extraSigners = 0, { budget = true } = {}): StepResult {
  const owner = new PublicKey(FAKE_SOLANA_OWNER);
  const signerIxs = Array.from({ length: extraSigners }, () => SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: owner, lamports: 0 }));
  const hasBudget = instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  const budgetIxs = budget && !hasBudget ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })] : [];
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: [...budgetIxs, ...instructions, ...signerIxs] }).compileToV0Message();
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
    expect(stepContractProblems(fakeSolanaDescriptor, good, FAKE_SOLANA_OWNER, { ...SOLANA_FACTS, expectedSteps: { min: 2, max: 2 } })).toEqual([]);
    expect(stepContractProblems(fakeSolanaDescriptor, good, "11111111111111111111111111111111", SOLANA_FACTS)).toContain("fee payer must be the owner");
    const evm: StepResult = { step: 2, of: 1, label: "", done: false, prepared: { kind: "evm-tx", chainId: 1, to: "0x0", data: "0x", value: "0" } };
    expect(stepContractProblems(fakeSolanaDescriptor, evm, FAKE_SOLANA_OWNER, SOLANA_FACTS).join("\n")).toMatch(/out of order[\s\S]*label[\s\S]*prepared a evm-tx step/);
    expect(stepContractProblems(fakeEvmDescriptor, good, FAKE_SOLANA_OWNER, { feeWallet: EVM_FEE_WALLET })).toContain("an EVM DEX prepared a Solana step");
  });

  it("requires a compute-unit limit of at most 1.4M and no signers beyond the owner and one declared cosigner", () => {
    const tooMuch = solanaStep([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 })]);
    expect(stepContractProblems(fakeSolanaDescriptor, tooMuch, FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual(["compute unit limit 1400001 > 1400000"]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })], 1), FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual([]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([], 0, { budget: false }), FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual(["missing a ComputeBudget setComputeUnitLimit instruction"]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([], 2), FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual(["2 signer(s) besides the owner; ephemeral-keypair allows 1"]);
    const noCosigner = { ...fakeSolanaDescriptor, meta: { ...fakeSolanaDescriptor.meta, positionCosigner: "none" } } as typeof fakeSolanaDescriptor;
    expect(stepContractProblems(noCosigner, solanaStep([], 1), FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual(["1 signer(s) besides the owner; none allows 0"]);
  });

  it("requires the fee wallet when the policy charges and mint programs for every Solana DEX", () => {
    const step = solanaStep([]);
    expect(stepContractProblems(fakeSolanaDescriptor, step, FAKE_SOLANA_OWNER, { mintPrograms: {} })).toEqual(["the fee policy charges a fee but no feeWallet was given to check against"]);
    expect(stepContractProblems(fakeSolanaDescriptor, step, FAKE_SOLANA_OWNER, { feeWallet: SOLANA_FACTS.feeWallet })).toEqual(["mintPrograms is required for a Solana DEX (token program of every mint the steps touch)"]);
    const freeDescriptor = { ...fakeSolanaDescriptor, meta: { ...fakeSolanaDescriptor.meta, feePolicy: NO_FEE_POLICY } } as typeof fakeSolanaDescriptor;
    expect(stepContractProblems(freeDescriptor, step, FAKE_SOLANA_OWNER, { mintPrograms: {} })).toEqual([]);
    const evmStep: StepResult = { step: 1, of: 1, label: "Withdraw", done: true, prepared: { kind: "evm-tx", chainId: 4663, to: FAKE_EVM_TARGET, data: "0x", value: "0" } };
    expect(stepContractProblems(fakeEvmDescriptor, evmStep, "0xaa", { evmAllowedTargets: [FAKE_EVM_TARGET] })).toEqual(["the fee policy charges a fee but no feeWallet was given to check against"]);
  });

  it("rejects direct fee-wallet instructions, unrecognised SOL transfers and ATAs on an undeclared or wrong token program", () => {
    const owner = new PublicKey(FAKE_SOLANA_OWNER);
    const pay = solanaStep([SystemProgram.transfer({ fromPubkey: owner, toPubkey: FEE_WALLET, lamports: 1 })]);
    expect(stepContractProblems(fakeSolanaDescriptor, pay, FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual([
      "an instruction pays or creates an account for the fee wallet directly",
      `SystemProgram transfer to unrecognised account ${FEE_WALLET.toBase58()}`,
    ]);

    const stranger = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
    const toStranger = solanaStep([SystemProgram.transfer({ fromPubkey: owner, toPubkey: stranger, lamports: 1 })]);
    expect(stepContractProblems(fakeSolanaDescriptor, toStranger, FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual([`SystemProgram transfer to unrecognised account ${stranger.toBase58()}`]);
    expect(stepContractProblems(fakeSolanaDescriptor, toStranger, FAKE_SOLANA_OWNER, { ...SOLANA_FACTS, systemTransferRecipients: [stranger.toBase58()] })).toEqual([]);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
    const wrapSol = solanaStep([SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: 1 })]);
    expect(stepContractProblems(fakeSolanaDescriptor, wrapSol, FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual([]);
    const fresh = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey;
    const fundNew = solanaStep([
      SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: fresh, lamports: 1, space: 0, programId: SystemProgram.programId }),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: fresh, lamports: 1 }),
    ], 0);
    expect(stepContractProblems(fakeSolanaDescriptor, fundNew, FAKE_SOLANA_OWNER, SOLANA_FACTS).filter((problem) => problem.startsWith("SystemProgram"))).toEqual([]);

    const mint = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
    const ataIx = (program: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(mint, owner, true, program), owner, mint, program);
    const facts = { ...SOLANA_FACTS, mintPrograms: { [mint.toBase58()]: "token-2022" } } as const;
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ataIx(TOKEN_2022_PROGRAM_ID)]), FAKE_SOLANA_OWNER, facts)).toEqual([]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ataIx(TOKEN_PROGRAM_ID)]), FAKE_SOLANA_OWNER, facts)).toEqual([`ATA for ${mint.toBase58()} uses the wrong token program (mint is token-2022)`]);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([ataIx(TOKEN_PROGRAM_ID)]), FAKE_SOLANA_OWNER, SOLANA_FACTS)).toEqual([`ATA for ${mint.toBase58()}: mint has no declared token program in mintPrograms`]);
    const mismatched = createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID), owner, mint, TOKEN_2022_PROGRAM_ID);
    expect(stepContractProblems(fakeSolanaDescriptor, solanaStep([mismatched]), FAKE_SOLANA_OWNER, facts).join("\n")).toMatch(/is not derived from its owner, mint and token program/);
  });

  it("rejects EVM calls outside the allowlist, to the fee wallet, and approvals to anyone but Permit2", () => {
    const permit2 = `0x${"3".repeat(40)}`;
    const step = (to: `0x${string}`, data: `0x${string}`): StepResult => ({ step: 1, of: 1, label: "Approve", done: true, prepared: { kind: "evm-tx", chainId: 4663, to, data, value: "0" } });
    const approve = (spender: string) => `0x095ea7b3${spender.slice(2).padStart(64, "0")}${"f".repeat(64)}` as `0x${string}`;
    const options = { evmAllowedTargets: [FAKE_EVM_TARGET.toUpperCase()], evmApproveSpender: permit2, feeWallet: EVM_FEE_WALLET };
    expect(stepContractProblems(fakeEvmDescriptor, step(FAKE_EVM_TARGET, approve(permit2)), "0xaa", options)).toEqual([]);
    expect(stepContractProblems(fakeEvmDescriptor, step(`0x${"4".repeat(40)}`, "0x"), "0xaa", options)).toEqual([`evm-tx calls 0x${"4".repeat(40)}, which is not an allowlisted contract`]);
    expect(stepContractProblems(fakeEvmDescriptor, step(FAKE_EVM_TARGET, approve(`0x${"5".repeat(40)}`)), "0xaa", options)).toEqual([`approve names spender 0x${"5".repeat(40)}, not Permit2`]);
    expect(stepContractProblems(fakeEvmDescriptor, step(EVM_FEE_WALLET as `0x${string}`, "0x"), "0xaa", options)).toEqual([
      "evm-tx pays the fee wallet directly",
      `evm-tx calls ${EVM_FEE_WALLET}, which is not an allowlisted contract`,
    ]);
  });

  it("only accepts DexError from adapters", () => {
    expect(thrownErrorProblems(new DexUnsupportedError())).toEqual([]);
    expect(thrownErrorProblems(new DexError("UPSTREAM", "RPC unavailable"))).toEqual([]);
    expect(thrownErrorProblems(new TypeError("x is undefined"))).toEqual(["threw TypeError instead of a DexError"]);
  });

  it("fails (does not skip) when a supported capability, fee or token-program fixture is missing", () => {
    const owner = FAKE_SOLANA_OWNER;
    expect(missingFixtureProblems(fakeSolanaModule, { owner, expectedPositionKeys: [] })).toEqual([
      "open is supported but fixtures.open is missing",
      "deposit, withdraw, claim, compound, performance supported but fixtures.positionKey is missing",
      "deposit is supported but fixtures.addInput (or fixtures.open) is missing",
      "the fee policy charges a fee but fixtures.feeWallet is missing",
      "Solana DEX without fixtures.mintPrograms (token program of every mint the steps touch)",
    ]);
    const open = { request: { poolId: "p", owner, range: { kind: "preset", presetId: "standard" }, input: { token: "USDC", amountRaw: "1" }, slippageBps: 50 }, expectedSteps: 2 } as const;
    expect(missingFixtureProblems(fakeSolanaModule, { owner, expectedPositionKeys: [], open, positionKey: "meteora-dlmm:Pos1", ...SOLANA_FACTS }))
      .toEqual(["the open fee rule is swap-input-bps but fixtures.open.expectedFeeBaseRaw is missing"]);
    expect(missingFixtureProblems(fakeEvmModule, { owner, expectedPositionKeys: [] })).toEqual([
      "withdraw supported but fixtures.positionKey is missing",
      "the fee policy charges a fee but fixtures.feeWallet is missing",
    ]);
    expect(missingFixtureProblems({ descriptor: fakeEvmDescriptor }, { owner, expectedPositionKeys: [], positionKey: "uniswap-v4-rhc:1", feeWallet: EVM_FEE_WALLET })).toEqual(["no server adapter registered"]);
  });

  it("flags GeckoTerminal reads", () => {
    expect(forbiddenFetchProblems(["https://api.geckoterminal.com/api/v2/x", "https://dlmm.datapi.meteora.ag/pools/x", "not a url"])).toEqual(["read called api.geckoterminal.com"]);
  });
});
