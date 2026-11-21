import type { PositionSelection } from "./selected-types";
import { createHash } from "node:crypto";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, LiquidityMathUtil, PersonalPositionLayout, PoolInfoLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import {
  getAssociatedTokenAddressSync, getPausableConfig, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { poolMintIssues } from "./token-safety";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { positionSide } from "./quote-math";
import { rpcConnection } from "./rpc";
import { inputMintReason } from "./wallet-discovery";
import { fetchRaydiumPoolUsdPrices, fetchTokenPricesUsd, type TokenPriceQuote } from "./token-prices";
import { priceSingleAssets } from "./valuation/single-asset";
import { getJupiterApiKey } from "./config/server-env";
import { withContextSlotRetry } from "./rpc/context-slot";

export type { PositionSelection, SelectedPositionState } from "./selected-types";

/**
 * Registry USD per (raw / 10^decimals) token unit, multiplier applied, never pair-guard corrected. Used for the
 * Selected / Add dollars (X3-4) and the withdraw targetUSDC → bps estimate (X3-5). Signed amounts never come from it:
 * they come from the Jupiter quote + slippage. (`pricing` keeps the legacy Jupiter values; X3-8 removes it.)
 */
export type SelectedDisplayPricing = {
  usdPerRawUnitInput: number | null; multiplierInput: number | null;
  usdPerRawUnitA: number | null; multiplierA: number | null;
  usdPerRawUnitB: number | null; multiplierB: number | null;
};

const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];

function checkedMint(key: PublicKey, info: AccountInfo<Buffer> | null) {
  if (!info || !tokenPrograms.includes(info.owner.toBase58())) throw new Error("Pool asset or NFT mint does not exist or token program mismatch");
  return { mint: unpackMint(key, info, info.owner), program: info.owner };
}

function tokenAmount(info: AccountInfo<Buffer> | null, key: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  if (!info) return { amount: 0n, frozen: false };
  if (!info.owner.equals(program)) throw new Error("Token ATA program and mint mismatch");
  const account = unpackAccount(key, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint)) throw new Error("Token ATA owner or mint mismatch");
  return { amount: account.amount, frozen: account.isFrozen };
}

export async function readSelectedPositionState(
  walletAddress: string, selection: PositionSelection, connection: Connection = rpcConnection(),
  allowEmptyInput = false, options: { displayPrices?: boolean } = {},
) {
  const wallet = new PublicKey(walletAddress);
  const nftMint = new PublicKey(selection.positionMint);
  if (selection.inputKind === "native" && selection.inputMint !== NATIVE_SOL_MINT) throw new Error("Native SOL mint mismatch");
  // Slot-context reads bypass the general account cache on execution paths.
  let slot = 0;
  const read = async (keys: PublicKey[]) => {
    const snapshot = await withContextSlotRetry(() => connection.getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed", minContextSlot: slot }));
    slot = Math.max(slot, snapshot.context.slot);
    return snapshot;
  };
  const positionKey = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nftMint).publicKey;
  const inputMint = new PublicKey(selection.inputMint);
  const initial = await read([positionKey, nftMint, inputMint, wallet]);
  const [positionInfo, nftMintInfo, inputMintInfo, walletInfo] = initial.value;
  const positionDiscriminator = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
  if (!positionInfo || !positionInfo.owner.equals(CLMM_PROGRAM_ID) ||
    !positionInfo.data.subarray(0, 8).equals(positionDiscriminator)) {
    throw new Error("Wallet does not currently hold this Raydium CLMM position NFT");
  }
  const position = PersonalPositionLayout.decode(positionInfo.data);
  if (!position.nftMint.equals(nftMint) || position.tickLower >= position.tickUpper) throw new Error("Position NFT, pool, or ticks mismatch");
  const poolId = position.poolId.toBase58();
  const poolSnapshot = await read([position.poolId]);
  const poolInfo = poolSnapshot.value[0];
  const poolDiscriminator = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);
  if (!poolInfo || !poolInfo.owner.equals(CLMM_PROGRAM_ID) || !poolInfo.data.subarray(0, 8).equals(poolDiscriminator)) throw new Error("Position or pool account has changed");
  const pool = PoolInfoLayout.decode(poolInfo.data);
  const nft = checkedMint(nftMint, nftMintInfo ?? null);
  if (nft.mint.decimals !== 0 || nft.mint.supply !== 1n) throw new Error("Position NFT mint has changed");
  const poolAssets = await read([pool.mintA, pool.mintB, pool.vaultA, pool.vaultB]);
  const [mintAInfo, mintBInfo, vaultAInfo, vaultBInfo] = poolAssets.value;
  const mintA = checkedMint(pool.mintA, mintAInfo ?? null);
  const mintB = checkedMint(pool.mintB, mintBInfo ?? null);
  if (pool.mintA.equals(pool.mintB) || mintA.mint.decimals !== pool.mintDecimalsA ||
    mintB.mint.decimals !== pool.mintDecimalsB) throw new Error("Pool mint or decimals mismatch");
  if (!vaultAInfo || !vaultBInfo) throw new Error("Pool vault does not exist");
  const vaultA = unpackAccount(pool.vaultA, vaultAInfo, vaultAInfo.owner);
  const vaultB = unpackAccount(pool.vaultB, vaultBInfo, vaultBInfo.owner);
  if (!vaultA.mint.equals(pool.mintA) || !vaultB.mint.equals(pool.mintB) ||
    !vaultAInfo.owner.equals(mintA.program) || !vaultBInfo.owner.equals(mintB.program)) throw new Error("Pool vault mint or program mismatch");
  const nftAta = getAssociatedTokenAddressSync(nftMint, wallet, false, nft.program);
  const ataA = getAssociatedTokenAddressSync(pool.mintA, wallet, false, mintA.program);
  const ataB = getAssociatedTokenAddressSync(pool.mintB, wallet, false, mintB.program);
  const input = checkedMint(inputMint, inputMintInfo ?? null);
  const inputAta = getAssociatedTokenAddressSync(inputMint, wallet, false, input.program);
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID);
  const accounts = await read([nftAta, ataA, ataB, inputAta, wsolAta]);
  const [nftAtaInfo, ataAInfo, ataBInfo, inputAtaInfo, wsolAtaInfo] = accounts.value;
  const inputToken = tokenAmount(inputAtaInfo ?? null, inputAta, input.program, wallet, inputMint);
  const wsol = tokenAmount(wsolAtaInfo ?? null, wsolAta, TOKEN_PROGRAM_ID, wallet, new PublicKey(NATIVE_SOL_MINT));
  const inputReason = input.mint.decimals === 0 && input.mint.supply === 1n
    ? "NFT cannot be used as input asset" : inputMintReason(input.mint);
  if (!allowEmptyInput && selection.inputKind === "token" &&
    (inputReason || inputToken.frozen || inputToken.amount === 0n)) {
    throw new Error(inputReason || (inputToken.frozen ? "Input asset ATA is frozen" : "Wallet does not have the selected investable asset"));
  }
  const nftBalance = tokenAmount(nftAtaInfo ?? null, nftAta, nft.program, wallet, nftMint);
  const balanceA = tokenAmount(ataAInfo ?? null, ataA, mintA.program, wallet, pool.mintA);
  const balanceB = tokenAmount(ataBInfo ?? null, ataB, mintB.program, wallet, pool.mintB);
  const ownsNft = nftBalance.amount === 1n && !nftBalance.frozen;
  if (!ownsNft) throw new Error("Wallet does not currently hold this Raydium CLMM position NFT");
  const paused = [mintA.mint, mintB.mint].some((mint) => getPausableConfig(mint)?.paused);
  const transferFee = [mintA.mint, mintB.mint].some((mint) => {
    const config = getTransferFeeConfig(mint);
    return config && (config.newerTransferFee.transferFeeBasisPoints > 0 || config.olderTransferFee.transferFeeBasisPoints > 0);
  });
  const unsupportedExtensions = [...new Set([mintA.mint, mintB.mint].flatMap(poolMintIssues))];
  const frozen = vaultA.isFrozen || vaultB.isFrozen || balanceA.frozen || balanceB.frozen;
  const lower = TickUtil.getSqrtPriceAtTick(position.tickLower);
  const upper = TickUtil.getSqrtPriceAtTick(position.tickUpper);
  const rangeSide = positionSide(BigInt(pool.sqrtPriceX64.toString()), BigInt(lower.toString()), BigInt(upper.toString()));
  const currentAmounts = LiquidityMathUtil.getAmountsForLiquidity(pool.sqrtPriceX64, lower, upper, position.liquidity, true);
  const solLamports = walletInfo?.lamports ?? 0;
  const inputBalance = selection.inputKind === "native"
    ? Math.max(0, solLamports - MIN_SOL_LAMPORTS).toString() : inputToken.amount.toString();
  // `pricing` keeps the legacy values (Jupiter `price`, Raydium fallback; no reader since X3-5). `displayPricing` is
  // USD per (raw / 10^decimals) with the multiplier from the mint accounts read above, never pair-guard corrected.
  let priceUsdInput: number | null = null;
  let priceUsdA: number | null = null;
  let priceUsdB: number | null = null;
  let displayPricing: SelectedDisplayPricing | undefined;
  if (options.displayPrices !== false) {
    try {
      const apiKey = getJupiterApiKey();
      const mintAKey = pool.mintA.toBase58();
      const mintBKey = pool.mintB.toBase58();
      const quotes = await fetchTokenPricesUsd([selection.inputMint, mintAKey, mintBKey], fetch, apiKey);
      const quotesObservedAtMs = Date.now();
      const quoteA = quotes.get(mintAKey);
      const quoteB = quotes.get(mintBKey);
      priceUsdInput = quotes.get(selection.inputMint)?.price ?? null;
      priceUsdA = quoteA?.price ?? null;
      priceUsdB = quoteB?.price ?? null;
      let fallbackA: TokenPriceQuote | undefined;
      let fallbackB: TokenPriceQuote | undefined;
      if (priceUsdA === null || priceUsdB === null) {
        const fallback = await fetchRaydiumPoolUsdPrices(poolId, mintAKey, mintBKey, fetch);
        const raydium = (mint: string): TokenPriceQuote | undefined => {
          const price = fallback.get(mint);
          return price !== undefined ? { price, source: "raydium", basis: "per-raw-unit" } : undefined;
        };
        priceUsdA = fallback.get(mintAKey) ?? priceUsdA;
        priceUsdB = fallback.get(mintBKey) ?? priceUsdB;
        fallbackA = raydium(mintAKey);
        fallbackB = raydium(mintBKey);
      }
      const priced = priceSingleAssets({
        assets: [
          { mint: selection.inputMint, decimals: input.mint.decimals, account: inputMintInfo, quote: quotes.get(selection.inputMint) },
          { mint: mintAKey, decimals: mintA.mint.decimals, account: mintAInfo, quote: fallbackA ?? quoteA },
          { mint: mintBKey, decimals: mintB.mint.decimals, account: mintBInfo, quote: fallbackB ?? quoteB },
        ],
        nowMs: Date.now(), quotesObservedAtMs,
        warn: (warning) => {
          // eslint-disable-next-line no-console -- deliberate marker: a multiplier conflict on a display price (X3-4)
          console.warn("[valuation]", JSON.stringify({ surface: "selected-state", poolId, ...warning }));
        },
      });
      const side = (mint: string) => priced.get(mint) ?? { usdPerRawUnit: null, multiplier: null };
      displayPricing = {
        usdPerRawUnitInput: side(selection.inputMint).usdPerRawUnit, multiplierInput: side(selection.inputMint).multiplier,
        usdPerRawUnitA: side(mintAKey).usdPerRawUnit, multiplierA: side(mintAKey).multiplier,
        usdPerRawUnitB: side(mintBKey).usdPerRawUnit, multiplierB: side(mintBKey).multiplier,
      };
    } catch {
      // Price fetch failed, continue without prices
    }
  }

  return {
    wallet: walletAddress, slot: accounts.context.slot, fetchedAt: Date.now(),
    positionMint: selection.positionMint, positionAccount: positionKey.toBase58(), poolId: poolId,
    programId: CLMM_PROGRAM_ID.toBase58(), inputKind: selection.inputKind, inputMint: selection.inputMint,
    inputDecimals: selection.inputKind === "native" ? 9 : input.mint.decimals,
    inputTokenProgram: selection.inputKind === "native" ? null : input.program.toBase58(),
    inputAccount: selection.inputKind === "native" ? null : inputAta.toBase58(), inputBalance,
    wsolBalance: wsol.amount.toString(), ataAExists: Boolean(ataAInfo), ataBExists: Boolean(ataBInfo),
    vaultA: pool.vaultA.toBase58(), vaultB: pool.vaultB.toBase58(), tickSpacing: pool.tickSpacing,
    mintA: pool.mintA.toBase58(), mintB: pool.mintB.toBase58(),
    decimalsA: mintA.mint.decimals, decimalsB: mintB.mint.decimals,
    programA: mintA.program.toBase58(), programB: mintB.program.toBase58(), nftProgram: nft.program.toBase58(),
    ataA: ataA.toBase58(), ataB: ataB.toBase58(), nftAta: nftAta.toBase58(),
    balances: { a: balanceA.amount.toString(), b: balanceB.amount.toString(), input: inputBalance },
    sqrtPriceX64: pool.sqrtPriceX64.toString(), tickCurrent: pool.tickCurrent,
    tickLower: position.tickLower, tickUpper: position.tickUpper,
    lowerSqrtX64: lower.toString(), upperSqrtX64: upper.toString(),
    price: TickUtil.sqrtPriceX64ToPrice(pool.sqrtPriceX64, pool.mintDecimalsA, pool.mintDecimalsB).toString(),
    inRange: rangeSide === "inside", rangeSide, liquidity: position.liquidity.toString(),
    poolLiquidity: pool.liquidity.toString(),
    currentAmounts: { a: currentAmounts.amountA.toString(), b: currentAmounts.amountB.toString() },
    ownsNft, paused: Boolean(paused), transferFee: Boolean(transferFee), frozen, unsupportedExtensions,
    solLamports, sufficientSol: solLamports >= MIN_SOL_LAMPORTS,
    pricing: priceUsdInput !== null || priceUsdA !== null || priceUsdB !== null
      ? { priceUsdInput, priceUsdA, priceUsdB }
      : undefined,
    ...(displayPricing ? { displayPricing } : {}),
  };
}
