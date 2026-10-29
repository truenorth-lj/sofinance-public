import { transactionIntermediateAccounts, verifyIntermediateAccounts } from "./swap/instructions";
import { getPdaPersonalPositionAddress, PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { walletPriorityFeeAllowance } from "./wallet-priority-fee";
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
  /** Minimum wallet SOL that must remain. Defaults to MIN_SOL_LAMPORTS; sponsored mode passes 0n (the wallet may hold no SOL). */
  minRemainingSolLamports?: bigint;
  /** Prepared message; wallet-raised ComputeBudget priority is allowed up to 0.01 SOL extra. */
  prepared?: VersionedTransaction;
  /**
   * Earliest slot the "before" snapshot may be read at, e.g. the slot of a confirmed step-1
   * swap whose output this open deposits. Without it, a provider still behind that swap would
   * report pre-swap balances and the swap's own SOL spend would count against this open's cap.
   */
  minContextSlot?: number;
};

function decodeToken(info: AccountInfo<Buffer> | null, key: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  if (!info) return 0n;
  if (!info.owner.equals(program)) throw new Error("Token ATA program mismatch");
  const account = unpackAccount(key, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint)) throw new Error("Token ATA owner or mint mismatch");
  return account.amount;
}

export function simulatedAccount(
  account: { data: string[]; owner: string; lamports: number; executable: boolean; rentEpoch?: number } | null | undefined,
) {
  if (!account) return null;
  const data = account.data[0];
  // RPC may represent a closed WSOL ATA as a zero-lamport system account
  // with empty bytes instead of null. It has no remaining token balance.
  if (data === "" && account.lamports === 0 && account.owner === SystemProgram.programId.toBase58() && !account.executable) return null;
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
  const minRemainingSol = input.minRemainingSolLamports ?? BigInt(MIN_SOL_LAMPORTS);
  const sponsoredWallet = input.minRemainingSolLamports !== undefined;
  const nftAta = getAssociatedTokenAddressSync(nftMint, wallet, false, TOKEN_2022_PROGRAM_ID);
  const positionAccount = getPdaPersonalPositionAddress(new PublicKey(state.programId), nftMint).publicKey;
  const ataA = new PublicKey(state.ataA);
  const ataB = new PublicKey(state.ataB);
  const inputAta = state.inputKind === "token" ? new PublicKey(state.inputAccount!) : null;
  const wsolAta = state.inputKind === "native"
    ? getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID) : null;
  const keys = [...new Map([nftAta, ataA, ataB, ...(inputAta ? [inputAta] : []), ...(wsolAta ? [wsolAta] : [])]
    .map((key) => [key.toBase58(), key])).values()];
  // One snapshot (wallet SOL + token accounts) on the slot-context route, i.e. the same providers
  // as simulateTransaction, which then runs at or after that slot. Separate read-route calls could
  // land on a provider that lags the simulator, so SOL "before" and "after" came from different
  // slots and anything confirmed in between (a step-1 swap) was billed to this open.
  const snapshot = await connection.getMultipleAccountsInfoAndContext([...keys, wallet], {
    commitment: "confirmed", ...(input.minContextSlot ? { minContextSlot: input.minContextSlot } : {}),
  });
  const beforeInfos = snapshot.value;
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
  // A wallet with no system account (sponsored, zero SOL) reads as null: 0 lamports.
  const solBefore = beforeInfos[keys.length]?.lamports ?? 0;
  if (state.inputKind === "native" && BigInt(solBefore) < requested + BigInt(MIN_SOL_LAMPORTS)) {
    throw new Error("Native SOL insufficient to pay input and reserved fees");
  }
  const intermediate = await transactionIntermediateAccounts(connection, transaction, wallet, keys.map(key => key.toBase58()));
  const addresses = [positionAccount.toBase58(), ...keys.map((key) => key.toBase58()), ...intermediate.accounts.map(account => account.address), wallet.toBase58()];
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify, commitment: "confirmed", minContextSlot: Math.max(snapshot.context.slot, intermediate.slot, input.minContextSlot ?? 0), accounts: { encoding: "base64", addresses },
  });
  if (simulation.value.err) {
    throw new Error(`Open-position simulation failed: ${JSON.stringify(simulation.value.err)}; ${simulation.value.logs?.slice(-5).join(" | ") || "no logs"}`);
  }
  const simulated = simulation.value.accounts;
  verifyIntermediateAccounts(intermediate.accounts, addresses, simulated, wallet);
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
  const solRead = simulated?.[addresses.length - 1];
  // A zero-SOL wallet has no system account; in sponsored mode that reads back as 0 lamports.
  const solResult = solRead ?? (sponsoredWallet && solBefore === 0 ? { lamports: 0 } : null);
  if (!solResult) throw new Error("Simulation did not read back wallet SOL account");
  const solDebit = BigInt(solBefore) - BigInt(solResult.lamports);
  // A priority fee the wallet added after prepare (Phantom prices it per requested CU and shows
  // it on its confirm screen) is the user's own network-fee choice, bounded by the allowance
  // ceiling. It may raise the debit cap and must not by itself breach the SOL reserve that
  // prepare already checked against our rent + fees; any other extra SOL movement still fails.
  const walletPriority = walletPriorityFeeAllowance(input.prepared, transaction);
  const debitCap = maxSolDebitLamports + walletPriority;
  if (solDebit < 0n || solDebit > debitCap || BigInt(solResult.lamports) + walletPriority < minRemainingSol) {
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
