import "@/lib/engine-host";
import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import {
  decodeMintDecimals, decodeOrcaTickArray, decodeWhirlpool, orcaTickArrayAddress, orcaTickArrayStartsForWindow,
} from "@sofinance/engine/protocols/orca/accounts";
import { ORCA_ALLOWLISTED_POOLS, ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_WHIRLPOOLS_CONFIG } from "@sofinance/engine/protocols/orca/constants";
import { buildLiquidityBins, windowBounds } from "./liquidity-bins";
import { halfWindowBinsFor, type OnchainPoolLiquidity } from "./onchain-liquidity";

export type OrcaTickArrayInfo = {
  startTickIndex: number;
  address: string;
  /** null = the tick array account does not exist (no liquidity boundaries there). */
  kind: "fixed" | "dynamic" | null;
  initializedTicks: number;
};

/** Read-only Whirlpool state plus the liquidity distribution in the shared range-APR shape. */
export type OrcaPoolLiquidity = OnchainPoolLiquidity & {
  state: {
    whirlpoolsConfig: string;
    /** Hundredths of a bp. */
    feeRate: number;
    /** Basis points of the swap fee kept by Orca. */
    protocolFeeRate: number;
    liquidity: string;
    vaultA: string;
    vaultB: string;
    slot: number;
    tickArrays: OrcaTickArrayInfo[];
  };
};

const PROGRAM = new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ID);

/**
 * One Whirlpool read, then one batched read of both mints and the tick arrays covering the analysed window
 * (fixed or dynamic layout). Allowlisted pools only; any owner, config, mint or tick-array mismatch throws.
 */
export async function readOrcaPoolLiquidity(
  poolId: string, connection: Connection = rpcConnection(),
): Promise<OrcaPoolLiquidity> {
  const spec = ORCA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);
  if (!spec) throw new Error("Orca pool is not allowlisted");
  const pool = new PublicKey(poolId);
  const poolInfo = await connection.getAccountInfo(pool, "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(PROGRAM)) throw new Error("Orca Whirlpool account does not exist");
  const state = decodeWhirlpool(poolInfo.data);
  if (state.whirlpoolsConfig !== ORCA_WHIRLPOOLS_CONFIG) throw new Error("Orca Whirlpool config mismatch");
  if (state.tokenMintA !== spec.mintA || state.tokenMintB !== spec.mintB) throw new Error("Orca Whirlpool mint mismatch");
  const { tickSpacing, tickCurrentIndex: tickCurrent } = state;
  const half = halfWindowBinsFor(tickSpacing);
  const { firstTick, endTick } = windowBounds(tickCurrent, tickSpacing, half);
  const starts = orcaTickArrayStartsForWindow(firstTick, endTick, tickSpacing);
  const arrayKeys = starts.map((start) => orcaTickArrayAddress(poolId, start));
  const { context, value: infos } = await connection.getMultipleAccountsInfoAndContext(
    [new PublicKey(state.tokenMintA), new PublicKey(state.tokenMintB), ...arrayKeys.map((key) => new PublicKey(key))],
    "confirmed",
  );
  const [mintA, mintB, ...arrays] = infos;
  if (!mintA || !mintB) throw new Error("Orca pool mint account missing");
  const liquidityNet = new Map<number, bigint>();
  const tickArrays: OrcaTickArrayInfo[] = arrays.map((info, index) => {
    const startTickIndex = starts[index]!, address = arrayKeys[index]!;
    if (!info) return { startTickIndex, address, kind: null, initializedTicks: 0 };
    if (!info.owner.equals(PROGRAM)) throw new Error("Orca tick array owner mismatch");
    const array = decodeOrcaTickArray(info.data, tickSpacing);
    if (array.whirlpool !== poolId || array.startTickIndex !== startTickIndex) {
      throw new Error("Orca tick array pool or start index mismatch");
    }
    for (const tick of array.ticks) {
      if (tick.liquidityGross > 0n) liquidityNet.set(tick.tick, tick.liquidityNet);
    }
    return { startTickIndex, address, kind: array.kind, initializedTicks: array.ticks.length };
  });
  return {
    poolId,
    mintA: state.tokenMintA,
    mintB: state.tokenMintB,
    decimalsA: decodeMintDecimals(mintA.data),
    decimalsB: decodeMintDecimals(mintB.data),
    tickSpacing,
    tickCurrent,
    sqrtPriceX64: state.sqrtPriceX64.toString(),
    bins: buildLiquidityBins({ tickCurrent, tickSpacing, poolLiquidity: state.liquidity, liquidityNet, halfWindowBins: half }),
    state: {
      whirlpoolsConfig: state.whirlpoolsConfig,
      feeRate: state.feeRate,
      protocolFeeRate: state.protocolFeeRate,
      liquidity: state.liquidity.toString(),
      vaultA: state.tokenVaultA,
      vaultB: state.tokenVaultB,
      slot: context.slot,
      tickArrays,
    },
  };
}
