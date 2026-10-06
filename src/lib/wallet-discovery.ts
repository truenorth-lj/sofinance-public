import "server-only";

import { createHash } from "node:crypto";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout, PoolInfoLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import {
  AccountState, ExtensionType, getDefaultAccountState, getExtensionTypes, getPausableConfig,
  getScaledUiAmountConfig, getTransferFeeConfig, getTransferHook, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { positionSide } from "./quote-math";
import { rpcConnection } from "./rpc";

const POSITION_DISCRIMINATOR = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);
const SAFE_INPUT_EXTENSIONS = new Set([
  ExtensionType.MintCloseAuthority, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata,
  ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState, ExtensionType.PausableConfig,
  ExtensionType.TransferFeeConfig, ExtensionType.TransferHook, ExtensionType.ScaledUiAmountConfig,
  ExtensionType.ConfidentialTransferMint, // Only the public ATA balance is offered as input.
]);

type OwnedToken = { account: PublicKey; mint: PublicKey; amount: bigint; program: PublicKey; frozen: boolean };
export type WalletAsset = {
  kind: "native" | "token"; mint: string; tokenProgram: string | null; decimals: number;
  balance: string; totalBalance: string; account: string | null; eligible: boolean; reason: string | null;
};
export type WalletPosition = {
  positionMint: string; positionAccount: string; poolId: string; mintA: string; mintB: string;
  tickLower: number; tickUpper: number; tickCurrent: number; rangeSide: "below" | "inside" | "above";
  liquidity: string;
};

async function accountsInBatches(connection: Connection, keys: PublicKey[]) {
  const results: (AccountInfo<Buffer> | null)[] = [];
  for (let start = 0; start < keys.length; start += 100) {
    results.push(...await connection.getMultipleAccountsInfo(keys.slice(start, start + 100), "confirmed"));
  }
  return results;
}

function inputMintReason(mint: ReturnType<typeof unpackMint>) {
  const extensions = getExtensionTypes(mint.tlvData);
  const unknown = extensions.find((extension) => !SAFE_INPUT_EXTENSIONS.has(extension));
  if (unknown !== undefined) return `Unsupported Token-2022 extension: ${ExtensionType[unknown] || unknown}`;
  if (getDefaultAccountState(mint)?.state === AccountState.Frozen) return "Mint default account frozen";
  if (getPausableConfig(mint)?.paused) return "Mint is paused";
  const transferFee = getTransferFeeConfig(mint);
  if (transferFee && (transferFee.newerTransferFee.transferFeeBasisPoints > 0 || transferFee.olderTransferFee.transferFeeBasisPoints > 0)) return "Current transfer fee exists";
  const hook = getTransferHook(mint);
  if (hook?.programId && !hook.programId.equals(PublicKey.default)) return "Current TransferHook exists";
  const scaled = getScaledUiAmountConfig(mint);
  if (scaled && (scaled.multiplier !== 1 || scaled.newMultiplier !== 1)) return "ScaledUiAmount multiplier is not 1";
  return null;
}

export async function discoverWallet(walletAddress: string, connection = rpcConnection()) {
  const wallet = new PublicKey(walletAddress);
  const [legacy, token2022, solLamports, slot] = await Promise.all([
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
    connection.getBalance(wallet, "confirmed"), connection.getSlot("confirmed"),
  ]);
  const owned: OwnedToken[] = [...legacy.value, ...token2022.value].map(({ pubkey, account }) => {
    const decoded = unpackAccount(pubkey, account, account.owner);
    if (!decoded.owner.equals(wallet)) throw new Error("Wallet token account owner mismatch");
    return { account: pubkey, mint: decoded.mint, amount: decoded.amount,
      program: account.owner, frozen: decoded.isFrozen };
  }).filter((item) => item.amount > 0n);
  const byMint = new Map<string, OwnedToken[]>();
  for (const item of owned) {
    const mint = item.mint.toBase58();
    byMint.set(mint, [...(byMint.get(mint) || []), item]);
  }
  const mintKeys = [...byMint.keys()].map((mint) => new PublicKey(mint));
  const mintInfos = await accountsInBatches(connection, mintKeys);
  const mintData = new Map(mintKeys.map((key, index) => [key.toBase58(), mintInfos[index]] as const));
  const assets: WalletAsset[] = [];
  for (const [mint, tokenAccounts] of byMint) {
    const info = mintData.get(mint);
    const program = tokenAccounts[0]?.program;
    if (!program) continue;
    const totalBalance = tokenAccounts.reduce((sum, item) => sum + item.amount, 0n);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, program);
    const spendable = tokenAccounts.find((item) => item.account.equals(ata));
    let decimals = 0;
    let reason: string | null = null;
    if (!info || !info.owner.equals(program)) reason = "Mint account does not exist or token program mismatch";
    else {
      try {
        const decoded = unpackMint(new PublicKey(mint), info, program);
        decimals = decoded.decimals;
        if (decoded.decimals === 0 && decoded.supply === 1n) reason = "NFT cannot be used as input asset";
        else if (program.equals(TOKEN_2022_PROGRAM_ID)) reason = inputMintReason(decoded);
      } catch { reason = "Mint data cannot be parsed"; }
    }
    if (!reason && !spendable) reason = "Asset not in associated token account (ATA)";
    if (!reason && spendable?.frozen) reason = "Input asset ATA is frozen";
    assets.push({ kind: "token", mint, tokenProgram: program.toBase58(), decimals,
      balance: (spendable?.amount || 0n).toString(), totalBalance: totalBalance.toString(),
      account: spendable?.account.toBase58() || null, eligible: reason === null, reason });
  }
  assets.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.mint.localeCompare(b.mint));
  const availableSol = BigInt(solLamports) > BigInt(MIN_SOL_LAMPORTS) ? BigInt(solLamports - MIN_SOL_LAMPORTS) : 0n;
  assets.unshift({ kind: "native", mint: NATIVE_SOL_MINT, tokenProgram: null, decimals: 9,
    balance: availableSol.toString(), totalBalance: String(solLamports), account: null,
    eligible: availableSol > 0n, reason: availableSol > 0n ? null : "Insufficient SOL to reserve 0.01 SOL for network fees and rent" });

  const nftMints = [...byMint].filter(([mint, items]) =>
    items.some((item) => item.amount === 1n && !item.frozen) &&
    (() => {
      const info = mintData.get(mint);
      if (!info) return false;
      try { const decoded = unpackMint(new PublicKey(mint), info, info.owner); return decoded.decimals === 0 && decoded.supply === 1n; }
      catch { return false; }
    })()).map(([mint]) => new PublicKey(mint));
  const positionKeys = nftMints.map((mint) => getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, mint).publicKey);
  const positionInfos = await accountsInBatches(connection, positionKeys);
  const candidates = positionInfos.flatMap((info, index) => {
    const mint = nftMints[index];
    const address = positionKeys[index];
    if (!info || !mint || !address || !info.owner.equals(CLMM_PROGRAM_ID) ||
      !info.data.subarray(0, 8).equals(POSITION_DISCRIMINATOR)) return [];
    try {
      const position = PersonalPositionLayout.decode(info.data);
      return position.nftMint.equals(mint) && position.tickLower < position.tickUpper &&
        byMint.get(mint.toBase58())?.some((item) => item.amount === 1n && !item.frozen)
        ? [{ position, address }] : [];
    } catch { return []; }
  });
  const poolIds = [...new Set(candidates.map(({ position }) => position.poolId.toBase58()))];
  const poolKeys = poolIds.map((id) => new PublicKey(id));
  const poolInfos = await accountsInBatches(connection, poolKeys);
  const pools = new Map(poolIds.map((id, index) => [id, poolInfos[index]] as const));
  const positions: WalletPosition[] = candidates.flatMap(({ position, address }) => {
    const poolId = position.poolId.toBase58();
    const info = pools.get(poolId);
    if (!info || !info.owner.equals(CLMM_PROGRAM_ID) || !info.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) return [];
    try {
      const pool = PoolInfoLayout.decode(info.data);
      const lower = TickUtil.getSqrtPriceAtTick(position.tickLower);
      const upper = TickUtil.getSqrtPriceAtTick(position.tickUpper);
      return [{ positionMint: position.nftMint.toBase58(), positionAccount: address.toBase58(), poolId,
        mintA: pool.mintA.toBase58(), mintB: pool.mintB.toBase58(), tickLower: position.tickLower,
        tickUpper: position.tickUpper, tickCurrent: pool.tickCurrent,
        rangeSide: positionSide(BigInt(pool.sqrtPriceX64.toString()), BigInt(lower.toString()), BigInt(upper.toString())),
        liquidity: position.liquidity.toString() }];
    } catch { return []; }
  });
  positions.sort((a, b) => a.poolId.localeCompare(b.poolId) || a.tickLower - b.tickLower || a.positionMint.localeCompare(b.positionMint));
  return { wallet: walletAddress, slot, fetchedAt: Date.now(), positions, assets };
}

export type WalletDiscovery = Awaited<ReturnType<typeof discoverWallet>>;
