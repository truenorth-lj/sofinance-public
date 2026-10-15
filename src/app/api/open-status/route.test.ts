import { createHash } from "node:crypto";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcConnection } from "@sofinance/engine/rpc";
import { testKeypair, BLOCKHASH } from "@/lib/test-support/send-fixtures";
import type { OpenAttempt } from "@/lib/open-attempt";
import { POST } from "./route";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
const wallet = testKeypair(1).publicKey;
const nft = testKeypair(2).publicKey;
const pool = testKeypair(3).publicKey;
const positionAccount = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
const attempt: OpenAttempt = { version: 1, wallet: wallet.toBase58(), signature: bs58.encode(new Uint8Array(64).fill(1)),
  nftMint: nft.toBase58(), positionAccount: positionAccount.toBase58(), poolId: pool.toBase58(),
  tickLower: -60, tickUpper: 60, liquidity: "100", blockhash: BLOCKHASH, lastValidBlockHeight: 150, createdAt: 1000 };
const connection = { getSignatureStatuses: vi.fn(), getBlockHeight: vi.fn(), getParsedTransaction: vi.fn(), getAccountInfo: vi.fn() };
function parsed(name = "open_position_with_token22_nft") {
  const accountKeys = [{ pubkey: wallet, signer: true }, { pubkey: nft, signer: true }, { pubkey: positionAccount, signer: false }];
  const accounts = Array.from({ length: 10 }, () => wallet);
  accounts[2] = nft; accounts[name === "open_position_v2" ? 5 : 4] = pool;
  accounts[name === "open_position_v2" ? 9 : 8] = positionAccount;
  return { meta: { err: null }, transaction: { message: { recentBlockhash: BLOCKHASH, accountKeys,
    instructions: [{ programId: CLMM_PROGRAM_ID, accounts,
      data: bs58.encode(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)) }] } } };
}
const decoded = () => ({ nftMint: nft, poolId: pool, tickLower: -60, tickUpper: 60, liquidity: { toString: () => "100" } });
async function call(overrides: Record<string, unknown> = {}) {
  return POST(new Request("http://localhost/api/open-status", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: wallet.toBase58(), attempt, ...overrides }) }));
}
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null, slot: 42 }] });
  connection.getBlockHeight.mockResolvedValue(100);
  connection.getParsedTransaction.mockResolvedValue(parsed());
  connection.getAccountInfo.mockResolvedValue({ owner: CLMM_PROGRAM_ID,
    data: createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8) });
  vi.spyOn(PersonalPositionLayout, "decode").mockReturnValue(decoded() as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
describe("open-position confirmation", () => {
  it.each(["open_position_v2", "open_position_with_token22_nft"])("confirms finalized %s and exact account facts", async name => {
    connection.getParsedTransaction.mockResolvedValue(parsed(name));
    const response = await call();
    expect(await response.json()).toEqual({ signature: attempt.signature, status: "confirmed" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(connection.getAccountInfo).toHaveBeenCalledWith(positionAccount, { commitment: "finalized", minContextSlot: 42 });
  });
  it.each(["processed", "confirmed"])("keeps %s pending even beyond blockhash expiry", async confirmationStatus => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus, err: null }] });
    connection.getBlockHeight.mockResolvedValue(999);
    expect((await (await call()).json()).status).toBe("pending");
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });
  it("retries unavailable transaction history without claiming success", async () => {
    connection.getParsedTransaction.mockResolvedValue(null);
    expect((await (await call()).json()).status).toBe("pending");
  });
  it("expires only an absent signature after the finalized height passes", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    expect((await (await call()).json()).status).toBe("pending");
    connection.getBlockHeight.mockResolvedValue(151);
    connection.getAccountInfo.mockResolvedValue(null);
    expect((await (await call()).json()).status).toBe("expired");
    expect(connection.getBlockHeight).toHaveBeenCalledWith("finalized");
  });
  it("does not expire a missing signature when its position account still exists", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    connection.getBlockHeight.mockResolvedValue(151);
    expect((await (await call()).json()).status).toBe("manual-review");
  });
  it("reports finalized execution failure without displaying an opened position", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, 1] } }] });
    expect((await (await call()).json()).status).toBe("failed");
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });
  it.each([{ tickLower: 0 }, { nftMint: pool }, { poolId: nft }, { liquidity: { toString: () => "99" } }])("requires manual review for incompatible account facts %#", async override => {
    vi.mocked(PersonalPositionLayout.decode).mockReturnValue({ ...decoded(), ...override } as never);
    expect((await (await call()).json()).status).toBe("manual-review");
  });
  it("requires the original open instruction, blockhash, wallet and NFT signer", async () => {
    const tx = parsed(); tx.transaction.message.instructions = [];
    connection.getParsedTransaction.mockResolvedValue(tx);
    expect((await (await call()).json()).status).toBe("manual-review");
    const foreign = parsed(); foreign.transaction.message.accountKeys[0]!.pubkey = pool;
    connection.getParsedTransaction.mockResolvedValue(foreign);
    expect((await (await call()).json()).status).toBe("manual-review");
    const changed = parsed(); changed.transaction.message.recentBlockhash = pool.toBase58();
    connection.getParsedTransaction.mockResolvedValue(changed);
    expect((await (await call()).json()).status).toBe("manual-review");
  });
  it("rejects malformed or mismatched PDA records before RPC", async () => {
    expect((await call({ attempt: { ...attempt, positionAccount: pool.toBase58() } })).status).toBe(400);
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });
  it("returns an error for RPC outage so the client keeps the original attempt", async () => {
    connection.getSignatureStatuses.mockRejectedValue(new Error("network unavailable"));
    expect((await call()).status).toBe(400);
  });
});
