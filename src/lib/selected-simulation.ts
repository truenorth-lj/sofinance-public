import "server-only";

import { PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import type { SelectedPositionState } from "./selected-state";

type VerifyInput = {
  connection: Connection; transaction: VersionedTransaction; wallet: PublicKey;
  state: SelectedPositionState; requested: bigint; expectedLiquidity: bigint; sigVerify: boolean;
};

function decodeToken(info: AccountInfo<Buffer> | null, key: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  if (!info) return 0n;
  if (!info.owner.equals(program)) throw new Error("Token ATA program mismatch");
  const account = unpackAccount(key, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint)) throw new Error("Token ATA owner or mint mismatch");
  return account.amount;
}

export async function simulateAndVerifySelectedTransaction(input: VerifyInput) {
  const { connection, transaction, wallet, state, requested, expectedLiquidity, sigVerify } = input;
  const nftAta = new PublicKey(state.nftAta);
  const ataA = new PublicKey(state.ataA);
  const ataB = new PublicKey(state.ataB);
  const inputAta = state.inputKind === "token" ? new PublicKey(state.inputAccount!) : null;
  const wsolAta = state.inputKind === "native"
    ? getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID) : null;
  const keys = [...new Map([nftAta, ataA, ataB, ...(inputAta ? [inputAta] : []), ...(wsolAta ? [wsolAta] : [])]
    .map((key) => [key.toBase58(), key])).values()];
  const beforeInfos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const before = new Map(keys.map((key, index) => [key.toBase58(), beforeInfos[index] ?? null] as const));
  const tokenBefore = (key: PublicKey, program: string, mint: string) =>
    decodeToken(before.get(key.toBase58()) ?? null, key, new PublicKey(program), wallet, new PublicKey(mint));
  const nftBefore = tokenBefore(nftAta, state.nftProgram, state.positionMint);
  if (nftBefore !== 1n) throw new Error("Selected position NFT ATA no longer held by wallet");
  const amountA = tokenBefore(ataA, state.programA, state.mintA);
  const amountB = tokenBefore(ataB, state.programB, state.mintB);
  const inputBefore = inputAta ? tokenBefore(inputAta, state.inputTokenProgram!, state.inputMint) : null;
  if (inputBefore !== null && inputBefore < requested) throw new Error("Input asset ATA balance insufficient");
  if (wsolAta && tokenBefore(wsolAta, TOKEN_PROGRAM_ID.toBase58(), NATIVE_SOL_MINT) !== 0n) {
    throw new Error("Native SOL input already has WSOL ATA balance, please handle separately to avoid using existing WSOL");
  }
  const solBefore = await connection.getBalance(wallet, "confirmed");
  if (state.inputKind === "native" && BigInt(solBefore) < requested + BigInt(MIN_SOL_LAMPORTS)) {
    throw new Error("Native SOL insufficient to pay input and reserved fees");
  }
  const addresses = [state.positionAccount, ...keys.map((key) => key.toBase58()), wallet.toBase58()];
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify, commitment: "confirmed", accounts: { encoding: "base64", addresses },
  });
  if (simulation.value.err) {
    throw new Error(`Complete swap + add simulation failed: ${JSON.stringify(simulation.value.err)}; ${simulation.value.logs?.slice(-5).join(" | ") || "no logs"}`);
  }
  const simulated = simulation.value.accounts;
  const positionResult = simulated?.[0];
  const positionData = positionResult?.data[0];
  if (!positionResult || positionResult.owner !== state.programId || !positionData) throw new Error("Simulation did not read back selected position account");
  const position = PersonalPositionLayout.decode(Buffer.from(positionData, "base64"));
  if (position.nftMint.toBase58() !== state.positionMint || position.poolId.toBase58() !== state.poolId ||
    position.tickLower !== state.tickLower || position.tickUpper !== state.tickUpper ||
    BigInt(position.liquidity.toString()) - BigInt(state.liquidity) !== expectedLiquidity) {
    throw new Error("Simulated selected NFT liquidity increment mismatch");
  }
  const afterInfo = new Map(keys.map((key, index) => {
    const account = simulated?.[index + 1];
    if (!account) return [key.toBase58(), null] as const;
    const data = account.data[0];
    if (!data) throw new Error("Simulated token ATA data missing");
    return [key.toBase58(), { data: Buffer.from(data, "base64"), owner: new PublicKey(account.owner),
      lamports: account.lamports, executable: account.executable, rentEpoch: account.rentEpoch ?? 0 }] as const;
  }));
  const tokenAfter = (key: PublicKey, program: string, mint: string) =>
    decodeToken(afterInfo.get(key.toBase58()) ?? null, key, new PublicKey(program), wallet, new PublicKey(mint));
  if (tokenAfter(nftAta, state.nftProgram, state.positionMint) !== 1n) throw new Error("Simulated selected position NFT left wallet");
  const afterA = tokenAfter(ataA, state.programA, state.mintA);
  const afterB = tokenAfter(ataB, state.programB, state.mintB);
  const inputAfter = inputAta ? tokenAfter(inputAta, state.inputTokenProgram!, state.inputMint) : null;
  if (state.inputMint !== state.mintA && afterA < amountA) throw new Error("Simulation used original pool asset A");
  if (state.inputMint !== state.mintB && afterB < amountB) throw new Error("Simulation used original pool asset B");
  const solResult = simulated?.[addresses.length - 1];
  if (!solResult) throw new Error("Simulation did not read back wallet SOL account");
  const solDebit = BigInt(solBefore) - BigInt(solResult.lamports);
  const maxSolDebit = state.inputKind === "native" ? requested + 10_000_000n : 10_000_000n;
  if (solDebit < 0n || solDebit > maxSolDebit || BigInt(solResult.lamports) < BigInt(MIN_SOL_LAMPORTS)) {
    throw new Error("Simulated SOL expenditure or remaining balance exceeds limit");
  }
  let spentInput: bigint | null = null;
  if (inputBefore !== null && inputAfter !== null) {
    spentInput = inputBefore - inputAfter;
    const directInput = state.inputMint === state.mintA || state.inputMint === state.mintB;
    if (spentInput <= 0n || spentInput > requested || (!directInput && requested - spentInput > 1n)) {
      throw new Error("Simulated input asset expenditure does not match limit");
    }
  } else if (solDebit < requested - 1n) {
    throw new Error("Simulated native SOL expenditure below selected input amount");
  }
  return {
    unitsConsumed: simulation.value.unitsConsumed, endingLiquidity: position.liquidity.toString(),
    spentInput: spentInput?.toString() || null, solDebitLamports: solDebit.toString(),
    dustA: (afterA - amountA + (state.inputKind === "token" && state.inputMint === state.mintA ? requested : 0n)).toString(),
    dustB: (afterB - amountB + (state.inputKind === "token" && state.inputMint === state.mintB ? requested : 0n)).toString(),
  };
}
