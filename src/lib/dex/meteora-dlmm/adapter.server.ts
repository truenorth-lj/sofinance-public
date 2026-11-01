import "@/lib/engine-host";
import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeLbPair, decodeMintDecimals } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { decodeMeteoraPosition, isMeteoraPositionAccount, meteoraPositionLiquidity, meteoraRangeSide } from "@sofinance/engine/protocols/meteora/position";
import { rpcConnection } from "@sofinance/engine/rpc";
import { isJupiterUpstreamError, asJupiterUserError } from "@sofinance/engine/jupiter";
import { readSwapFeeConfig, type SwapFeeConfig } from "@sofinance/engine/swap/fee";
import { getMeteoraPositionPerformance, listMeteoraPositions, METEORA_POOL_NOT_SUPPORTED, type MeteoraListedPosition, type MeteoraPerformanceOptions, type MeteoraReadOptions } from "@/lib/meteora-positions";
import { positionKey, type PositionKey, type PositionHoldings, type RangeStatus, type UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter, DexDepositInput, OpenQuote, OpenRequest, PositionPerformance, StepContext, StepResult, WithdrawRequest } from "../adapter";
import type { FeePolicy } from "../types";
import { DexError, DexUnsupportedError } from "../errors";
import { bpsFeeStrategy } from "../fees";
import { meteoraDlmmDescriptor } from "./descriptor";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import {
  buildMeteoraCloseRefund, buildMeteoraDeposit, buildMeteoraSetup, meteoraBinUiPrice, meteoraRequestRange, planMeteoraOpen, readMeteoraPool,
  assertEmptyOwnedPosition, type MeteoraOpenDeps, type MeteoraPoolState,
} from "./open.server";
import { buildMeteoraAdd, buildMeteoraClaim, buildMeteoraCompound, buildMeteoraWithdraw } from "./manage.server";
import { listedMeteoraPool, type MeteoraPoolList } from "./pools.server";

/** What a Meteora `UnifiedPosition.native` carries: the existing positions row (same shape the legacy UI reads). */
/**
 * The report fields the Performance tab draws (`PositionPerformanceReport`), and nothing else: the raw event history,
 * fetch metrics and timings of the legacy route stay on the server (PM review of #290).
 */
function uiReport(report: NonNullable<Awaited<ReturnType<typeof getMeteoraPositionPerformance>>>): PositionPerformanceReport {
  return {
    positionMint: report.positionMint, poolId: report.poolId, mintA: report.mintA, mintB: report.mintB,
    decimalsA: report.decimalsA, decimalsB: report.decimalsB, tickLower: report.tickLower, tickUpper: report.tickUpper,
    tickCurrent: report.tickCurrent, rangeSide: report.rangeSide, liquidity: report.liquidity,
    openedAtIso: report.openedAtIso, evaluatedAtIso: report.evaluatedAtIso, truncated: report.truncated,
    signatureCount: report.signatureCount, ownsNft: report.ownsNft,
    cashflows: { openCount: report.cashflows.openCount, increaseCount: report.cashflows.increaseCount, decreaseCount: report.cashflows.decreaseCount },
    metrics: report.metrics, tokenNative: report.tokenNative, pricing: report.pricing,
    assumptions: report.assumptions, method: report.method, realizedFeeAprSeries: report.realizedFeeAprSeries,
  };
}

export type MeteoraDlmmNative = Pick<MeteoraListedPosition, "positionAccount" | "poolId" | "mintA" | "mintB" | "lowerBinId" | "upperBinId" | "activeBinId" | "liquidity">;

export type MeteoraDlmmAdapterOptions = {
  connection?: () => Connection;
  feeConfig?: () => SwapFeeConfig;
  listedPool?: MeteoraPoolList;
  /**
   * Overrides the descriptor's fee policy. Only for tests and local setups that want no fee: pass an explicit
   * policy whose open rule is "none". A charging policy without a fee wallet is always refused.
   */
  feePolicy?: FeePolicy;
  /** Reads a position's performance report (default `getMeteoraPositionPerformance`: chain history + Jupiter prices). */
  readPerformance?: typeof getMeteoraPositionPerformance;
};

const SOURCE = meteoraDlmmDescriptor.id;
const KEY_PREFIX = `${SOURCE}:`;
/** Codes a quote reports as `blockedReason` (the open is understood but not allowed); the rest are thrown. */
const QUOTE_BLOCKING = new Set(["UNSUPPORTED", "TOKEN_RESTRICTED", "RANGE_UNSUPPORTED", "NEEDS_NEW_SHARED_ACCOUNT", "INPUT_TOKEN_UNSUPPORTED"]);
const STATUS: Record<"inside" | "below" | "above", RangeStatus> = { inside: "in", below: "below", above: "above" };

/** Never echo an RPC or API URL (they can carry keys) inside an error message. */
const scrub = (message: string) => message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[endpoint]");

/** Every error leaving the adapter is a DexError with the real cause in plain words. */
export function toMeteoraDexError(error: unknown): unknown {
  if (error instanceof DexError) return error;
  // The Jupiter browser relay collects missing responses from this throw; it must pass through unchanged.
  if (error instanceof Error && error.name === "JupiterRelayMissingError") return error;
  if (error instanceof Error && error.name === "SwapFeeAccountMissingError") return new DexError("INPUT_TOKEN_UNSUPPORTED", error.message);
  if (error instanceof Error && error.message === METEORA_POOL_NOT_SUPPORTED) return new DexError("UNSUPPORTED", error.message);
  if (isJupiterUpstreamError(error)) return new DexError("UPSTREAM", asJupiterUserError(error).message);
  const message = error instanceof Error ? error.message : String(error);
  return new DexError("UPSTREAM", scrub(`The Meteora request could not be completed: ${message}`));
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toMeteoraDexError(error);
  }
}

function nativeIdOf(key: PositionKey) {
  if (!key.startsWith(KEY_PREFIX)) throw new DexError("INVALID_REQUEST", "That position key is not a Meteora position.");
  const id = key.slice(KEY_PREFIX.length);
  try {
    return new PublicKey(id).toBase58();
  } catch {
    throw new DexError("INVALID_REQUEST", "That Meteora position key is not a valid Solana address.");
  }
}

function singleStep(context: StepContext, what: string) {
  if (context.step !== 1) throw new DexError("INVALID_REQUEST", `${what} is a single step; step ${context.step} does not exist.`);
}

const solText = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);

function cosignerOf(request: OpenRequest) {
  if (!request.cosigner) throw new DexError("INVALID_REQUEST", "Opening a Meteora position needs the public key of a fresh position keypair created in your browser.");
  let cosigner: string;
  try {
    cosigner = new PublicKey(request.cosigner).toBase58();
  } catch {
    throw new DexError("INVALID_REQUEST", "The position key is not a valid Solana address.");
  }
  if (cosigner === request.owner) throw new DexError("INVALID_REQUEST", "The position key must be a fresh keypair, not your wallet.");
  return cosigner;
}

function unified(row: MeteoraDlmmNative, binStep: number, decimalsX: number, decimalsY: number,
  holdings: PositionHoldings = { liquidityRaw: null, unclaimedFeesRaw: null }): UnifiedPosition<MeteoraDlmmNative> {
  const price = (bin: number) => meteoraBinUiPrice(bin, binStep, decimalsX, decimalsY);
  return {
    key: positionKey(SOURCE, row.positionAccount), source: SOURCE, chain: "solana", nativeId: row.positionAccount, poolId: row.poolId,
    tokenA: { id: row.mintA, symbol: null, decimals: decimalsX },
    tokenB: { id: row.mintB, symbol: null, decimals: decimalsY },
    range: { mode: "price", lower: price(row.lowerBinId), upper: price(row.upperBinId + 1), current: price(row.activeBinId) },
    rangeStatus: STATUS[meteoraRangeSide(row.activeBinId, row.lowerBinId, row.upperBinId)],
    liquidity: row.liquidity, holdings, native: row,
  };
}

export function createMeteoraDlmmAdapter(options: MeteoraDlmmAdapterOptions = {}): DexAdapter<MeteoraDlmmNative> {
  const descriptor = meteoraDlmmDescriptor;
  const fees = bpsFeeStrategy(options.feePolicy ?? descriptor.meta.feePolicy);
  if (!["none", "swap-input-bps"].includes(fees.policy.open.kind)) throw new Error("Meteora deposits charge on the swapped input only");
  const deps = (): MeteoraOpenDeps => ({
    connection: (options.connection ?? rpcConnection)(), fees, feeConfig: options.feeConfig ?? readSwapFeeConfig, listedPool: options.listedPool ?? listedMeteoraPool,
  });
  const notYet = (capability: { supported: boolean; reason?: string }) => new DexUnsupportedError(capability.supported ? undefined : capability.reason);

  async function decimalsFor(connection: Connection, mints: string[]) {
    const unique = [...new Set(mints)];
    const infos = await connection.getMultipleAccountsInfo(unique.map((mint) => new PublicKey(mint)), "confirmed");
    return new Map(unique.map((mint, index) => {
      const info = infos[index];
      if (!info) throw new DexError("UPSTREAM", `The token mint ${mint} was not found on chain.`);
      return [mint, decodeMintDecimals(info.data)] as const;
    }));
  }

  async function quote(request: OpenRequest): Promise<OpenQuote> {
    const d = deps();
    let pool: MeteoraPoolState | undefined;
    let range: { lowerBinId: number; upperBinId: number } | undefined;
    try {
      pool = await readMeteoraPool(d, request.poolId);
      range = meteoraRequestRange(request, pool);
      const plan = await planMeteoraOpen(d, request, pool, range);
      const { binStep } = pool.lbPair;
      return {
        poolId: request.poolId,
        range: {
          lowerPrice: meteoraBinUiPrice(plan.lowerBinId, binStep, pool.decimalsX, pool.decimalsY),
          upperPrice: meteoraBinUiPrice(plan.upperBinId + 1, binStep, pool.decimalsX, pool.decimalsY),
          units: plan.width,
        },
        steps: 2,
        rent: { refundableLamports: plan.positionRentLamports.toString(), nonRefundableLamports: "0" },
        platformFeeRaw: plan.platformFeeRaw.toString(),
      };
    } catch (error) {
      if (!(error instanceof DexError) || !QUOTE_BLOCKING.has(error.code)) throw error;
      const priced = pool && range;
      return {
        poolId: request.poolId,
        range: priced
          ? {
            lowerPrice: meteoraBinUiPrice(range!.lowerBinId, pool!.lbPair.binStep, pool!.decimalsX, pool!.decimalsY),
            upperPrice: meteoraBinUiPrice(range!.upperBinId + 1, pool!.lbPair.binStep, pool!.decimalsX, pool!.decimalsY),
            units: range!.upperBinId - range!.lowerBinId + 1,
          }
          : { lowerPrice: 0, upperPrice: 0, units: 0 },
        steps: 2,
        rent: { refundableLamports: "0", nonRefundableLamports: "0" },
        platformFeeRaw: "0",
        blockedReason: error.message,
      };
    }
  }

  async function open(request: OpenRequest, context: StepContext): Promise<StepResult> {
    const d = deps();
    if (context.step === 1) {
      const position = cosignerOf(request);
      const pool = await readMeteoraPool(d, request.poolId);
      const plan = await planMeteoraOpen(d, request, pool, meteoraRequestRange(request, pool));
      const built = await buildMeteoraSetup(d, plan, request.owner, position);
      return {
        step: 1, of: 2, label: "Create the position account (step 1 of 2)", done: false, planToken: position,
        prepared: { kind: "solana-tx", ...built, cosignRef: position, positionMint: position },
      };
    }
    if (context.step === 2) {
      const position = context.planToken ?? request.cosigner;
      if (!position) throw new DexError("INVALID_REQUEST", "Step 2 of 2 needs the position created in step 1.");
      const positionKeyValue = new PublicKey(cosignerOf({ ...request, cosigner: position }));
      const pool = await readMeteoraPool(d, request.poolId);
      // The range comes from the position account step 1 created, not from the request (the price may have moved).
      const existing = assertEmptyOwnedPosition(await d.connection.getAccountInfo(positionKeyValue, "confirmed"), request.owner, request.poolId);
      const plan = await planMeteoraOpen(d, request, pool, { lowerBinId: existing.lowerBinId, upperBinId: existing.upperBinId });
      const built = await buildMeteoraDeposit(d, plan, request.owner, positionKeyValue.toBase58());
      return {
        step: 2, of: 2, label: "Deposit into the position (step 2 of 2)", done: true,
        prepared: { kind: "solana-tx", ...built, positionMint: positionKeyValue.toBase58() },
      };
    }
    throw new DexError("INVALID_REQUEST", `A Meteora open has 2 steps; step ${context.step} does not exist.`);
  }

  return Object.freeze({
    descriptor,
    fees,
    listPositions: (owner: string) => guarded(async () => {
      const { connection, listedPool } = deps();
      // Same pool list as opening: the static allowlist plus the current RWA feed generation, and only the static
      // allowlist when the RWA store is off (fail closed). A store read error fails the whole list (never a partial one).
      const rows = await listMeteoraPositions(owner, { connection: connection as unknown as NonNullable<MeteoraReadOptions["connection"]>, listedPool });
      if (!rows.length) return [];
      const decimals = await decimalsFor(connection, rows.flatMap((row) => [row.mintA, row.mintB]));
      const poolIds = [...new Set(rows.map((row) => row.poolId))];
      const pools = await connection.getMultipleAccountsInfo(poolIds.map((id) => new PublicKey(id)), "confirmed");
      const binStep = new Map(poolIds.flatMap((id, index) => {
        const info = pools[index];
        return info ? [[id, decodeLbPair(info.data).binStep] as const] : [];
      }));
      // Close refund shown before a full withdraw: closing returns the position account's own lamports, so read them
      // (PM review of #289: not the rent-exempt minimum for its width, which misses any extra lamports). Best effort:
      // an unread account leaves the field out (the panel then says "rent" without an amount).
      const refunds = new Map<string, string>();
      try {
        const accounts = rows.map((row) => row.positionAccount);
        for (let start = 0; start < accounts.length; start += 100) {
          const slice = accounts.slice(start, start + 100);
          const infos = await connection.getMultipleAccountsInfo(slice.map((id) => new PublicKey(id)), "confirmed");
          slice.forEach((id, index) => { const info = infos[index]; if (info && info.lamports > 0) refunds.set(id, String(info.lamports)); });
        }
      } catch { /* left out */ }
      return rows.map((row) => {
        const step = binStep.get(row.poolId);
        if (step === undefined) throw new DexError("UPSTREAM", `The Meteora pool ${row.poolId} was not found on chain.`);
        const position = unified(row, step, decimals.get(row.mintA)!, decimals.get(row.mintB)!,
          { liquidityRaw: { ...row.amountsRaw }, unclaimedFeesRaw: { ...row.uncollectedFeesRaw } });
        const refund = refunds.get(row.positionAccount);
        return refund ? { ...position, closeRefundLamports: refund } : position;
      });
    }),
    readPosition: (key: PositionKey) => guarded(async () => {
      const id = nativeIdOf(key);
      const connection = deps().connection;
      const info = await connection.getAccountInfo(new PublicKey(id), "confirmed");
      if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) return null;
      const position = decodeMeteoraPosition(info.data);
      const poolInfo = await connection.getAccountInfo(new PublicKey(position.lbPair), "confirmed");
      if (!poolInfo) throw new DexError("UPSTREAM", "The pool of this Meteora position was not found on chain.");
      const lbPair = decodeLbPair(poolInfo.data);
      const decimals = await decimalsFor(connection, [lbPair.tokenXMint, lbPair.tokenYMint]);
      return unified({
        positionAccount: id, poolId: position.lbPair, mintA: lbPair.tokenXMint, mintB: lbPair.tokenYMint,
        lowerBinId: position.lowerBinId, upperBinId: position.upperBinId, activeBinId: lbPair.activeId, liquidity: meteoraPositionLiquidity(position).toString(),
      }, lbPair.binStep, decimals.get(lbPair.tokenXMint)!, decimals.get(lbPair.tokenYMint)!);
    }),
    // PR9: the same report as /api/position-performance (cashflows from the position's own history, current prices),
    // for a position in a listed pool; the summary fields are lifted from its metrics.
    performance: (key: PositionKey) => guarded(async (): Promise<PositionPerformance> => {
      if (!descriptor.capabilities.performance.supported) throw notYet(descriptor.capabilities.performance);
      const id = nativeIdOf(key);
      const { connection, listedPool } = deps();
      const report = await (options.readPerformance ?? getMeteoraPositionPerformance)(id, {
        connection: connection as unknown as NonNullable<MeteoraPerformanceOptions["connection"]>, listedPool,
      });
      if (!report) throw new DexError("POSITION_NOT_FOUND", "No Meteora position exists at that address.");
      const { metrics } = report;
      return {
        key, depositedUsd: metrics.depositedUsd, withdrawnUsd: metrics.withdrawnPrincipalUsd, feesClaimedUsd: metrics.feesCollectedUsd,
        feesUnclaimedUsd: metrics.uncollectedFeesUsd, currentValueUsd: metrics.currentEquityUsd, pnlUsd: metrics.pnlUsd,
        // No open found in the read history: deposits may be missing, so the numbers are partial too.
        partial: report.truncated || report.openedAtIso === null,
        report: uiReport(report),
      };
    }),
    quoteOpen: (request: OpenRequest) => guarded(() => quote(request)),
    previewWithdraw: async () => { throw notYet(descriptor.capabilities.exitPreview); },
    prepareOpen: (request: OpenRequest, context: StepContext) => guarded(() => open(request, context)),
    // Position ops (PR6): one wallet step each; the builders check the decoded on-chain owner against `owner`.
    prepareAdd: (key: PositionKey, owner: string, input: DexDepositInput, context: StepContext) => guarded(async () => {
      singleStep(context, "Adding to a Meteora position");
      const position = nativeIdOf(key);
      const built = await buildMeteoraAdd(deps(), position, owner, input);
      return { step: 1, of: 1, label: "Add to the position", done: true, prepared: { kind: "solana-tx", ...built, positionMint: position } };
    }),
    prepareWithdraw: (key: PositionKey, owner: string, request: WithdrawRequest, context: StepContext) => guarded(async () => {
      singleStep(context, "A Meteora withdraw");
      const position = nativeIdOf(key);
      const built = await buildMeteoraWithdraw(deps(), position, owner, request);
      const label = built.full
        ? `Withdraw everything, claim fees and close the position. Its rent (about ${solText(built.rentRefundLamports)} SOL) comes back to your wallet.`
        : `Withdraw ${(built.bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% of the position. Unclaimed fees stay in the position.`;
      return {
        step: 1, of: 1, label, done: true,
        prepared: { kind: "solana-tx", transaction: built.transaction, lastValidBlockHeight: built.lastValidBlockHeight, positionMint: position },
      };
    }),
    prepareClaim: (key: PositionKey, owner: string, context: StepContext) => guarded(async () => {
      singleStep(context, "A Meteora fee claim");
      const position = nativeIdOf(key);
      const built = await buildMeteoraClaim(deps(), position, owner);
      return { step: 1, of: 1, label: "Claim unclaimed fees to your wallet", done: true, prepared: { kind: "solana-tx", ...built, positionMint: position } };
    }),
    // PR8: claim + deposit the claimed fees back into the same range, one step, no swap and no fee.
    prepareCompound: (key: PositionKey, owner: string, context: StepContext) => guarded(async () => {
      singleStep(context, "A Meteora compound");
      const position = nativeIdOf(key);
      const built = await buildMeteoraCompound(deps(), position, owner);
      const leftover = built.leftoverX > 0n || built.leftoverY > 0n
        ? " The price is outside the position's range, so fees in the token it can't hold right now go to your wallet instead." : "";
      return {
        step: 1, of: 1, label: `Claim the position's fees and add them back into it. No platform fee.${leftover}`, done: true,
        ...(built.createdTokenAccounts.length
          ? { createsTokenAccounts: built.createdTokenAccounts.map((item) => ({ mint: item.mint, rentLamports: item.rentLamports.toString() })) } : {}),
        prepared: { kind: "solana-tx", transaction: built.transaction, lastValidBlockHeight: built.lastValidBlockHeight, positionMint: position },
      };
    }),
    prepareRecovery: (key: PositionKey, owner: string, context: StepContext) => guarded(async () => {
      if (context.step !== 1) throw new DexError("INVALID_REQUEST", "Closing an empty Meteora position is a single step.");
      const position = nativeIdOf(key);
      const built = await buildMeteoraCloseRefund(deps(), position, owner);
      return {
        step: 1, of: 1, label: "Close the empty position and get its rent back", done: true,
        prepared: { kind: "solana-tx", transaction: built.transaction, lastValidBlockHeight: built.lastValidBlockHeight, positionMint: position },
      };
    }),
  } satisfies DexAdapter<MeteoraDlmmNative>);
}
