import "@/lib/engine-host";
import "server-only";

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeLbPair, meteoraBinArrayAddress, meteoraBinArrayIndex, METEORA_BINS_PER_ARRAY } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/meteora/constants";
import { rpcConnection } from "@sofinance/engine/rpc";

export type MeteoraOpenPoolView = {
  poolId: string;
  symbolX: string;
  symbolY: string;
  mintX: string;
  mintY: string;
  decimals: number;
  binStep: number;
  activeId: number;
  /** Inclusive bin span covered by contiguous existing bin arrays around the active bin (v1 only opens inside it). */
  allowedLowerBinId: number;
  allowedUpperBinId: number;
};

const SCAN = 2;

/** Pool view for `/app/meteora`: active bin and the bin span v1 can open (existing bin arrays only). Null on any read failure. */
export async function loadMeteoraOpenPoolView(connection: Pick<Connection, "getMultipleAccountsInfo"> = rpcConnection()): Promise<MeteoraOpenPoolView | null> {
  const pool = METEORA_ALLOWLISTED_POOLS[0];
  if (!pool) return null;
  try {
    const [info] = await connection.getMultipleAccountsInfo([new PublicKey(pool.poolAddress)], "confirmed");
    if (!info) return null;
    const lb = decodeLbPair(info.data);
    const activeIndex = meteoraBinArrayIndex(lb.activeId);
    const indexes = Array.from({ length: 2 * SCAN + 1 }, (_v, i) => activeIndex - SCAN + i);
    const arrays = await connection.getMultipleAccountsInfo(indexes.map((i) => new PublicKey(meteoraBinArrayAddress(pool.poolAddress, i))), "confirmed");
    const exists = (i: number) => Boolean(arrays[i - activeIndex + SCAN]);
    if (!exists(activeIndex)) return null;
    let low = activeIndex; while (low - 1 >= activeIndex - SCAN && exists(low - 1)) low--;
    let high = activeIndex; while (high + 1 <= activeIndex + SCAN && exists(high + 1)) high++;
    return {
      poolId: pool.poolAddress, symbolX: pool.wrappedSymbol, symbolY: pool.plainSymbol, mintX: pool.mintX, mintY: pool.mintY,
      decimals: 8, binStep: pool.binStep, activeId: lb.activeId,
      allowedLowerBinId: low * METEORA_BINS_PER_ARRAY, allowedUpperBinId: (high + 1) * METEORA_BINS_PER_ARRAY - 1,
    };
  } catch {
    return null;
  }
}

export type MeteoraWalletBalances = { wallet: string; solLamports: string; usdc: string; x: string; y: string };

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Raw wallet balances for the open panel (SOL lamports; USDC / X / Y raw units from the wallet's ATAs). */
export async function readMeteoraWalletBalances(
  wallet: string,
  connection: Pick<Connection, "getMultipleAccountsInfo"> = rpcConnection(),
): Promise<MeteoraWalletBalances> {
  const pool = METEORA_ALLOWLISTED_POOLS[0]!;
  const owner = new PublicKey(wallet);
  const atas = [USDC_MINT, pool.mintX, pool.mintY].map((mint) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID));
  const [walletInfo, ...tokens] = await connection.getMultipleAccountsInfo([owner, ...atas], "confirmed");
  const amount = (i: number) => {
    const info = tokens[i];
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) return "0";
    return unpackAccount(atas[i]!, info, TOKEN_PROGRAM_ID).amount.toString();
  };
  return { wallet, solLamports: String(walletInfo?.lamports ?? 0), usdc: amount(0), x: amount(1), y: amount(2) };
}
