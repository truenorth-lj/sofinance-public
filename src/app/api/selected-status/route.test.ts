// Characterization tests: pin the CURRENT behaviour of POST /api/selected-status, the route that
// decides whether a broadcast add-liquidity attempt is pending / expired / failed / success /
// manual-review. Real: input validation, discriminator + liquidity parsing, confirmedAtomicSuccess.
// Mocked: RPC connection and the on-chain state reader.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/position-history-cache", () => ({ invalidatePositionHistoryCache: vi.fn() }));
import { invalidatePositionHistoryCache } from "@/lib/position-history-cache";
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: vi.fn() }));

import { rpcConnection } from "@sofinance/engine/rpc";
import { readSelectedPositionState } from "@sofinance/engine/selected-state";
import { fakeConnection, type FakeConnection, jsonRequest, testKeypair } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const positionMint = testKeypair(2).publicKey.toBase58();
const poolId = testKeypair(3).publicKey.toBase58();
const positionAccount = testKeypair(4).publicKey.toBase58();
const programId = testKeypair(5).publicKey.toBase58();
const inputMint = "So11111111111111111111111111111111111111112";
const signature = bs58.encode(new Uint8Array(64).fill(3));
const startingBalances = { input: "5000", a: "10", b: "20" };
const selection = { positionMint, inputMint, inputKind: "native" as const };

const baseBody = {
  wallet, selection, poolId, positionAccount, signature, startingLiquidity: "1000", expectedLiquidity: "500",
  startingBalances, lastValidBlockHeight: 150,
};

function chainState(overrides: Record<string, unknown> = {}) {
  return {
    ownsNft: true, liquidity: "1000", balances: { ...startingBalances }, poolId, positionAccount, programId, ...overrides,
  };
}

const discriminator = createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8);
function increaseData(liquidity: bigint, disc: Uint8Array = discriminator) {
  const data = Buffer.alloc(8 + 16 + 16);
  Buffer.from(disc).copy(data, 0);
  data.writeBigUInt64LE(liquidity & 0xffffffffffffffffn, 8);
  data.writeBigUInt64LE(liquidity >> 64n, 16);
  return bs58.encode(data);
}
const pk = (value: string) => new PublicKey(value);

function parsedTx(overrides: { signer?: boolean; liquidity?: bigint; accounts?: string[]; disc?: Uint8Array; program?: string; err?: unknown; noIx?: boolean } = {}) {
  const accounts = overrides.accounts ?? [wallet, testKeypair(9).publicKey.toBase58(), poolId, testKeypair(10).publicKey.toBase58(), positionAccount];
  return {
    meta: { err: overrides.err ?? null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: pk(wallet), signer: overrides.signer ?? true }],
        instructions: overrides.noIx ? [] : [{
          programId: pk(overrides.program ?? programId), accounts: accounts.map(pk),
          data: increaseData(overrides.liquidity ?? 500n, overrides.disc),
        }],
      },
    },
  };
}

async function call(body: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/selected-status", body));
  return { response, json: await response.json() as Record<string, unknown> };
}

let connection: FakeConnection;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection({
    getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
    getParsedTransaction: vi.fn(async () => parsedTx()),
  });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ liquidity: "1500" }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/selected-status: input validation", () => {
  const invalid = "Invalid transaction verification input";
  it.each<[string, Record<string, unknown>]>([
    ["unknown inputKind", { selection: { ...selection, inputKind: "nft" } }],
    ["missing poolId", { poolId: undefined }],
    ["signature wrong length", { signature: bs58.encode(new Uint8Array(32)) }],
    ["startingLiquidity not numeric", { startingLiquidity: "1.5" }],
    ["expectedLiquidity negative", { expectedLiquidity: "-1" }],
    ["startingBalances.b not numeric", { startingBalances: { ...startingBalances, b: "x" } }],
    ["lastValidBlockHeight zero", { lastValidBlockHeight: 0 }],
    ["lastValidBlockHeight fractional", { lastValidBlockHeight: 1.5 }],
  ])("rejects %s", async (_name, override) => {
    const { response, json } = await call({ ...baseBody, ...override });
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: invalid });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("QUIRK: a malformed pubkey / base58 string surfaces the raw library message instead of the route's own sentence", async () => {
    const pool = await call({ ...baseBody, poolId: "abc" });
    expect(pool.response.status).toBe(400);
    expect(pool.json).toEqual({ error: "Invalid public key input" });
    const sig = await call({ ...baseBody, signature: "0OIl" });
    expect(sig.response.status).toBe(400);
    expect(sig.json).toEqual({ error: "Non-base58 character" });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects an invalid wallet", async () => {
    const { response, json } = await call({ ...baseBody, wallet: "nope" });
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid wallet address" });
  });

  it("accepts an exhausted-balance style request: balances may be '0' and requested amount fields are not required", async () => {
    const { response } = await call({ ...baseBody, startingBalances: { input: "0", a: "0", b: "0" } });
    expect(response.status).toBe(200);
  });
});

describe("POST /api/selected-status: signature not found on-chain", () => {
  beforeEach(() => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState() as never);
  });

  it("is pending while the chain is at or before lastValidBlockHeight", async () => {
    connection.getBlockHeight.mockResolvedValue(150);
    const { response, json } = await call(baseBody);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toMatchObject({ status: "pending", signature });
    expect(json.state).toMatchObject({ liquidity: "1000" });
  });

  it("is expired once the blockhash lapsed AND position/balances are unchanged", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    const { json } = await call(baseBody);
    expect(json).toMatchObject({ status: "expired" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["liquidity moved", { liquidity: "1001" }],
    ["input balance moved", { balances: { ...startingBalances, input: "4000" } }],
    ["token A balance moved", { balances: { ...startingBalances, a: "11" } }],
    ["token B balance moved", { balances: { ...startingBalances, b: "19" } }],
    ["wallet no longer owns the NFT", { ownsNft: false }],
  ])("is manual-review once lapsed when %s", async (_name, stateOverride) => {
    connection.getBlockHeight.mockResolvedValue(151);
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState(stateOverride) as never);
    const { json } = await call(baseBody);
    expect(json).toMatchObject({ status: "manual-review" });
  });

  it("looks the signature up with full history search and reads state with allowEmptyInput=true", async () => {
    connection.getBlockHeight.mockResolvedValue(100);
    await call(baseBody);
    expect(connection.getSignatureStatuses).toHaveBeenCalledWith([signature], { searchTransactionHistory: true });
    expect(readSelectedPositionState).toHaveBeenCalledWith(wallet, selection, connection, true);
  });
});

describe("POST /api/selected-status: state read edge cases", () => {
  it("returns manual-review with state:null when the wallet no longer holds the NFT (string-matched error)", async () => {
    vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Wallet does not currently hold this Raydium CLMM position NFT"));
    const { response, json } = await call(baseBody);
    expect(response.status).toBe(200);
    expect(json).toEqual({ state: null, signature, status: "manual-review" });
  });

  it("QUIRK: the NFT-gone branch is a message string comparison; any wording change turns it into a 400", async () => {
    vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Wallet does not currently hold this Raydium CLMM position NFT."));
    const { response } = await call(baseBody);
    expect(response.status).toBe(400);
  });

  it("surfaces other state-read failures as 400", async () => {
    vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Pool or position account has changed"));
    const { response, json } = await call(baseBody);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Pool or position account has changed" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["pool id differs", { poolId: testKeypair(70).publicKey.toBase58() }],
    ["position account differs", { positionAccount: testKeypair(71).publicKey.toBase58() }],
  ])("rejects when %s from the record", async (_name, stateOverride) => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState(stateOverride) as never);
    const { response, json } = await call(baseBody);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Position to be verified has changed" });
  });
});

describe("POST /api/selected-status: signature observed", () => {
  it("reports failed with the on-chain error when the status carries err", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: { InstructionError: [3, { Custom: 6017 }] } }] });
    const { response, json } = await call(baseBody);
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ status: "failed", transactionError: { InstructionError: [3, { Custom: 6017 }] } });
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it("QUIRK: a processed (not yet confirmed) status is pending but a failed err on a processed status is already reported failed", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "processed", err: { X: 1 } }] });
    expect((await call(baseBody)).json).toMatchObject({ status: "failed" });
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "processed", err: null }] });
    expect((await call(baseBody)).json).toMatchObject({ status: "pending" });
    expect(invalidatePositionHistoryCache).not.toHaveBeenCalled();
  });

  it("is pending when the parsed transaction is not available yet", async () => {
    connection.getParsedTransaction.mockResolvedValue(null);
    expect((await call(baseBody)).json).toMatchObject({ status: "pending" });
    expect(invalidatePositionHistoryCache).not.toHaveBeenCalled();
  });

  it("reports failed when the parsed transaction meta carries err", async () => {
    connection.getParsedTransaction.mockResolvedValue(parsedTx({ err: { Custom: 1 } }));
    expect((await call(baseBody)).json).toMatchObject({ status: "failed", transactionError: { Custom: 1 } });
  });

  it("QUIRK: 'confirmed' commitment is enough for success here (compound-confirm waits for 'finalized')", async () => {
    const { json } = await call(baseBody);
    expect(json).toMatchObject({ status: "success", signedByWallet: true, addedToExactPosition: true });
    expect(invalidatePositionHistoryCache).toHaveBeenCalledWith(positionMint);
    expect(connection.getParsedTransaction).toHaveBeenCalledWith(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  });

  it("is success when current liquidity is >= starting + expected (exactly equal is enough)", async () => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ liquidity: "1500" }) as never);
    expect((await call(baseBody)).json).toMatchObject({ status: "success" });
  });

  it("is manual-review when current liquidity is one unit short", async () => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ liquidity: "1499" }) as never);
    expect((await call(baseBody)).json).toMatchObject({ status: "manual-review", signedByWallet: true, addedToExactPosition: true });
  });

  it.each<[string, ReturnType<typeof parsedTx>, Record<string, unknown>]>([
    ["wallet is not a signer", parsedTx({ signer: false }), { signedByWallet: false, addedToExactPosition: true }],
    ["instruction liquidity differs from the expected liquidity", parsedTx({ liquidity: 499n }), { signedByWallet: true, addedToExactPosition: true }],
    ["there is no increase_liquidity_v2 instruction", parsedTx({ noIx: true }), { signedByWallet: true, addedToExactPosition: false }],
    ["discriminator is a different instruction", parsedTx({ disc: createHash("sha256").update("global:decrease_liquidity_v2").digest().subarray(0, 8) }), { signedByWallet: true, addedToExactPosition: false }],
    ["instruction targets another pool", parsedTx({ accounts: [wallet, testKeypair(9).publicKey.toBase58(), testKeypair(80).publicKey.toBase58(), testKeypair(10).publicKey.toBase58(), positionAccount] }), { addedToExactPosition: false }],
    ["instruction targets another position", parsedTx({ accounts: [wallet, testKeypair(9).publicKey.toBase58(), poolId, testKeypair(10).publicKey.toBase58(), testKeypair(81).publicKey.toBase58()] }), { addedToExactPosition: false }],
    ["instruction is for another program", parsedTx({ program: testKeypair(82).publicKey.toBase58() }), { addedToExactPosition: false }],
  ])("is manual-review when %s", async (_name, tx, extra) => {
    connection.getParsedTransaction.mockResolvedValue(tx);
    const { response, json } = await call(baseBody);
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ status: "manual-review", ...extra });
  });

  it("is manual-review when the wallet no longer owns the NFT even if the instruction matches", async () => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ ownsNft: false, liquidity: "1500" }) as never);
    expect((await call(baseBody)).json).toMatchObject({ status: "manual-review" });
  });

  it("QUIRK: the response always echoes the full on-chain state object to the client", async () => {
    const { json } = await call(baseBody);
    expect(json.state).toMatchObject({ programId, ownsNft: true });
  });
});

describe("POST /api/selected-status: terminal resolution so the unconfirmed warning cannot stick", () => {
  const gone = () => vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Wallet does not currently hold this Raydium CLMM position NFT"));
  it("is expired well past the blockhash even when the wallet changed since", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    connection.getBlockHeight.mockResolvedValue(150 + 151);
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ liquidity: "1" }) as never);
    expect((await call(baseBody)).json).toMatchObject({ status: "expired" });
  });
  it("is expired when the NFT is gone and the signature never landed", async () => {
    gone(); connection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    connection.getBlockHeight.mockResolvedValue(150 + 151);
    expect((await call(baseBody)).json).toMatchObject({ status: "expired", state: null });
  });
  it("is failed when the NFT is gone and the signature failed", async () => {
    gone(); connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: { Custom: 1 } }] });
    expect((await call(baseBody)).json).toMatchObject({ status: "failed" });
  });
  it("is success when the NFT is gone but the finalized transaction added the expected amount", async () => {
    gone(); connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null }] });
    connection.getParsedTransaction.mockResolvedValue({ ...parsedTx({ program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" }) } as never);
    expect((await call(baseBody)).json).toMatchObject({ status: "success" });
  });
  it("is success for a finalized add even after a later withdrawal reduced the position", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null }] });
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ liquidity: "10" }) as never);
    expect((await call(baseBody)).json).toMatchObject({ status: "success" });
  });
});
