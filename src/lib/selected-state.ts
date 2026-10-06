import "server-only";

import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, LiquidityMathUtil, PersonalPositionLayout, PoolInfoLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import {
  AccountState, ExtensionType, getAssociatedTokenAddressSync, getDefaultAccountState, getExtensionTypes,
  getPausableConfig, getScaledUiAmountConfig, getTransferFeeConfig, getTransferHook,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { positionSide } from "./quote-math";
import { rpcConnection } from "./rpc";
import { discoverWallet } from "./wallet-discovery";

export type PositionSelection = { positionMint: string; inputMint: string; inputKind: "native" | "token" };
const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
const supportedPoolExtensions = new Set([
  ExtensionType.MintCloseAuthority, ExtensionType.PermanentDelegate, ExtensionType.PausableConfig,
  ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroupMember,
  ExtensionType.DefaultAccountState, ExtensionType.ConfidentialTransferMint,
  ExtensionType.TransferHook, ExtensionType.ScaledUiAmountConfig,
]);

function checkedMint(key: PublicKey, info: AccountInfo<Buffer> | null) {
  if (!info || !tokenPrograms.includes(info.owner.toBase58())) throw new Error("Pool asset or NFT mint does not exist or token program mismatch");
  return { mint: unpackMint(key, info, info.owner), program: info.owner };
}

function poolMintIssues(mint: ReturnType<typeof unpackMint>) {
  const extensions = getExtensionTypes(mint.tlvData);
  const issues = extensions.filter((extension) => !supportedPoolExtensions.has(extension))
    .map((extension) => ExtensionType[extension] || String(extension));
  if (extensions.includes(ExtensionType.DefaultAccountState) && getDefaultAccountState(mint)?.state !== AccountState.Initialized) issues.push("DefaultAccountState not Initialized");
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

export async function readSelectedPositionState(
  walletAddress: string, selection: PositionSelection, connection: Connection = rpcConnection(),
  allowEmptyInput = false,
) {
  const wallet = new PublicKey(walletAddress);
  const nftMint = new PublicKey(selection.positionMint);
  if (selection.inputKind === "native" && selection.inputMint !== NATIVE_SOL_MINT) throw new Error("Native SOL mint mismatch");
  const discovered = await discoverWallet(walletAddress, connection);
  const selectedPosition = discovered.positions.find((item) => item.positionMint === selection.positionMint);
  let inputAsset = discovered.assets.find((item) => item.kind === selection.inputKind && item.mint === selection.inputMint);
  if (!selectedPosition) throw new Error("Wallet does not currently hold this Raydium CLMM position NFT");
  if ((!inputAsset || !inputAsset.eligible) && !allowEmptyInput) throw new Error(inputAsset?.reason || "Wallet does not have the selected investable asset");
  if (!inputAsset && allowEmptyInput) {
    if (selection.inputKind === "native") {
      inputAsset = { kind: "native", mint: NATIVE_SOL_MINT, tokenProgram: null, decimals: 9,
        balance: "0", totalBalance: "0", account: null, eligible: false, reason: "Balance exhausted" };
    } else {
      const inputInfo = await connection.getAccountInfo(new PublicKey(selection.inputMint), "confirmed");
      const decoded = checkedMint(new PublicKey(selection.inputMint), inputInfo);
      inputAsset = { kind: "token", mint: selection.inputMint, tokenProgram: decoded.program.toBase58(),
        decimals: decoded.mint.decimals, balance: "0", totalBalance: "0", account: null,
        eligible: false, reason: "Balance exhausted" };
    }
  }
  if (!inputAsset) throw new Error("Input asset mint does not exist");
  const positionKey = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nftMint).publicKey;
  if (positionKey.toBase58() !== selectedPosition.positionAccount) throw new Error("Position PDA does not match selection");
  const [positionInfo, poolInfo, nftMintInfo] = await connection.getMultipleAccountsInfo([
    positionKey, new PublicKey(selectedPosition.poolId), nftMint,
  ], "confirmed");
  if (!positionInfo || !poolInfo || !positionInfo.owner.equals(CLMM_PROGRAM_ID) || !poolInfo.owner.equals(CLMM_PROGRAM_ID)) {
    throw new Error("Position or pool account has changed");
  }
  const position = PersonalPositionLayout.decode(positionInfo.data);
  const pool = PoolInfoLayout.decode(poolInfo.data);
  if (!position.nftMint.equals(nftMint) || position.poolId.toBase58() !== selectedPosition.poolId ||
    position.tickLower >= position.tickUpper) throw new Error("Position NFT, pool, or ticks mismatch");
  const nft = checkedMint(nftMint, nftMintInfo ?? null);
  if (nft.mint.decimals !== 0 || nft.mint.supply !== 1n) throw new Error("Position NFT mint has changed");
  const [mintAInfo, mintBInfo, vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo([
    pool.mintA, pool.mintB, pool.vaultA, pool.vaultB,
  ], "confirmed");
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
  const [nftAtaInfo, ataAInfo, ataBInfo] = await connection.getMultipleAccountsInfo([nftAta, ataA, ataB], "confirmed");
  const nftBalance = tokenAmount(nftAtaInfo ?? null, nftAta, nft.program, wallet, nftMint);
  const balanceA = tokenAmount(ataAInfo ?? null, ataA, mintA.program, wallet, pool.mintA);
  const balanceB = tokenAmount(ataBInfo ?? null, ataB, mintB.program, wallet, pool.mintB);
  const ownsNft = nftBalance.amount === 1n && !nftBalance.frozen;
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
  const solLamports = await connection.getBalance(wallet, "confirmed");
  const inputBalance = selection.inputKind === "native"
    ? Math.max(0, solLamports - MIN_SOL_LAMPORTS).toString() : inputAsset.balance;
  return {
    wallet: walletAddress, slot: discovered.slot, fetchedAt: Date.now(),
    positionMint: selection.positionMint, positionAccount: positionKey.toBase58(), poolId: selectedPosition.poolId,
    programId: CLMM_PROGRAM_ID.toBase58(), inputKind: selection.inputKind, inputMint: selection.inputMint,
    inputDecimals: inputAsset.decimals, inputTokenProgram: inputAsset.tokenProgram,
    inputAccount: inputAsset.account, inputBalance,
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
  };
}

export type SelectedPositionState = Awaited<ReturnType<typeof readSelectedPositionState>>;
