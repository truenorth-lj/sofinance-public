import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getPdaPersonalPositionAddress, PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import type { OpenPoolState } from "@sofinance/engine/open-state";
import { JUPITER_PROGRAM_ID } from "@sofinance/engine/swap/instructions";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { simulatedAccount, simulateAndVerifyOpenTransaction } from "@sofinance/engine/open-simulation";

it("treats a closed zero-lamport WSOL account returned by simulation as absent", () => {
  expect(simulatedAccount({ data: ["", "base64"], owner: SystemProgram.programId.toBase58(), lamports: 0, executable: false })).toBeNull();
  expect(simulatedAccount(null)).toBeNull();
});
it("does not silently discard malformed or funded token accounts", () => {
  expect(() => simulatedAccount({ data: ["", "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 0, executable: false })).toThrow("data missing");
  expect(() => simulatedAccount({ data: ["", "base64"], owner: SystemProgram.programId.toBase58(), lamports: 1, executable: false })).toThrow("data missing");
  const data = Buffer.alloc(165, 1);
  expect(simulatedAccount({ data: [data.toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 2039280, executable: false })?.data).toEqual(data);
});

it("verifies a native SOL open with funded Jupiter intermediate USDC and fails closed on debit or missing readback", async () => {
  const key = () => Keypair.generate().publicKey;
  const wallet = key(), nftMint = key(), mintA = key(), mintB = key(), pool = key(), program = key(), intermediate = key(), intermediateMint = key();
  const ataA = getAssociatedTokenAddressSync(mintA, wallet), ataB = getAssociatedTokenAddressSync(mintB, wallet);
  const nftAta = getAssociatedTokenAddressSync(nftMint, wallet, false, TOKEN_2022_PROGRAM_ID);
  const positionAddress = getPdaPersonalPositionAddress(program, nftMint).publicKey;
  const token = (mint: PublicKey, amount: bigint, owner = TOKEN_PROGRAM_ID) => {
    const data = Buffer.alloc(owner.equals(TOKEN_2022_PROGRAM_ID) ? 166 : 165);
    mint.toBuffer().copy(data); wallet.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1;
    if (data.length > 165) data[165] = 2;
    return { data, owner, executable: false, lamports: 2039280, rentEpoch: 0 };
  };
  const before = token(intermediateMint, 9_000_000n);
  const position = Buffer.alloc(PersonalPositionLayout.span);
  nftMint.toBuffer().copy(position, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(position, PersonalPositionLayout.offsetOf("poolId"));
  position.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  position.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  position.writeBigUInt64LE(15n, PersonalPositionLayout.offsetOf("liquidity"));
  const after = new Map([
    [positionAddress.toBase58(), { ...before, owner: program, data: position }],
    [nftAta.toBase58(), token(nftMint, 1n, TOKEN_2022_PROGRAM_ID)],
    [ataA.toBase58(), token(mintA, 10n)], [ataB.toBase58(), token(mintB, 20n)],
    [intermediate.toBase58(), before],
    [wallet.toBase58(), { ...before, owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 98_000_000 }],
  ]);
  const connection = {
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(() => null)),
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 123 }, value: keys.map(k => k.equals(intermediate) ? before : null) })),
    getBalance: vi.fn(async () => 100_000_000),
    simulateTransaction: vi.fn(async (_tx, config: { accounts: { addresses: string[] } }) => ({ value: { err: null, accounts: config.accounts.addresses.map(address => {
      const info = after.get(address); return info ? { ...info, owner: info.owner.toBase58(), data: [info.data.toString("base64"), "base64"] } : null;
    }) } })),
  } as unknown as Connection;
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: key().toBase58(), instructions: [new TransactionInstruction({ programId: JUPITER_PROGRAM_ID, keys: [{ pubkey: intermediate, isSigner: false, isWritable: true }] })] }).compileToV0Message());
  const state = { programId: program.toBase58(), poolId: pool.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58(), ataA: ataA.toBase58(), ataB: ataB.toBase58(), programA: TOKEN_PROGRAM_ID.toBase58(), programB: TOKEN_PROGRAM_ID.toBase58(), inputKind: "native", inputMint: NATIVE_SOL_MINT } as OpenPoolState;
  const input = { connection, transaction, wallet, state, nftMint, tickLower: -100, tickUpper: 100, requested: 1_000_000n, expectedLiquidity: 15n, maxSolDebitLamports: 3_000_000n, sigVerify: false };
  await expect(simulateAndVerifyOpenTransaction(input)).resolves.toMatchObject({ endingLiquidity: "15" });
  expect(connection.simulateTransaction).toHaveBeenCalledWith(transaction, expect.objectContaining({ minContextSlot: 123, accounts: { encoding: "base64", addresses: expect.arrayContaining([intermediate.toBase58()]) } }));
  after.set(intermediate.toBase58(), token(intermediateMint, 8_999_999n));
  await expect(simulateAndVerifyOpenTransaction(input)).rejects.toThrow(intermediate.toBase58());
  after.delete(intermediate.toBase58());
  await expect(simulateAndVerifyOpenTransaction(input)).rejects.toThrow(intermediate.toBase58());
});
