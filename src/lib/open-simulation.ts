import "server-only";

import { getPdaPersonalPositionAddress, PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { simulatedInputSpendMatches } from "./amount";
import type { OpenPoolState } from "./open-state";

type VerifyInput = {
  connection: Connection;
  transaction: VersionedTransaction;
  wallet: PublicKey;
  state: OpenPoolState;
  nftMint: PublicKey;
  tickLower: number;
  tickUpper: number;
  requested: bigint;
  expectedLiquidity: bigint;
  maxSolDebitLamports: bigint;
  sigVerify: boolean;
};

function decodeToken(info: AccountInfo<Buffer> | null, key: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  if (!info) return 0n;
  if (!info.owner.equals(program)) throw new Error("Token ATA program mismatch");
  const account = unpackAccount(key, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint)) throw new Error("Token ATA owner or mint mismatch");
  return account.amount;
}

function simulatedAccount(
  account: { data: string[]; owner: string; lamports: number; executable: boolean; rentEpoch?: number } | null | undefined,
) {
  if (!account) return null;
  const data = account.data[0];
  if (!data) throw new Error("Simulated account data missing");
  return {
    data: Buffer.from(data, "base64"),
    owner: new PublicKey(account.owner),
    lamports: account.lamports,
    executable: account.executable,
    rentEpoch: account.rentEpoch ?? 0,
  };
}

export async function simulateAndVerifyOpenTransaction(input: VerifyInput) {
  const {
    connection, transaction, wallet, state, nftMint, tickLower, tickUpper,
    requested, expectedLiquidity, maxSolDebitLamports, sigVerify,
  } = input;
  const nftAta = getAssociatedTokenAddressSync(nftMint, wallet, false, TOKEN_2022_PROGRAM_ID);
  const positionAccount = getPdaPersonalPositionAddress(new PublicKey(state.programId), nftMint).publicKey;
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
  if (tokenBefore(nftAta, TOKEN_2022_PROGRAM_ID.toBase58(), nftMint.toBase58()) !== 0n) {
    throw new Error("Position NFT mint ATA already exists with a balance");
  }
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
  const addresses = [positionAccount.toBase58(), ...keys.map((key) => key.toBase58()), wallet.toBase58()];
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify, commitment: "confirmed", accounts: { encoding: "base64", addresses },
  });
  if (simulation.value.err) {
    throw new Error(`Open-position simulation failed: ${JSON.stringify(simulation.value.err)}; ${simulation.value.logs?.slice(-5).join(" | ") || "no logs"}`);
  }
  const simulated = simulation.value.accounts;
  const positionResult = simulated?.[0];
  const positionData = positionResult?.data[0];
  if (!positionResult || positionResult.owner !== state.programId || !positionData) {
    throw new Error("Simulation did not create the personal position account");
  }
  const position = PersonalPositionLayout.decode(Buffer.from(positionData, "base64"));
  if (position.nftMint.toBase58() !== nftMint.toBase58() || position.poolId.toBase58() !== state.poolId ||
    position.tickLower !== tickLower || position.tickUpper !== tickUpper ||
    BigInt(position.liquidity.toString()) !== expectedLiquidity) {
    throw new Error("Simulated new position NFT, ticks, or liquidity mismatch");
  }
  const afterInfo = new Map(keys.map((key, index) => {
    const account = simulatedAccount(simulated?.[index + 1] ?? null);
    return [key.toBase58(), account] as const;
  }));
  const tokenAfter = (key: PublicKey, program: string, mint: string) =>
    decodeToken(afterInfo.get(key.toBase58()) ?? null, key, new PublicKey(program), wallet, new PublicKey(mint));
  if (tokenAfter(nftAta, TOKEN_2022_PROGRAM_ID.toBase58(), nftMint.toBase58()) !== 1n) {
    throw new Error("Simulated position NFT was not minted to the wallet ATA");
  }
  const afterA = tokenAfter(ataA, state.programA, state.mintA);
  const afterB = tokenAfter(ataB, state.programB, state.mintB);
  const inputAfter = inputAta ? tokenAfter(inputAta, state.inputTokenProgram!, state.inputMint) : null;
  if (state.inputMint !== state.mintA && afterA < amountA) throw new Error("Simulation used original pool asset A");
  if (state.inputMint !== state.mintB && afterB < amountB) throw new Error("Simulation used original pool asset B");
  const solResult = simulated?.[addresses.length - 1];
  if (!solResult) throw new Error("Simulation did not read back wallet SOL account");
  const solDebit = BigInt(solBefore) - BigInt(solResult.lamports);
  if (solDebit < 0n || solDebit > maxSolDebitLamports || BigInt(solResult.lamports) < BigInt(MIN_SOL_LAMPORTS)) {
    throw new Error("Simulated SOL expenditure or remaining balance exceeds limit");
  }
  let spentInput: bigint | null = null;
  if (inputBefore !== null && inputAfter !== null) {
    spentInput = inputBefore - inputAfter;
    const directInput = state.inputMint === state.mintA || state.inputMint === state.mintB;
    if (spentInput <= 0n || spentInput > requested || (!directInput && !simulatedInputSpendMatches(spentInput, requested))) {
      throw new Error(`Simulated input asset expenditure does not match limit (spent ${spentInput} of ${requested}, direct=${directInput})`);
    }
  } else if (solDebit < requested - 1n) {
    throw new Error("Simulated native SOL expenditure below selected input amount");
  }
  return {
    unitsConsumed: simulation.value.unitsConsumed,
    endingLiquidity: position.liquidity.toString(),
    spentInput: spentInput?.toString() || null,
    solDebitLamports: solDebit.toString(),
    positionAccount: positionAccount.toBase58(),
    nftAta: nftAta.toBase58(),
    dustA: (afterA - amountA + (state.inputKind === "token" && state.inputMint === state.mintA ? requested : 0n)).toString(),
    dustB: (afterB - amountB + (state.inputKind === "token" && state.inputMint === state.mintB ? requested : 0n)).toString(),
  };
}
