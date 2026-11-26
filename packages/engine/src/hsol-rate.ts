/**
 * Official hSOL exchange rate from the Helius / Sanctum stake-pool account:
 * SOL per hSOL = totalLamports / poolTokenSupply (standard SPL StakePool layout).
 *
 * Decode is pure. The cached RPC read is used by discovery and open-range
 * centering; it is not on a per-visitor hot path. Tests inject account bytes
 * and never call a provider.
 */
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { NATIVE_SOL_MINT } from "./ids";

export const HSOL_MINT = "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A";
export const HSOL_STAKE_POOL = "3wK2g8ZdzAH8FJ7PKr2RcvGh7V9VYson5hrVsJM5Lmws";
export const HSOL_STAKE_POOL_PROGRAM = "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY";

/** Standard SPL StakePool: pool mint, token program, then the two u64 reserves. */
export const STAKE_POOL_MINT_OFFSET = 162;
export const STAKE_POOL_TOKEN_PROGRAM_OFFSET = 226;
export const STAKE_POOL_TOTAL_LAMPORTS_OFFSET = 258;
export const STAKE_POOL_TOKEN_SUPPLY_OFFSET = 266;
export const STAKE_POOL_MIN_LEN = 274;

/** How long a successful rate is reused (the on-chain rate moves once an epoch, ~2 days). */
export const HSOL_RATE_CACHE_TTL_MS = 15 * 60_000;

/** Reject a decoded rate outside this band: a bad decode must not become a range center. */
export const HSOL_RATE_MIN_SOL = 1;
export const HSOL_RATE_MAX_SOL = 3;

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export type HsolExchangeRate = {
  solPerHsol: number;
  totalLamports: bigint;
  poolTokenSupply: bigint;
};

function readU64(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function pubkeyAt(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

/**
 * Decode SOL per hSOL from a stake-pool account, or null when the account is
 * not this pool (wrong owner, mint, program, length, or an implausible rate).
 */
export function solPerHsolFromStakePoolAccount(
  data: Uint8Array,
  meta?: { owner?: string; expectedMint?: string },
): HsolExchangeRate | null {
  if (data.length < STAKE_POOL_MIN_LEN) return null;
  if (meta?.owner && meta.owner !== HSOL_STAKE_POOL_PROGRAM) return null;
  if (pubkeyAt(data, STAKE_POOL_MINT_OFFSET) !== (meta?.expectedMint ?? HSOL_MINT)) return null;
  if (pubkeyAt(data, STAKE_POOL_TOKEN_PROGRAM_OFFSET) !== TOKEN_PROGRAM_ID) return null;
  const totalLamports = readU64(data, STAKE_POOL_TOTAL_LAMPORTS_OFFSET);
  const poolTokenSupply = readU64(data, STAKE_POOL_TOKEN_SUPPLY_OFFSET);
  if (totalLamports <= 0n || poolTokenSupply <= 0n) return null;
  const solPerHsol = Number(totalLamports) / Number(poolTokenSupply);
  if (!Number.isFinite(solPerHsol) || solPerHsol < HSOL_RATE_MIN_SOL || solPerHsol > HSOL_RATE_MAX_SOL) return null;
  return { solPerHsol, totalLamports, poolTokenSupply };
}

/** True when the two mints are wSOL and hSOL, in either order. */
export function isSolHsolMintPair(mintA: string, mintB: string): boolean {
  if (!mintA || !mintB || mintA === mintB) return false;
  return (mintA === NATIVE_SOL_MINT && mintB === HSOL_MINT) || (mintA === HSOL_MINT && mintB === NATIVE_SOL_MINT);
}

/**
 * Official fair price as token B per token A, from SOL per hSOL.
 * Raydium SOL-hSOL (A = wSOL, B = hSOL) → 1 / solPerHsol.
 * Meteora hSOL-SOL (A = hSOL, B = wSOL) → solPerHsol.
 */
export function lstFairPriceBPerA(mintA: string, mintB: string, solPerHsol: number): number | null {
  if (!Number.isFinite(solPerHsol) || solPerHsol <= 0 || !isSolHsolMintPair(mintA, mintB)) return null;
  if (mintA === NATIVE_SOL_MINT && mintB === HSOL_MINT) return 1 / solPerHsol;
  if (mintA === HSOL_MINT && mintB === NATIVE_SOL_MINT) return solPerHsol;
  return null;
}

/** Underlying SOL units per token for same-asset share pricing (1 for SOL, solPerHsol for hSOL). */
export function lstUnderlyingPerToken(mint: string, solPerHsol: number): number | null {
  if (!Number.isFinite(solPerHsol) || solPerHsol <= 0) return null;
  if (mint === NATIVE_SOL_MINT) return 1;
  if (mint === HSOL_MINT) return solPerHsol;
  return null;
}

type RateCache = { value: HsolExchangeRate; expiresAt: number };
let cache: RateCache | null = null;
let inflight: Promise<HsolExchangeRate | null> | null = null;

export function clearHsolRateCache(): void {
  cache = null;
  inflight = null;
}

export type ReadHsolRateOptions = {
  connection: Pick<Connection, "getAccountInfo">;
  now?: () => number;
  ttlMs?: number;
};

/**
 * Read the official rate through the given connection (the app's RPC pool).
 * Cached for `HSOL_RATE_CACHE_TTL_MS`. Failed reads are not cached.
 */
export async function readHsolSolExchangeRate(options: ReadHsolRateOptions): Promise<HsolExchangeRate | null> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HSOL_RATE_CACHE_TTL_MS;
  if (cache && cache.expiresAt > now()) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const info: AccountInfo<Buffer> | null = await options.connection.getAccountInfo(new PublicKey(HSOL_STAKE_POOL), "confirmed");
      if (!info) return null;
      const decoded = solPerHsolFromStakePoolAccount(info.data, { owner: info.owner.toBase58() });
      if (!decoded) return null;
      cache = { value: decoded, expiresAt: now() + ttlMs };
      return decoded;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
