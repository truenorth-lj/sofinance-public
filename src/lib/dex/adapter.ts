/**
 * Server-side half of the shared DEX contract (DESIGN.md §1.2). Types only: implementations live in
 * `src/lib/dex/<id>/` and are reached through the registry.
 *
 * Adapters READ and PREPARE. They never sign, send or confirm: the shared transaction pipeline
 * (`src/lib/tx-pipeline/run.ts`: wallet send, the on-chain check after a wallet error such as 4001/5000, confirmation,
 * status) and the EVM wallet flow stay outside this interface and consume `PreparedStep`s.
 */
import type { PositionKey, UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexDescriptor, FeeOp, FeePolicy } from "./types";

export type DexRangeRequest =
  | { kind: "preset"; presetId: string }
  /** Raw protocol units: ticks or bins, per `descriptor.meta.rangeUnit`. Interpreted only by the adapter. */
  | { kind: "units"; lower: number; upper: number };

export type DexDepositInput = {
  /** Token id (mint / ERC-20 address). Which tokens an adapter accepts is its own rule. */
  token: string;
  amountRaw: string;
};

export type OpenRequest = {
  poolId: string;
  owner: string;
  range: DexRangeRequest;
  input: DexDepositInput;
  slippageBps: number;
};

export type RentQuote = {
  /** Set aside now and returned on full withdraw. */
  refundableLamports: string;
  /** Spent for good (e.g. a new shared on-chain account). */
  nonRefundableLamports: string;
};

export type OpenQuote = {
  poolId: string;
  range: { lowerPrice: number; upperPrice: number; units: number };
  steps: number;
  rent: RentQuote | null;
  /** Fee the platform takes on this open, in the input token's raw units. */
  platformFeeRaw: string;
  /** Present when this open cannot proceed, in plain English (e.g. it would need a new shared account). */
  blockedReason?: string;
};

export type ExitPreview = { outputs: { token: string; amountRaw: string }[]; platformFeeRaw: string };

export type PositionPerformance = {
  key: PositionKey;
  depositedUsd: number | null;
  withdrawnUsd: number | null;
  feesClaimedUsd: number | null;
  feesUnclaimedUsd: number | null;
  currentValueUsd: number | null;
  pnlUsd: number | null;
  /** True when some history could not be read (the numbers are a lower bound). */
  partial: boolean;
};

/** One wallet action. A Solana step maps 1:1 onto the tx pipeline's `PreparedTx` after deserialization. */
export type PreparedStep =
  | {
    kind: "solana-tx";
    /** Base64 unsigned v0 transaction. */
    transaction: string;
    lastValidBlockHeight: number;
    /** Opaque reference to a server-held cosigner (position keypair / NFT mint); never a secret. */
    cosignRef?: string;
    sendPermit?: string;
    landedPermit?: string;
    positionMint?: string;
  }
  | { kind: "evm-tx"; chainId: number; to: `0x${string}`; data: `0x${string}`; value: string }
  | { kind: "evm-typed-data"; chainId: number; typedData: unknown };

/** Multi-step operations are prepared one step at a time; step N may depend on step N-1 having landed. */
export type StepContext = { step: number; priorSignatures: readonly string[]; planToken?: string };
export type StepResult = { step: number; of: number; label: string; prepared: PreparedStep; done: boolean; planToken?: string };

export type WithdrawRequest = {
  /** Share of the position to remove, (0, 1]; 1 = everything, and close the position when the DEX allows it. */
  fraction: number;
  output: "pool-tokens" | "usdc";
};

/**
 * Fee strategy hook: how an adapter turns its declared `FeePolicy` into an amount. Injected per adapter, so a policy
 * change is a data change, not a rewrite of the transaction builder.
 */
export interface DexFeeStrategy {
  readonly policy: FeePolicy;
  /** Platform fee for `op` charged on `baseRaw` (the swapped input / output / harvest the rule names). */
  feeFor(op: FeeOp, baseRaw: bigint): bigint;
}

export interface DexAdapter<N = unknown> {
  readonly descriptor: DexDescriptor<N>;
  readonly fees: DexFeeStrategy;
  // reads
  listPositions(owner: string): Promise<UnifiedPosition<N>[]>;
  readPosition(key: PositionKey): Promise<UnifiedPosition<N> | null>;
  performance(key: PositionKey): Promise<PositionPerformance>;
  // quotes and previews (no transaction)
  quoteOpen(request: OpenRequest): Promise<OpenQuote>;
  previewWithdraw(key: PositionKey, request: WithdrawRequest): Promise<ExitPreview>;
  // preparation (no signing, no sending). A method whose capability is unsupported throws DexUnsupportedError.
  prepareOpen(request: OpenRequest, context: StepContext): Promise<StepResult>;
  prepareAdd(key: PositionKey, input: DexDepositInput, context: StepContext): Promise<StepResult>;
  prepareWithdraw(key: PositionKey, request: WithdrawRequest, context: StepContext): Promise<StepResult>;
  prepareClaim(key: PositionKey, context: StepContext): Promise<StepResult>;
  prepareCompound(key: PositionKey, context: StepContext): Promise<StepResult>;
  /** Recover from a half-finished multi-step open (e.g. close an empty position and refund its rent). */
  prepareRecovery?(key: PositionKey, context: StepContext): Promise<StepResult>;
}
