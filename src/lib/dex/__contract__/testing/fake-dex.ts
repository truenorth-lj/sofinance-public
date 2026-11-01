/**
 * In-memory DEXes used only to prove the contract suite itself: one Solana DEX shaped like a bin-based DLMM (multi-step
 * open, refundable rent, a range cap) and one EVM DEX shaped like Uniswap v4 on Robinhood Chain (full withdraw only,
 * no compound / add / claim). Neither touches the network.
 */
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { NOT_AVAILABLE_MESSAGE, SUPPORTED, unsupported, type PositionKey, type UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter, OpenQuote, OpenRequest, StepContext, StepResult } from "../../adapter";
import { DexError, DexUnsupportedError } from "../../errors";
import { bpsFeeStrategy, NO_FEE_POLICY } from "../../fees";
import type { DexModule } from "../../registry";
import type { DexDescriptor, FeePolicy } from "../../types";

export const FAKE_SOLANA_OWNER = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
export const FAKE_EVM_OWNER = "0x00000000000000000000000000000000000000aa";
/** The only contract the fake EVM DEX calls (stands in for the PositionManager). */
export const FAKE_EVM_TARGET = `0x${"2".repeat(40)}` as const;

const swapFee: FeePolicy = Object.freeze({
  ...NO_FEE_POLICY,
  open: { kind: "swap-input-bps", bps: 10 },
  add: { kind: "swap-input-bps", bps: 10 },
  withdrawUsdc: { kind: "swap-output-bps", bps: 10 },
});

export const fakeSolanaDescriptor: DexDescriptor = Object.freeze({
  id: "meteora-dlmm",
  chain: "solana",
  displayName: "Fake bin DEX",
  meta: {
    rangeUnit: "bin", maxRangeUnitsPerPosition: 70, rangeUnitBounds: { min: -443_636, max: 443_636 }, openSteps: { min: 2, max: 2 },
    rent: { refundableOnClose: true, disclosure: "about 0.042 SOL, refunded when you fully withdraw" },
    approvals: "none", positionCosigner: "ephemeral-keypair", addressCase: "exact", feePolicy: swapFee, depositInputs: { poolTokens: true, extra: [{ id: "USDC", symbol: "USDC", decimals: 6 }] },
  },
  capabilities: {
    compound: SUPPORTED, performance: SUPPORTED, deposit: SUPPORTED, withdraw: { supported: true, partial: true }, withdrawOutputs: ["pool-tokens"],
    exitPreview: { supported: true, output: "pool-tokens" }, rangeDisplay: "price", manualAdd: false, signer: "solana-wallet",
    open: SUPPORTED, claim: SUPPORTED,
  },
} satisfies DexDescriptor);

export const fakeEvmDescriptor: DexDescriptor = Object.freeze({
  id: "uniswap-v4-rhc",
  chain: "robinhood-chain",
  displayName: "Fake EVM DEX",
  meta: {
    rangeUnit: "tick", maxRangeUnitsPerPosition: null, rangeUnitBounds: { min: -443_636, max: 443_636 }, openSteps: { min: 1, max: 3 }, rent: null,
    approvals: "erc20-permit2", positionCosigner: "none", addressCase: "lowercase",
    feePolicy: { ...NO_FEE_POLICY, open: { kind: "swap-output-bps", bps: 10 } }, depositInputs: { poolTokens: true, extra: [] },
  },
  capabilities: {
    compound: unsupported(NOT_AVAILABLE_MESSAGE), performance: unsupported(NOT_AVAILABLE_MESSAGE),
    deposit: unsupported(NOT_AVAILABLE_MESSAGE), withdraw: { supported: true, partial: false }, withdrawOutputs: ["pool-tokens"],
    exitPreview: { supported: true, output: "pool-tokens" }, rangeDisplay: "tick", manualAdd: true, signer: "evm-wallet",
    open: unsupported(NOT_AVAILABLE_MESSAGE), claim: unsupported(NOT_AVAILABLE_MESSAGE),
  },
} satisfies DexDescriptor);

function emptySolanaTx(owner: string): string {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })];
  const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

const solanaPosition = (owner: string, nativeId: string): UnifiedPosition => ({
  key: `meteora-dlmm:${nativeId}`, source: "meteora-dlmm", chain: "solana", nativeId, poolId: "FakePool1111111111111111111111111111111111",
  tokenA: { id: "A", symbol: "A", decimals: 6 }, tokenB: { id: "B", symbol: "B", decimals: 8 },
  range: { mode: "price", lower: 0.99, upper: 1.01, current: 1 }, rangeStatus: "in", liquidity: "1000", valueUsd: 1, native: { owner },
});

export function fakeSolanaAdapter(): DexAdapter {
  const step = (owner: string, context: StepContext, of: number, label: string): StepResult => ({
    step: context.step, of, label, done: context.step === of,
    prepared: { kind: "solana-tx", transaction: emptySolanaTx(owner), lastValidBlockHeight: 1 },
  });
  const unitsOf = (request: OpenRequest) => (request.range.kind === "units" ? request.range.upper - request.range.lower + 1 : request.range.presetId === "wide" ? 200 : 60);
  const quote = async (request: OpenRequest): Promise<OpenQuote> => {
    const units = unitsOf(request);
    return {
      poolId: request.poolId, range: { lowerPrice: 0.99, upperPrice: 1.01, units }, steps: 2,
      rent: { refundableLamports: "41899840", nonRefundableLamports: "0" },
      platformFeeRaw: fees.feeFor("open", BigInt(request.input.amountRaw)).toString(),
      ...(units > 70 ? { blockedReason: "Not available to open yet: this range is wider than one position allows." } : {}),
    };
  };
  const fees = bpsFeeStrategy(fakeSolanaDescriptor.meta.feePolicy);
  const owned = new Map<PositionKey, string>();
  /** The position's recorded owner, which must be the requesting wallet. */
  const holder = (key: PositionKey, owner: string) => {
    const recorded = owned.get(key) ?? FAKE_SOLANA_OWNER;
    if (recorded !== owner) throw new DexError("POSITION_NOT_FOUND", "That position belongs to another wallet.");
    return recorded;
  };
  return {
    descriptor: fakeSolanaDescriptor,
    fees,
    async listPositions(owner) {
      const positions = [solanaPosition(owner, "Pos1")];
      for (const position of positions) owned.set(position.key, owner);
      return positions;
    },
    async readPosition(key) { return owned.has(key) ? solanaPosition(owned.get(key)!, key.split(":")[1]!) : null; },
    async performance(key) {
      return { key, depositedUsd: 1, withdrawnUsd: 0, feesClaimedUsd: 0, feesUnclaimedUsd: 0, currentValueUsd: 1, pnlUsd: 0, partial: false };
    },
    quoteOpen: quote,
    async previewWithdraw() { return { outputs: [], platformFeeRaw: "0" }; },
    async prepareOpen(request, context) {
      const q = await quote(request);
      if (q.blockedReason) throw new DexError("RANGE_UNSUPPORTED", q.blockedReason);
      return step(request.owner, context, 2, context.step === 1 ? "Create position" : "Deposit");
    },
    async prepareAdd(key, owner, _input, context) { return step(holder(key, owner), context, 1, "Add liquidity"); },
    async prepareWithdraw(key, owner, request, context) {
      const held = holder(key, owner);
      if (request.output !== "pool-tokens") throw new DexUnsupportedError("Withdrawing to that token isn't available for this pool yet");
      return step(held, context, 1, "Withdraw");
    },
    async prepareClaim(key, owner, context) { return step(holder(key, owner), context, 1, "Claim fees"); },
    async prepareCompound(key, owner, context) { return step(holder(key, owner), context, 1, "Compound"); },
  };
}

export function fakeEvmAdapter(): DexAdapter {
  const position: UnifiedPosition = {
    key: "uniswap-v4-rhc:42", source: "uniswap-v4-rhc", chain: "robinhood-chain", nativeId: "42", poolId: `0x${"1".repeat(64)}`,
    tokenA: { id: "0xa", symbol: "A", decimals: 18 }, tokenB: { id: "0xb", symbol: "B", decimals: 6 },
    range: { mode: "tick", tickLower: -60, tickUpper: 60, currentTick: 0 }, rangeStatus: "in", liquidity: "5", native: {},
  };
  const no = async (): Promise<never> => { throw new DexUnsupportedError(); };
  return {
    descriptor: fakeEvmDescriptor,
    fees: bpsFeeStrategy(fakeEvmDescriptor.meta.feePolicy),
    async listPositions() { return [position]; },
    async readPosition(key) { return key === position.key ? position : null; },
    performance: no,
    quoteOpen: no,
    async previewWithdraw() { return { outputs: [], platformFeeRaw: "0" }; },
    prepareOpen: no,
    prepareAdd: no,
    async prepareWithdraw(key, owner, request, context) {
      if (key !== position.key || owner.toLowerCase() !== FAKE_EVM_OWNER) throw new DexError("POSITION_NOT_FOUND", "That position belongs to another wallet.");
      if (request.fraction !== 1) throw new DexUnsupportedError("Partial withdraw isn't available for this pool yet");
      if (request.output !== "pool-tokens") throw new DexUnsupportedError("Withdrawing to that token isn't available for this pool yet");
      return { step: context.step, of: 1, label: "Close position", done: true, prepared: { kind: "evm-tx", chainId: 4663, to: FAKE_EVM_TARGET, data: "0x", value: "0" } };
    },
    prepareClaim: no,
    prepareCompound: no,
  };
}

export const fakeSolanaModule: DexModule = { descriptor: fakeSolanaDescriptor, adapter: async () => fakeSolanaAdapter() };
export const fakeEvmModule: DexModule = { descriptor: fakeEvmDescriptor, adapter: async () => fakeEvmAdapter() };
