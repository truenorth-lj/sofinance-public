import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NATIVE_SOL_MINT } from "./ids";
import { swapFeeRecipientAta } from "./swap/fee";
import { readSolSwapDelivery } from "./sol-swap-step";

const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey.toBase58();
const feeWallet = Keypair.generate().publicKey;
const feeAta = swapFeeRecipientAta(feeWallet, new PublicKey(NATIVE_SOL_MINT), TOKEN_PROGRAM_ID);
const balance = (owner: PublicKey, amount: string, tokenMint = mint) => ({ accountIndex: 1, mint: tokenMint, owner: owner.toBase58(), uiTokenAmount: { amount, decimals: 9, uiAmount: null, uiAmountString: "" } });

function connection(opts: { status?: unknown; keys?: PublicKey[]; pre?: unknown[]; post?: unknown[]; err?: unknown; height?: number } = {}) {
  const keys = opts.keys ?? [wallet, feeAta];
  return {
    getSignatureStatuses: vi.fn(async () => ({ value: ["status" in opts ? opts.status : { err: null, confirmationStatus: "confirmed" }] })),
    getBlockHeight: vi.fn(async () => opts.height ?? 0),
    getTransaction: vi.fn(async () => ({
      blockTime: 1_700_000_000,
      meta: { err: opts.err ?? null, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: opts.pre ?? [balance(wallet, "100")], postTokenBalances: opts.post ?? [balance(wallet, "24650100"), balance(other, "5")] },
      transaction: { message: { getAccountKeys: () => ({ length: keys.length, get: (i: number) => keys[i] }) } },
    })),
  } as unknown as Connection;
}
const read = (conn: Connection, extra: Record<string, unknown> = {}) => readSolSwapDelivery({ signature: "sig", wallet: wallet.toBase58(), outputMint: mint, connection: conn, ...extra });

beforeEach(() => { vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10"); });
afterEach(() => vi.unstubAllEnvs());

describe("readSolSwapDelivery", () => {
  it("measures what the swap actually delivered to the wallet (post minus pre)", async () => {
    expect(await read(connection())).toEqual({ status: "confirmed", delivered: "24650000", decimals: 9, blockTime: 1_700_000_000, feeAccountPaid: true });
  });
  it("reports whether the protocol fee account was in the transaction", async () => {
    expect(await read(connection({ keys: [wallet, other] }))).toMatchObject({ status: "confirmed", feeAccountPaid: false });
  });
  it("reports pending, expired and failed without guessing an amount", async () => {
    expect(await read(connection({ status: null }))).toEqual({ status: "pending" });
    expect(await read(connection({ status: null, height: 200 }), { lastValidBlockHeight: 100 })).toEqual({ status: "expired" });
    expect(await read(connection({ status: { err: { x: 1 }, confirmationStatus: "confirmed" } }))).toEqual({ status: "failed" });
    expect(await read(connection({ status: { err: null, confirmationStatus: "processed" } }))).toEqual({ status: "pending" });
    expect(await read(connection({ err: { x: 1 } }))).toEqual({ status: "failed" });
  });
  it("rejects a transaction from another fee payer or one that delivered nothing", async () => {
    await expect(read(connection({ keys: [other, feeAta] }))).rejects.toThrow("not paid by this wallet");
    await expect(read(connection({ post: [balance(wallet, "100")] }))).rejects.toThrow("did not deliver");
    await expect(read(connection({ post: [balance(wallet, "999", Keypair.generate().publicKey.toBase58())] }))).rejects.toThrow("did not deliver");
  });
});
