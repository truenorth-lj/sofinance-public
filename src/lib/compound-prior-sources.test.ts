import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, decodeCloseAccountInstruction, decodeTransferCheckedInstruction } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { CompoundAccount, CompoundPositionState } from "./compound-types";
vi.mock("server-only", () => ({}));
import { readCompoundPriorSources } from "./compound-prior-sources";
import { importCompoundReceipt, importVerifiedCompoundReceipt } from "./compound-recovery-import";

const rent = 2_039_280;
const signature = bs58.encode(new Uint8Array(64).fill(3));
const key = () => Keypair.generate().publicKey;
const data = (name: string, size: number) => {
  const value = Buffer.alloc(size);
  createHash("sha256").update(`global:${name}`).digest().copy(value, 0, 0, 8);
  if (name === "increase_liquidity_v2") value.writeBigUInt64LE(1n, 8);
  return bs58.encode(value);
};

async function fixture(amount = 1_198_201n) {
  const wallet = key(), nft = key(), nftAta = key(), position = key(), pool = key();
  const mints = [key(), key()];
  const vaults = [key(), key()];
  const old: CompoundAccount[] = [];
  const fresh: CompoundAccount[] = [];
  const infos = new Map<string, AccountInfo<Buffer>>();
  for (let index = 0; index < 2; index++) {
    const mint = mints[index]!;
    const seed = String(index + 1).repeat(32);
    const address = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID);
    const value: CompoundAccount = { seed, address: address.toBase58(), mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: rent };
    old.push(value);
    const newSeed = String(index + 3).repeat(22);
    fresh.push({ ...value, address: (await PublicKey.createWithSeed(wallet, newSeed, TOKEN_PROGRAM_ID)).toBase58(), seed: newSeed });
    const tokenData = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint, owner: wallet, amount: index === 0 ? 0n : amount,
      delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
      delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, tokenData);
    infos.set(address.toBase58(), { data: tokenData, owner: TOKEN_PROGRAM_ID, lamports: rent, executable: false, rentEpoch: 0 });
    const mintData = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: index === 0 ? 6 : 8,
      isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
    infos.set(mint.toBase58(), { data: mintData, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  }
  const harvest = Array.from({ length: 16 }, () => PublicKey.default);
  [harvest[0], harvest[1], harvest[2], harvest[3], harvest[9], harvest[10], harvest[14], harvest[15]] =
    [wallet, nftAta, position, pool, new PublicKey(old[0]!.address), new PublicKey(old[1]!.address), mints[0]!, mints[1]!];
  [harvest[5], harvest[6]] = [vaults[0]!, vaults[1]!];
  const add = Array.from({ length: 15 }, () => PublicKey.default);
  [add[0], add[1], add[2], add[4], add[7], add[8], add[13], add[14]] =
    [wallet, nftAta, pool, position, new PublicKey(old[0]!.address), new PublicKey(old[1]!.address), mints[0]!, mints[1]!];
  [add[9], add[10]] = [vaults[0]!, vaults[1]!];
  const parsed = (programId: PublicKey, type: string, info: Record<string, unknown>) => ({ programId, parsed: { type, info } });
  const transaction = { slot: 100, transaction: { signatures: [signature], message: {
    accountKeys: [wallet, nftAta, ...old.map((item) => new PublicKey(item.address))].map((pubkey, index) => ({ pubkey, signer: index === 0, writable: true })),
    instructions: [...old.flatMap((item) => [
      parsed(SystemProgram.programId, "createAccountWithSeed", { source: wallet.toBase58(), base: wallet.toBase58(), newAccount: item.address,
        seed: item.seed, owner: item.program, space: item.space, lamports: item.rentLamports }),
      parsed(TOKEN_PROGRAM_ID, "initializeAccount3", { account: item.address, mint: item.mint, owner: wallet.toBase58() }),
    ]), { programId: CLMM_PROGRAM_ID, accounts: harvest, data: data("decrease_liquidity_v2", 40) },
    { programId: CLMM_PROGRAM_ID, accounts: add, data: data("increase_liquidity_v2", 42) }],
  } }, meta: { err: null, innerInstructions: [{ index: 4, instructions: [parsed(TOKEN_PROGRAM_ID, "transferChecked", {
    source: vaults[1]!.toBase58(), destination: old[1]!.address, mint: old[1]!.mint, tokenAmount: { amount: amount.toString(), decimals: 8 } })] }],
    postTokenBalances: [{ accountIndex: 1, owner: wallet.toBase58(), mint: nft.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount: "1", decimals: 0 } }, ...old.map((item, index) => ({ accountIndex: 2 + index, owner: wallet.toBase58(), mint: item.mint,
      programId: item.program, uiTokenAmount: { amount: index === 0 ? "0" : amount.toString(), decimals: index === 0 ? 6 : 8 } }))] },
  } as unknown as ParsedTransactionWithMeta;
  const getParsedTransaction = vi.fn(async () => transaction);
  const connection = { getParsedTransaction, getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((pubkey) => infos.get(pubkey.toBase58()) ?? null)) } as unknown as Connection;
  const state = { wallet: wallet.toBase58(), positionMint: nft.toBase58(), positionAccount: position.toBase58(),
    poolId: pool.toBase58(), programId: CLMM_PROGRAM_ID.toBase58() } as CompoundPositionState;
  return { connection, getParsedTransaction, state, wallet, transaction, old, fresh: fresh as [CompoundAccount, CompoundAccount], infos, vaults };
}

describe("verified previous yield sources", () => {
  it("moves exactly the old residual into fresh accounts and closes even the empty source", async () => {
    const { connection, state, fresh, wallet, old, getParsedTransaction } = await fixture();
    const result = await readCompoundPriorSources(connection, state, fresh, [signature, signature]);
    expect(getParsedTransaction).toHaveBeenCalledOnce();
    expect(getParsedTransaction).toHaveBeenCalledWith(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    expect(result.sources).toEqual(old.map((item, index) => ({ sourceSignature: signature, address: item.address, mint: item.mint,
      program: item.program, amount: index === 0 ? "0" : "1198201", destination: fresh[index]!.address, refundLamports: rent })));
    expect(result.instructions).toHaveLength(3);
    const closed = decodeCloseAccountInstruction(result.instructions[0]!);
    expect(closed.keys.destination.pubkey.equals(wallet)).toBe(true);
    const transfer = decodeTransferCheckedInstruction(result.instructions[1]!);
    expect(transfer.data).toMatchObject({ amount: 1_198_201n, decimals: 8 });
    expect(transfer.keys.source.pubkey.toBase58()).toBe(old[1]!.address);
    expect(transfer.keys.destination.pubkey.toBase58()).toBe(fresh[1].address);
    expect(transfer.keys.owner.pubkey.equals(wallet)).toBe(true);
  });
  it("skips closed receipts, accepts remaining spent-down yield, and rejects later extra deposits", async () => {
    const { connection, state, fresh, old, infos, transaction } = await fixture();
    infos.delete(old[0]!.address);
    transaction.meta!.postTokenBalances![2]!.uiTokenAmount.amount = "1198301";
    const incoming = transaction.meta!.innerInstructions![0]!.instructions[0]!;
    if ("parsed" in incoming) incoming.parsed.info.tokenAmount.amount = "1198301";
    expect((await readCompoundPriorSources(connection, state, fresh, [signature])).sources).toHaveLength(1);
    transaction.meta!.postTokenBalances![2]!.uiTokenAmount.amount = "1198200";
    if ("parsed" in incoming) incoming.parsed.info.tokenAmount.amount = "1198200";
    await expect(readCompoundPriorSources(connection, state, fresh, [signature])).rejects.toThrow("additional deposits");
    infos.delete(old[1]!.address);
    expect(await readCompoundPriorSources(connection, state, fresh, [signature])).toEqual({ sources: [], instructions: [] });
  });
  it("rejects failed transactions, a different NFT/pool and missing balance program proof", async () => {
    const { connection, state, fresh, transaction } = await fixture();
    await expect(readCompoundPriorSources(connection, { ...state, positionMint: key().toBase58() }, fresh, [signature])).rejects.toThrow("NFT");
    await expect(readCompoundPriorSources(connection, { ...state, poolId: key().toBase58() }, fresh, [signature])).rejects.toThrow("pool");
    transaction.meta!.postTokenBalances![2]!.programId = undefined;
    await expect(readCompoundPriorSources(connection, state, fresh, [signature])).rejects.toThrow("identity");
    transaction.meta!.err = { InstructionError: [0, "InvalidArgument"] };
    await expect(readCompoundPriorSources(connection, state, fresh, [signature])).rejects.toThrow(/successful/i);
  });
  it("rejects unfinalized or missing transaction evidence and enforces the signature bound", async () => {
    const { connection, state, fresh, getParsedTransaction, transaction } = await fixture();
    await expect(readCompoundPriorSources(connection, state, fresh, Array(4).fill(signature))).rejects.toThrow(/maximum/i);
    await expect(readCompoundPriorSources(connection, state, fresh, ["bad"])).rejects.toThrow(/maximum/i);
    transaction.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(5));
    await expect(readCompoundPriorSources(connection, state, fresh, [signature])).rejects.toThrow(/confirm|completion/i);
    getParsedTransaction.mockResolvedValueOnce(null as unknown as ParsedTransactionWithMeta);
    await expect(readCompoundPriorSources(connection, state, fresh, [signature])).rejects.toThrow(/confirm|completion/i);
  });
});

describe("imported receipts prove yield rather than account ownership alone", () => {
  it("accepts a single same-pool swap with a complete harvest/swap/add transfer ledger", async () => {
    const { transaction, wallet, old, vaults } = await fixture();
    const instructions = transaction.transaction.message.instructions;
    const swap = Array.from({ length: 14 }, () => PublicKey.default);
    [swap[0], swap[2], swap[3], swap[4], swap[5], swap[6], swap[11], swap[12]] = [wallet,
      "accounts" in instructions[4]! ? instructions[4]!.accounts[3]! : PublicKey.default,
      new PublicKey(old[1]!.address), new PublicKey(old[0]!.address), vaults[1]!, vaults[0]!, new PublicKey(old[1]!.mint), new PublicKey(old[0]!.mint)];
    const bytes = Buffer.from(bs58.decode(data("swap_v2", 41)));
    bytes.writeBigUInt64LE(1_198_201n, 8); bytes.writeBigUInt64LE(10n, 16); bytes[40] = 1;
    instructions.splice(5, 0, { programId: CLMM_PROGRAM_ID, accounts: swap, data: bs58.encode(bytes) });
    const transfer = (source: string, destination: string, mint: string, amount: string, authority = wallet.toBase58()) => ({ program: "spl-token", programId: TOKEN_PROGRAM_ID,
      parsed: { type: "transferChecked", info: { source, destination, mint, authority, tokenAmount: { amount } } } });
    transaction.meta!.innerInstructions!.push({ index: 5, instructions: [transfer(old[1]!.address, vaults[1]!.toBase58(), old[1]!.mint, "1198201"),
      transfer(vaults[0]!.toBase58(), old[0]!.address, old[0]!.mint, "12")] },
    { index: 6, instructions: [transfer(old[0]!.address, vaults[0]!.toBase58(), old[0]!.mint, "12")] });
    transaction.meta!.postTokenBalances![2]!.uiTokenAmount.amount = "0";
    await expect(importCompoundReceipt(transaction, wallet.toBase58(), signature)).resolves.toMatchObject({ sourceSignature: signature });
    swap[2] = key();
    await expect(importCompoundReceipt(transaction, wallet.toBase58(), signature)).rejects.toThrow("swap");
  });
  it("rejects principal injection, unproven CPI credit and forged post balances", async () => {
    const { transaction, wallet, old } = await fixture();
    const inbound = transaction.meta!.innerInstructions![0]!.instructions[0]!;
    if (!("parsed" in inbound)) throw new Error("fixture");
    inbound.parsed.info.source = key().toBase58();
    await expect(importCompoundReceipt(transaction, wallet.toBase58(), signature)).rejects.toThrow(/existing asset/i);
    transaction.meta!.innerInstructions = [];
    transaction.transaction.message.instructions.splice(4, 0, { program: "spl-token", programId: TOKEN_PROGRAM_ID, parsed: { type: "transferChecked", info: {
      source: key().toBase58(), destination: old[1]!.address, mint: old[1]!.mint, authority: wallet.toBase58(), tokenAmount: { amount: "1198201" } } } });
    await expect(importCompoundReceipt(transaction, wallet.toBase58(), signature)).rejects.toThrow("historical source");
    transaction.transaction.message.instructions.splice(4, 1);
    await expect(importCompoundReceipt(transaction, wallet.toBase58(), signature)).rejects.toThrow("remaining amount");
  });
  it("traces a compact-seed new receipt back to its finalized original yield source", async () => {
    const { transaction: original, wallet, old, fresh, state } = await fixture();
    const newerSignature = bs58.encode(new Uint8Array(64).fill(6));
    const replace = (pubkey: PublicKey) => {
      const index = old.findIndex((account) => account.address === pubkey.toBase58());
      return index < 0 ? pubkey : new PublicKey(fresh[index]!.address);
    };
    const protocol = original.transaction.message.instructions.slice(4).map((instruction) => {
      if (!("accounts" in instruction)) throw new Error("fixture");
      return { ...instruction, accounts: instruction.accounts.map(replace) };
    });
    const setup = original.transaction.message.instructions.slice(0, 4).map((instruction, index) => {
      if (!("parsed" in instruction)) throw new Error("fixture");
      const info = { ...instruction.parsed.info };
      const account = fresh[Math.floor(index / 2)]!;
      if (index % 2 === 0) { info.newAccount = account.address; info.seed = account.seed; } else info.account = account.address;
      return { ...instruction, parsed: { ...instruction.parsed, info } };
    });
    const newer = { ...original, slot: 200, transaction: { signatures: [newerSignature], message: {
      ...original.transaction.message, accountKeys: [...original.transaction.message.accountKeys, ...fresh.map((account) => ({ pubkey: new PublicKey(account.address), signer: false, writable: true }))],
      instructions: [...setup, { programId: TOKEN_PROGRAM_ID, parsed: { type: "transferChecked", info: { source: old[1]!.address,
        destination: fresh[1].address, authority: wallet.toBase58(), mint: fresh[1].mint, tokenAmount: { amount: "1198201" } } } }, ...protocol],
    } }, meta: { ...original.meta!, innerInstructions: [], preTokenBalances: [{ ...original.meta!.postTokenBalances![2]!,
      uiTokenAmount: { ...original.meta!.postTokenBalances![2]!.uiTokenAmount } }],
      postTokenBalances: [original.meta!.postTokenBalances![0]!, ...original.meta!.postTokenBalances!.slice(1).map((balance) => ({ ...balance, accountIndex: balance.accountIndex + 2 }))] },
    } as ParsedTransactionWithMeta;
    const getSignaturesForAddress = vi.fn(async () => [{ signature, slot: 100, err: null }]);
    const connection = { getSignaturesForAddress, getParsedTransaction: vi.fn(async () => original) } as unknown as Connection;
    await expect(importCompoundReceipt(newer, wallet.toBase58(), newerSignature)).rejects.toThrow("historical source");
    await expect(importVerifiedCompoundReceipt(connection, newer, wallet.toBase58(), newerSignature)).resolves.toMatchObject({ positionMint: state.positionMint });
    expect(getSignaturesForAddress).toHaveBeenCalledWith(new PublicKey(old[1]!.address), { limit: 12 }, "finalized");
    original.meta!.postTokenBalances![2]!.uiTokenAmount.amount = "1198200";
    const inbound = original.meta!.innerInstructions![0]!.instructions[0]!;
    if ("parsed" in inbound) inbound.parsed.info.tokenAmount.amount = "1198200";
    await expect(importVerifiedCompoundReceipt(connection, newer, wallet.toBase58(), newerSignature)).rejects.toThrow(/histor.*source/i);
  });
});
