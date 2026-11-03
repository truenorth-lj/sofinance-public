/**
 * Server-side half of the shared DEX contract (DESIGN.md §1.2). Types only: implementations live in
 * `src/lib/dex/<id>/` and are reached through the registry.
 *
 * Adapters READ and PREPARE. They never sign, send or confirm: the shared transaction pipeline
 * (`src/lib/tx-pipeline/run.ts`: wallet send, the on-chain check after a wallet error such as 4001/5000, confirmation,
 * status) and the EVM wallet flow stay outside this interface and consume `PreparedStep`s.
 */
import type { OpenSolQuote } from "./sol-need";
import type { PositionKey, UnifiedPosition, WithdrawOutput } from "@/lib/unified-positions/model";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
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
  /**
   * Public key of the browser-created cosigner (position keypair / NFT mint) when
   * `descriptor.meta.positionCosigner` is "ephemeral-keypair". Only the public key: the secret never leaves the browser.
   */
  cosigner?: string;
};

export type RentQuote = {
  /** Set aside now and returned on full withdraw. */
  refundableLamports: string;
  /** Spent for good (e.g. a new shared on-chain account). */
  nonRefundableLamports: string;
  /**
   * Rent of the wallet token accounts the open creates, sized per mint (program and extensions). Not returned when the
   * position closes: it stays in the token account, refundable only if that account is closed. Omitted when the
   * adapter does not price it separately.
   */
  tokenAccountLamports?: string;
};

/**
 * Whether a deposit is big enough to reach every price step (tick / bin) of its range. Some DEXes split a deposit evenly
 * over the range's steps in whole raw units (Meteora DLMM: floor(amount / bins) per bin), so a small amount rounds to
 * 0 in every step and adds nothing. Worked out at quote time by the adapter; the UI blocks the button and shows
 * `depositTooSmallMessage`. The build's simulation check stays the final backstop.
 */
export type DepositMinimum = {
  /** Input token id the figures are in. */
  token: string;
  /** The quoted amount would round to 0 in some step of the range. */
  tooSmall: boolean;
  /** Estimated smallest amount (raw units of `token`) that reaches every step; null when it could not be estimated. */
  minimumRaw: string | null;
};

/** What an Add would do before anything is built (no transaction). */
export type AddQuote = {
  /** Omitted when the adapter has no minimum rule or could not work it out (the build's simulation still checks). */
  depositMinimum?: DepositMinimum;
};

export type OpenQuote = {
  poolId: string;
  range: { lowerPrice: number; upperPrice: number; units: number };
  steps: number;
  rent: RentQuote | null;
  /** Fee the platform takes on this open, in the input token's raw units. */
  platformFeeRaw: string;
  /** The other SOL parts the open needs beyond `rent` (see `openSolNeed`); omitted when the adapter does not price them. */
  sol?: OpenSolQuote;
  /** Present when this open cannot proceed, in plain English (e.g. it would need a new shared account). */
  blockedReason?: string;
  /** Omitted when the adapter has no minimum rule or could not work it out (see `DepositMinimum`). */
  depositMinimum?: DepositMinimum;
};

/** One preset range an open can use, as the server works it out from the pool's current state (no APR data needed). */
export type OpenRangePreset = {
  id: "micro" | "tight" | "standard" | "wide";
  /** Range bounds in the DEX's range unit (`descriptor.meta.rangeUnit`), inclusive; `units` = how many it spans. */
  lowerUnit: number;
  upperUnit: number;
  units: number;
  /** UI prices (B per 1 A) of the bounds. */
  priceLower: number;
  priceUpper: number;
};

/** The preset ranges of a pool for opening, plus the pool tokens' decimals (keyed by mint). */
export type OpenRanges = { poolId: string; decimals: Record<string, number>; presets: OpenRangePreset[] };

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
  /**
   * The full report the Performance panel draws (same shape as the `/api/position-performance` body: per-side
   * cashflows, token-native metrics, realized fee APR series). Optional: an adapter may only have the summary.
   */
  report?: PositionPerformanceReport;
};

/** One wallet action. A Solana step maps 1:1 onto the tx pipeline's `PreparedTx` after deserialization. */
export type PreparedStep =
  | {
    kind: "solana-tx";
    /** Base64 unsigned v0 transaction. */
    transaction: string;
    lastValidBlockHeight: number;
    /**
     * Public key of the cosigner that must sign after the wallet (the browser-held position keypair / NFT mint named by
     * `OpenRequest.cosigner`); never a secret. Absent when the wallet is the only signer.
     */
    cosignRef?: string;
    sendPermit?: string;
    landedPermit?: string;
    positionMint?: string;
  }
  | { kind: "evm-tx"; chainId: number; to: `0x${string}`; data: `0x${string}`; value: string }
  | { kind: "evm-typed-data"; chainId: number; typedData: unknown };

/** Multi-step operations are prepared one step at a time; step N may depend on step N-1 having landed. */
export type StepContext = { step: number; priorSignatures: readonly string[]; planToken?: string };
export type StepResult = {
  step: number; of: number; label: string; prepared: PreparedStep; done: boolean; planToken?: string;
  /**
   * Wallet token accounts this step creates and the rent each one sets aside (lamports, decimal string), so the UI can
   * state it before the wallet asks to sign. Omitted when the step creates none.
   */
  createsTokenAccounts?: { mint: string; rentLamports: string }[];
};

export type WithdrawRequest = {
  /** Share of the position to remove, (0, 1]; 1 = everything, and close the position when the DEX allows it. */
  fraction: number;
  /** One of the DEX's `capabilities.withdrawOutputs`; any other is refused (the route checks first). */
  output: WithdrawOutput;
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
  /** The preset ranges `quoteOpen` / `prepareOpen` resolve a `preset` range to, from on-chain state only (no volume or APR). */
  openRanges?(poolId: string): Promise<OpenRanges>;
  previewWithdraw(key: PositionKey, request: WithdrawRequest): Promise<ExitPreview>;
  // preparation (no signing, no sending). A method whose capability is unsupported throws DexUnsupportedError.
  prepareOpen(request: OpenRequest, context: StepContext): Promise<StepResult>;
  /**
   * Position ops take the requesting wallet (`owner`). The adapter itself must read the position and refuse
   * (POSITION_NOT_FOUND) when its on-chain owner is not that wallet: the route is not the only caller (MCP, cron).
   */
  prepareAdd(key: PositionKey, owner: string, input: DexDepositInput, context: StepContext): Promise<StepResult>;
  /** Pre-build check of an Add (e.g. the amount is too small for the range). Optional: without it the panel has no minimum. */
  quoteAdd?(key: PositionKey, owner: string, input: DexDepositInput): Promise<AddQuote>;
  prepareWithdraw(key: PositionKey, owner: string, request: WithdrawRequest, context: StepContext): Promise<StepResult>;
  prepareClaim(key: PositionKey, owner: string, context: StepContext): Promise<StepResult>;
  prepareCompound(key: PositionKey, owner: string, context: StepContext): Promise<StepResult>;
  /**
   * Recover from a half-finished multi-step open (e.g. close an empty position and refund its rent). `owner` is the
   * requesting wallet: the adapter must refuse a position that wallet does not own, and pay any refund only to it.
   */
  prepareRecovery?(key: PositionKey, owner: string, context: StepContext): Promise<StepResult>;
}
