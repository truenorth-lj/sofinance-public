import "server-only";

import { ClmmConfigLayout, CLMM_PROGRAM_ID, PoolInfoLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import {
  AccountState, ExtensionType, getAssociatedTokenAddressSync, getDefaultAccountState, getExtensionTypes,
  getPausableConfig, getScaledUiAmountConfig, getTransferFeeConfig, getTransferHook,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT, USDC_MINT } from "./ids";
import { rpcConnection } from "./rpc";
import { resolveMintSymbols } from "./mint-symbols";
import { discoverWallet } from "./wallet-discovery";

const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
const supportedPoolExtensions = new Set([
  ExtensionType.MintCloseAuthority, ExtensionType.PermanentDelegate, ExtensionType.PausableConfig,
  ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroupMember,
  ExtensionType.DefaultAccountState, ExtensionType.ConfidentialTransferMint,
  ExtensionType.TransferHook, ExtensionType.ScaledUiAmountConfig,
]);

export type OpenPositionSelection = {
  poolId: string;
  inputMint: string;
  inputKind: "native" | "token";
};

function checkedMint(key: PublicKey, info: AccountInfo<Buffer> | null) {
  if (!info || !tokenPrograms.includes(info.owner.toBase58())) {
    throw new Error("Pool asset mint does not exist or token program mismatch");
  }
  return { mint: unpackMint(key, info, info.owner), program: info.owner };
}

function poolMintIssues(mint: ReturnType<typeof unpackMint>) {
  const extensions = getExtensionTypes(mint.tlvData);
  const issues = extensions.filter((extension) => !supportedPoolExtensions.has(extension))
    .map((extension) => ExtensionType[extension] || String(extension));
  if (extensions.includes(ExtensionType.DefaultAccountState) && getDefaultAccountState(mint)?.state !== AccountState.Initialized) {
    issues.push("DefaultAccountState not Initialized");
  }
  const hook = getTransferHook(mint);
  if (hook?.programId && !hook.programId.equals(PublicKey.default)) issues.push("TransferHook enabled");
  const scaled = getScaledUiAmountConfig(mint);
  if (scaled && (scaled.multiplier !== 1 || scaled.newMultiplier !== 1)) issues.push("ScaledUiAmount multiplier not 1");
  return issues;
}

function tokenAmount(info: AccountInfo<Buffer> | null, key: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  if (!info) return { amount: 0n, frozen: false };
  if (!info.owner.equals(program)) throw new Error("Token ATA program and mint mismatch");
  const account = unpackAccount(key, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint)) throw new Error("Token ATA owner or mint mismatch");
  return { amount: account.amount, frozen: account.isFrozen };
}

export function assertOpenInputAsset(inputMint: string, inputKind: "native" | "token", mintA: string, mintB: string) {
  if (inputKind === "native" && inputMint !== NATIVE_SOL_MINT) throw new Error("Native SOL mint mismatch");
  const allowed = new Set([NATIVE_SOL_MINT, USDC_MINT, mintA, mintB]);
  if (!allowed.has(inputMint)) {
    throw new Error("Open-position input must be SOL, USDC, or a token in this pool");
  }
}

export async function readOpenPoolState(
  walletAddress: string,
  selection: OpenPositionSelection,
  connection: Connection = rpcConnection(),
) {
  const wallet = new PublicKey(walletAddress);
  const poolId = new PublicKey(selection.poolId);
  if (selection.inputKind === "native" && selection.inputMint !== NATIVE_SOL_MINT) {
    throw new Error("Native SOL mint mismatch");
  }
  const discovered = await discoverWallet(walletAddress, connection);
  const inputAsset = discovered.assets.find((item) => item.kind === selection.inputKind && item.mint === selection.inputMint);
  if (!inputAsset || !inputAsset.eligible) {
    throw new Error(inputAsset?.reason || "Wallet does not have the selected investable asset");
  }
  const poolInfo = await connection.getAccountInfo(poolId, "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(CLMM_PROGRAM_ID)) {
    throw new Error("Raydium CLMM pool account does not exist");
  }
  const pool = PoolInfoLayout.decode(poolInfo.data);
  if (pool.mintA.equals(pool.mintB)) throw new Error("Pool mint A and B are identical");
  const [mintAInfo, mintBInfo, vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo(
    [pool.mintA, pool.mintB, pool.vaultA, pool.vaultB], "confirmed",
  );
  const mintA = checkedMint(pool.mintA, mintAInfo ?? null);
  const mintB = checkedMint(pool.mintB, mintBInfo ?? null);
  if (mintA.mint.decimals !== pool.mintDecimalsA || mintB.mint.decimals !== pool.mintDecimalsB) {
    throw new Error("Pool mint or decimals mismatch");
  }
  if (!vaultAInfo || !vaultBInfo) throw new Error("Pool vault does not exist");
  const vaultA = unpackAccount(pool.vaultA, vaultAInfo, vaultAInfo.owner);
  const vaultB = unpackAccount(pool.vaultB, vaultBInfo, vaultBInfo.owner);
  if (!vaultA.mint.equals(pool.mintA) || !vaultB.mint.equals(pool.mintB) ||
    !vaultAInfo.owner.equals(mintA.program) || !vaultBInfo.owner.equals(mintB.program)) {
    throw new Error("Pool vault mint or program mismatch");
  }
  assertOpenInputAsset(selection.inputMint, selection.inputKind, pool.mintA.toBase58(), pool.mintB.toBase58());
  const ataA = getAssociatedTokenAddressSync(pool.mintA, wallet, false, mintA.program);
  const ataB = getAssociatedTokenAddressSync(pool.mintB, wallet, false, mintB.program);
  const [ataAInfo, ataBInfo] = await connection.getMultipleAccountsInfo([ataA, ataB], "confirmed");
  const balanceA = tokenAmount(ataAInfo ?? null, ataA, mintA.program, wallet, pool.mintA);
  const balanceB = tokenAmount(ataBInfo ?? null, ataB, mintB.program, wallet, pool.mintB);
  const paused = [mintA.mint, mintB.mint].some((mint) => getPausableConfig(mint)?.paused);
  const transferFee = [mintA.mint, mintB.mint].some((mint) => {
    const config = getTransferFeeConfig(mint);
    return config && (config.newerTransferFee.transferFeeBasisPoints > 0 || config.olderTransferFee.transferFeeBasisPoints > 0);
  });
  const unsupportedExtensions = [...new Set([mintA.mint, mintB.mint].flatMap(poolMintIssues))];
  const frozen = vaultA.isFrozen || vaultB.isFrozen || balanceA.frozen || balanceB.frozen;
  const freezeRiskA = mintA.mint.freezeAuthority !== null;
  const freezeRiskB = mintB.mint.freezeAuthority !== null;
  const token2022A = mintA.program.equals(TOKEN_2022_PROGRAM_ID);
  const token2022B = mintB.program.equals(TOKEN_2022_PROGRAM_ID);
  const solLamports = await connection.getBalance(wallet, "confirmed");
  const inputBalance = selection.inputKind === "native"
    ? Math.max(0, solLamports - MIN_SOL_LAMPORTS).toString() : inputAsset.balance;
  if (pool.status & 1) throw new Error("This pool has disabled opening or adding liquidity");
  let feeTierBps: number | null = null;
  try {
    const configId = pool.configId;
    if (configId) {
      const configInfo = await connection.getAccountInfo(configId, "confirmed");
      if (configInfo && configInfo.owner.equals(CLMM_PROGRAM_ID)) {
        const rate = Number(ClmmConfigLayout.decode(configInfo.data).tradeFeeRate);
        if (Number.isFinite(rate) && rate >= 0) feeTierBps = rate / 100;
      }
    }
  } catch {
    feeTierBps = null;
  }
  const fromWallet = discovered.positions.find((item) => item.poolId === poolId.toBase58());
  let symbolA = fromWallet?.symbolA ?? null;
  let symbolB = fromWallet?.symbolB ?? null;
  if (!symbolA || !symbolB) {
    try {
      const symbols = await resolveMintSymbols([pool.mintA.toBase58(), pool.mintB.toBase58()]);
      symbolA = symbolA ?? symbols[pool.mintA.toBase58()] ?? null;
      symbolB = symbolB ?? symbols[pool.mintB.toBase58()] ?? null;
    } catch {
      /* shortened mints in the UI */
    }
  }
  return {
    wallet: walletAddress, slot: discovered.slot, fetchedAt: Date.now(),
    poolId: poolId.toBase58(), programId: CLMM_PROGRAM_ID.toBase58(),
    symbolA, symbolB, feeTierBps,
    inputKind: selection.inputKind, inputMint: selection.inputMint,
    inputDecimals: inputAsset.decimals, inputTokenProgram: inputAsset.tokenProgram,
    inputAccount: inputAsset.account, inputBalance,
    mintA: pool.mintA.toBase58(), mintB: pool.mintB.toBase58(),
    decimalsA: mintA.mint.decimals, decimalsB: mintB.mint.decimals,
    programA: mintA.program.toBase58(), programB: mintB.program.toBase58(),
    ataA: ataA.toBase58(), ataB: ataB.toBase58(),
    vaultA: pool.vaultA.toBase58(), vaultB: pool.vaultB.toBase58(),
    balances: { a: balanceA.amount.toString(), b: balanceB.amount.toString(), input: inputBalance },
    sqrtPriceX64: pool.sqrtPriceX64.toString(), tickCurrent: pool.tickCurrent,
    tickSpacing: pool.tickSpacing, poolLiquidity: pool.liquidity.toString(),
    price: TickUtil.sqrtPriceX64ToPrice(pool.sqrtPriceX64, pool.mintDecimalsA, pool.mintDecimalsB).toString(),
    paused: Boolean(paused), transferFee: Boolean(transferFee), frozen,
    freezeRiskA, freezeRiskB, freezeRisk: freezeRiskA || freezeRiskB,
    token2022A, token2022B, unsupportedExtensions,
    solLamports, sufficientSol: solLamports >= MIN_SOL_LAMPORTS,
  };
}

export type OpenPoolState = Awaited<ReturnType<typeof readOpenPoolState>>;
