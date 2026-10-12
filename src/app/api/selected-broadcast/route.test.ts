// Characterization tests: pin the CURRENT behaviour of POST /api/selected-broadcast
// (the route that broadcasts a user-signed add-liquidity transaction), quirks included.
// Real: tx parsing, HMAC permit, public-error sanitising. Mocked: RPC, state read,
// simulation, Beam lookup. If one of these tests fails after a refactor, the wire
// behaviour of a money-moving endpoint changed; decide deliberately, don't just update.
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@/lib/selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("@/lib/selected-simulation", () => ({ simulateAndVerifySelectedTransaction: vi.fn() }));
vi.mock("@/lib/solami-beam", () => ({ lookupBeamAfterSend: vi.fn(), beamLandingUrl: (signature: string) => `https://api.solami.dev/swqos/tx/${signature}` }));

import { rpcConnection } from "@/lib/rpc";
import { readSelectedPositionState } from "@/lib/selected-state";
import { simulateAndVerifySelectedTransaction } from "@/lib/selected-simulation";
import { lookupBeamAfterSend } from "@/lib/solami-beam";
import { issueSelectedPermit, type SelectedPermitInput } from "@/lib/selected-permit";
import {
  BEAM_RESULT, SIGNING_SECRET, buildTransaction, fakeConnection, type FakeConnection, jsonRequest, messageBase64, oversizedSignedBase64, signatureOf,
  testKeypair, toBase64,
} from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const walletKey = testKeypair(1);
const wallet = walletKey.publicKey.toBase58();
const positionMint = testKeypair(2).publicKey.toBase58();
const inputMint = "So11111111111111111111111111111111111111112";
const selection = { positionMint, inputMint, inputKind: "native" as const };
const startingBalances = { input: "5000000000", a: "10", b: "20" };

function chainState(overrides: Record<string, unknown> = {}) {
  return {
    ownsNft: true, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true, wsolBalance: "0",
    positionMint, inputMint, inputKind: "native", liquidity: "1000", rangeSide: "inside",
    balances: { ...startingBalances }, poolId: "pool", positionAccount: "position", programId: "program", ...overrides,
  };
}

type Overrides = Partial<SelectedPermitInput> & { signedTransaction?: unknown; permit?: unknown; wallet?: unknown };

function validBody(transaction = buildTransaction({ payer: walletKey }), overrides: Overrides = {}) {
  const base: SelectedPermitInput = {
    message: messageBase64(transaction), wallet, selection, requested: "1000000", floorBps: 9900,
    expiresAt: Date.now() + 60_000, lastValidBlockHeight: 150, startingLiquidity: "1000", expectedLiquidity: "500",
    rangeSide: "inside", startingBalances,
  };
  const { signedTransaction, permit, wallet: walletOverride, ...fields } = overrides;
  const permitInput = { ...base, ...fields } as SelectedPermitInput;
  const { message: _message, ...rest } = permitInput;
  void _message;
  return {
    ...rest, wallet: walletOverride ?? wallet, signedTransaction: signedTransaction ?? toBase64(transaction),
    permit: permit ?? issueSelectedPermit(SIGNING_SECRET, permitInput),
  };
}

async function call(body: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/selected-broadcast", body));
  return { response, json: await response.json() as Record<string, unknown> };
}

let connection: FakeConnection;
const transaction = buildTransaction({ payer: walletKey });

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readSelectedPositionState).mockResolvedValue(chainState() as never);
  vi.mocked(simulateAndVerifySelectedTransaction).mockResolvedValue(undefined as never);
  vi.mocked(lookupBeamAfterSend).mockResolvedValue(BEAM_RESULT as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/selected-broadcast: happy path", () => {
  it("verifies the prepared message and fresh state, uses RPC preflight, and returns before Beam", async () => {
    vi.mocked(lookupBeamAfterSend).mockImplementation(() => new Promise(() => {}));
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({ signature: signatureOf(transaction), beam: null, beamLabel: null,
      beamLandingUrl: `https://api.solami.dev/swqos/tx/${signatureOf(transaction)}` });
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    expect(readSelectedPositionState).toHaveBeenCalledWith(wallet, selection, connection, false, { displayPrices: false });
    expect(simulateAndVerifySelectedTransaction).toHaveBeenCalledOnce();
    expect(simulateAndVerifySelectedTransaction).toHaveBeenCalledWith(expect.objectContaining({
      sigVerify: true, useStateSnapshot: true, requested: 1_000_000n, expectedLiquidity: 500n,
    }));
    expect(lookupBeamAfterSend).not.toHaveBeenCalled();
  });

  it("does not require any fee-related or extra fields: a resale floor of exactly 9500 and 10000 are accepted", async () => {
    for (const floorBps of [9500, 10_000]) {
      const { response } = await call(validBody(transaction, { floorBps }));
      expect(response.status).toBe(200);
    }
  });
});

describe("POST /api/selected-broadcast: input validation (400 + sanitized message)", () => {
  const invalid = "Invalid or expired signed transaction input";
  it.each<[string, Overrides]>([
    ["floorBps below 9500", { floorBps: 9400 }],
    ["floorBps above 10000", { floorBps: 10_010 }],
    ["floorBps not a multiple of 10", { floorBps: 9905 }],
    ["floorBps not an integer", { floorBps: 9900.5 }],
    ["requested is zero", { requested: "0" }],
    ["requested is not a raw integer", { requested: "1.5" }],
    ["expectedLiquidity is zero", { expectedLiquidity: "0" }],
    ["startingLiquidity is not numeric", { startingLiquidity: "abc" }],
    ["expiresAt already passed", { expiresAt: Date.now() - 1 }],
    ["lastValidBlockHeight is zero", { lastValidBlockHeight: 0 }],
    ["rangeSide unknown", { rangeSide: "sideways" }],
    ["startingBalances.a not numeric", { startingBalances: { ...startingBalances, a: "-1" } }],
    ["selection.inputKind unknown", { selection: { ...selection, inputKind: "nft" as never } }],
    ["signedTransaction longer than 2,500 chars", { signedTransaction: "A".repeat(2_501) }],
    ["permit is not a string", { permit: 123 }],
  ])("rejects %s", async (_name, overrides) => {
    const { response, json } = await call(validBody(transaction, overrides));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: invalid });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects an invalid wallet before anything else", async () => {
    const { response, json } = await call(validBody(transaction, { wallet: "not-a-wallet" }));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid wallet address" });
  });

  it("rejects an off-curve wallet address", async () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("seed")], testKeypair(60).publicKey);
    const { response, json } = await call(validBody(transaction, { wallet: pda.toBase58() }));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid wallet address" });
  });

  it("QUIRK: a missing selection / null JSON body leaks a raw JS TypeError message in the 400 body", async () => {
    const { response, json } = await call("null");
    expect(response.status).toBe(400);
    expect(String(json.error)).toMatch(/Cannot read properties of null/);
  });

  it("QUIRK: malformed JSON leaks the JSON.parse message", async () => {
    const { response, json } = await call("{not json");
    expect(response.status).toBe(400);
    expect(String(json.error)).toMatch(/JSON/i);
  });

  it("QUIRK: a non-base64/garbage signedTransaction surfaces the raw web3.js deserialize error", async () => {
    const { response, json } = await call(validBody(transaction, { signedTransaction: "AAAA" }));
    expect(response.status).toBe(400);
    expect(typeof json.error).toBe("string");
    expect(json.error).not.toBe(invalid);
  });
});

describe("POST /api/selected-broadcast: structural transaction checks", () => {
  const structural = "Payer, signature count, or transaction size mismatch";
  it("rejects a transaction whose fee payer is not the wallet", async () => {
    const other = buildTransaction({ payer: testKeypair(3) });
    const { response, json } = await call(validBody(other));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: structural });
  });

  it("rejects an unsigned (all-zero signature) transaction", async () => {
    const unsigned = buildTransaction({ payer: walletKey, signWith: [] });
    const { json } = await call(validBody(unsigned));
    expect(json).toEqual({ error: structural });
  });

  it("rejects a transaction needing two signatures", async () => {
    const two = buildTransaction({ payer: walletKey, extraSigners: [testKeypair(4)] });
    const { json } = await call(validBody(two));
    expect(json).toEqual({ error: structural });
  });

  it("QUIRK: a header/signature-array mismatch is rejected by web3.js itself (the explicit signatures.length check in the route is redundant)", async () => {
    const extra = buildTransaction({ payer: walletKey });
    extra.signatures.push(new Uint8Array(64).fill(1));
    const { json } = await call(validBody(extra));
    expect(json).toEqual({ error: "Expected signatures length to be equal to the number of required signatures" });
  });

  it("QUIRK: an oversized (>1,232 byte) signed tx is not rejected by the size check: web3.js throws RangeError on re-serialize first", async () => {
    const { response, json } = await call(validBody(transaction, { signedTransaction: oversizedSignedBase64(walletKey) }));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "encoding overruns Uint8Array" });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("checks structure BEFORE the permit (a bad-structure tx with a bad permit reports the structural error)", async () => {
    const other = buildTransaction({ payer: testKeypair(3) });
    const { json } = await call(validBody(other, { permit: "0".repeat(64) }));
    expect(json).toEqual({ error: structural });
  });
});

describe("POST /api/selected-broadcast: permit", () => {
  const mismatch = "Transaction content does not match server's complete simulation version";
  it.each<[string, Overrides]>([
    ["a permit that is not 64 hex chars", { permit: "xyz" }],
    ["a permit signed with another secret", { permit: "0".repeat(64) }],
  ])("rejects %s", async (_name, overrides) => {
    const { response, json } = await call(validBody(transaction, overrides));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: mismatch });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects when any permit-bound field is changed after issuing (requested)", async () => {
    const body = validBody(transaction);
    const { json } = await call({ ...body, requested: "1000001" });
    expect(json).toEqual({ error: mismatch });
  });

  it("rejects a permit issued for a different transaction message", async () => {
    const otherTx = buildTransaction({ payer: walletKey, paddingBytes: 10 });
    const body = validBody(otherTx);
    const { json } = await call({ ...body, signedTransaction: toBase64(transaction) });
    expect(json).toEqual({ error: mismatch });
  });

  it("QUIRK: with no JUPITER_API_KEY the permit helper throws and the client sees 'Missing server signing key'", async () => {
    vi.stubEnv("JUPITER_API_KEY", undefined);
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Missing server signing key" });
  });

  it("QUIRK: the permit is keyed by JUPITER_API_KEY, so rotating that key invalidates an issued permit", async () => {
    const body = validBody(transaction);
    vi.stubEnv("JUPITER_API_KEY", "a-rotated-key");
    const { json } = await call(body);
    expect(json).toEqual({ error: mismatch });
  });
});

describe("POST /api/selected-broadcast: re-verification against chain state", () => {
  it("rejects when the blockhash height is already past lastValidBlockHeight", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400);
    // QUIRK: sanitizePublicError rewrites "blockhash expired" into its own wording (trailing period).
    expect(json).toEqual({ error: "Transaction blockhash expired." });
    expect(simulateAndVerifySelectedTransaction).not.toHaveBeenCalled();
  });

  it("accepts height === lastValidBlockHeight (only a strictly greater height is expired)", async () => {
    connection.getBlockHeight.mockResolvedValue(150);
    const { response } = await call(validBody(transaction));
    expect(response.status).toBe(200);
  });

  const changed = "Selected NFT, range, liquidity, or wallet balance has changed";
  it.each<[string, Record<string, unknown>]>([
    ["wallet no longer owns the NFT", { ownsNft: false }],
    ["pool is paused", { paused: true }],
    ["token is frozen", { frozen: true }],
    ["transfer fee present", { transferFee: true }],
    ["unsupported mint extensions", { unsupportedExtensions: ["TransferHook"] }],
    ["insufficient SOL", { sufficientSol: false }],
    ["position mint differs", { positionMint: testKeypair(50).publicKey.toBase58() }],
    ["input mint differs", { inputMint: testKeypair(51).publicKey.toBase58() }],
    ["input kind differs", { inputKind: "token" }],
    ["liquidity changed", { liquidity: "1001" }],
    ["range side changed", { rangeSide: "above" }],
    ["input balance changed", { balances: { ...startingBalances, input: "1" } }],
    ["token A balance changed", { balances: { ...startingBalances, a: "11" } }],
    ["token B balance changed", { balances: { ...startingBalances, b: "21" } }],
  ])("rejects when %s", async (_name, stateOverride) => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState(stateOverride) as never);
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: changed });
    expect(simulateAndVerifySelectedTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a signed simulation that no longer preserves the SOL reserve", async () => {
    vi.mocked(simulateAndVerifySelectedTransaction).mockRejectedValue(new Error("Simulated SOL expenditure or remaining balance exceeds limit"));
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400); expect(String(json.error)).toContain("SOL expenditure");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects native input when WSOL appeared after prepare, even outside the pool pair", async () => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(chainState({ wsolBalance: "1" }) as never);
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("WSOL ATA balance");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a nonzero but invalid wallet signature before reading or sending", async () => {
    const corrupted = buildTransaction({ payer: walletKey });
    corrupted.signatures[0]![0] = corrupted.signatures[0]![0]! ^ 1;
    const { response, json } = await call(validBody(corrupted));
    expect(response.status).toBe(400);
    expect(json.error).toBe("Wallet signature does not match the prepared transaction");
    expect(readSelectedPositionState).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects when permit expiry passes during fresh state reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const body = validBody(transaction, { expiresAt: Date.now() + 1_000 });
    vi.mocked(readSelectedPositionState).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 2_000);
      return chainState() as never;
    });
    const { json } = await call(body);
    expect(json.error).toBe("Signed transaction expired before broadcast");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects when the chain passes lastValidBlockHeight during simulation (second height read)", async () => {
    connection.getBlockHeight.mockResolvedValueOnce(100).mockResolvedValueOnce(151);
    const { json } = await call(validBody(transaction));
    expect(json).toEqual({ error: "Signed transaction expired before broadcast" });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/selected-broadcast: broadcast result handling", () => {
  it("rejects when the RPC returns a different signature than the wallet signature", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Dedicated RPC returned transaction signature mismatch" });
    expect(lookupBeamAfterSend).not.toHaveBeenCalled();
  });

  it("QUIRK: errors never carry sent:false, even when nothing was broadcast (open/compound routes do)", async () => {
    connection.getBlockHeight.mockRejectedValue(new Error("boom"));
    const { json } = await call(validBody(transaction));
    expect(json).not.toHaveProperty("sent");
  });

  it("redacts RPC URLs and api keys from a sendRawTransaction failure", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("failed https://rpc.example/x?api-key=SECRET123 api_key=SECRET123"));
    const { response, json } = await call(validBody(transaction));
    expect(response.status).toBe(400);
    expect(JSON.stringify(json)).not.toContain("SECRET123");
    expect(JSON.stringify(json)).not.toContain("rpc.example");
    expect(String(json.error)).toContain("[redacted]");
  });

  it("maps a blockhash-not-found send failure to the public expired message", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("Transaction simulation failed: Blockhash not found"));
    const { json } = await call(validBody(transaction));
    expect(String(json.error)).toContain("Transaction blockhash expired.");
  });

  it("a Beam outage cannot turn a successful send into an error", async () => {
    vi.mocked(lookupBeamAfterSend).mockRejectedValue(new Error("beam down"));
    const { response, json } = await call(validBody(transaction));
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(json.signature).toBe(signatureOf(transaction));
    expect(lookupBeamAfterSend).not.toHaveBeenCalled();
  });
});
