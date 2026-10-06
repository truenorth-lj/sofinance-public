import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type AccountInfo } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
import { simulateAndVerifySelectedTransaction } from "./selected-simulation";
import type { SelectedPositionState } from "./selected-state";

function info(data: Buffer, owner = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 2_039_280, rentEpoch: 0 };
}

function tokenData(mint: PublicKey, wallet: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  wallet.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108);
  return data;
}

function simulatedToken(mint: PublicKey, wallet: PublicKey, amount: bigint) {
  return { owner: TOKEN_PROGRAM_ID.toBase58(), data: [tokenData(mint, wallet, amount).toString("base64"), "base64"],
    lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

it("checks the chosen token debit, other pool balances, NFT and exact liquidity increase", async () => {
  const wallet = Keypair.generate().publicKey;
  const nftMint = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const inputMint = Keypair.generate().publicKey;
  const mintA = Keypair.generate().publicKey;
  const mintB = Keypair.generate().publicKey;
  const positionAccount = Keypair.generate().publicKey;
  const nftAta = getAssociatedTokenAddressSync(nftMint, wallet);
  const ataA = getAssociatedTokenAddressSync(mintA, wallet);
  const ataB = getAssociatedTokenAddressSync(mintB, wallet);
  const inputAta = getAssociatedTokenAddressSync(inputMint, wallet);
  const before = new Map([
    [nftAta.toBase58(), info(tokenData(nftMint, wallet, 1n))],
    [ataA.toBase58(), info(tokenData(mintA, wallet, 10n))],
    [ataB.toBase58(), info(tokenData(mintB, wallet, 5n))],
    [inputAta.toBase58(), info(tokenData(inputMint, wallet, 1_000n))],
  ]);
  const positionData = Buffer.alloc(PersonalPositionLayout.span);
  createHash("sha256").update("account:PersonalPositionState").digest().copy(positionData, 0, 0, 8);
  nftMint.toBuffer().copy(positionData, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(positionData, PersonalPositionLayout.offsetOf("poolId"));
  positionData.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  positionData.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  positionData.writeBigUInt64LE(15n, PersonalPositionLayout.offsetOf("liquidity"));
  const accountResults = (afterA: bigint) => [
    { owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", data: [positionData.toString("base64"), "base64"], lamports: 0, executable: false, rentEpoch: 0 },
    simulatedToken(nftMint, wallet, 1n), simulatedToken(mintA, wallet, afterA),
    simulatedToken(mintB, wallet, 5n), simulatedToken(inputMint, wallet, 0n),
    { owner: SystemProgram.programId.toBase58(), data: ["", "base64"], lamports: 99_000_000,
      executable: false, rentEpoch: 0 },
  ];
  const connection = {
    getMultipleAccountsInfo: vi.fn().mockImplementation(async (keys: PublicKey[]) => keys.map((key) => before.get(key.toBase58()) || null)),
    getBalance: vi.fn().mockResolvedValue(100_000_000),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, accounts: accountResults(10n), unitsConsumed: 100_000 } }),
  } as unknown as Connection;
  const state = { wallet: wallet.toBase58(), positionMint: nftMint.toBase58(), poolId: pool.toBase58(),
    positionAccount: positionAccount.toBase58(), programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    nftAta: nftAta.toBase58(), nftProgram: TOKEN_PROGRAM_ID.toBase58(),
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), ataA: ataA.toBase58(), ataB: ataB.toBase58(),
    programA: TOKEN_PROGRAM_ID.toBase58(), programB: TOKEN_PROGRAM_ID.toBase58(),
    inputMint: inputMint.toBase58(), inputKind: "token", inputAccount: inputAta.toBase58(),
    inputTokenProgram: TOKEN_PROGRAM_ID.toBase58(), tickLower: -100, tickUpper: 100,
    liquidity: "10",
  } as SelectedPositionState;
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [],
  }).compileToV0Message());
  const input = { connection, transaction, wallet, state, requested: 1_000n, expectedLiquidity: 5n, sigVerify: false };
  const success = await simulateAndVerifySelectedTransaction(input);
  expect(success.spentInput).toBe("1000");
  expect(success.endingLiquidity).toBe("15");
  vi.mocked(connection.simulateTransaction).mockResolvedValueOnce({ value: { err: null, accounts: accountResults(9n), unitsConsumed: 100_000 } } as never);
  await expect(simulateAndVerifySelectedTransaction(input)).rejects.toThrow(/original pool asset/i);
});
