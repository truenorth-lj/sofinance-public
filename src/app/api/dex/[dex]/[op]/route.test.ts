import { ComputeBudgetProgram, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fake = vi.hoisted(() => ({ adapter: null as null | Record<string, unknown>, ids: [] as string[] }));
vi.mock("@/lib/dex", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dex")>();
  return { ...original, dexRegistry: { ...original.dexRegistry, adapterFor: async (id: string) => (fake.ids.includes(id) ? fake.adapter : null) } };
});

import { DexError } from "@/lib/dex";
import { dexDescriptors } from "@/lib/dex/client";
import { DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE, DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE, resetDexRouteRateLimit } from "@/lib/dex-route-rate-limit";
import { POST } from "./route";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const other = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const tx = (payer = owner) => Buffer.from(new VersionedTransaction(new TransactionMessage({
  payerKey: payer, recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })],
}).compileToV0Message()).serialize()).toString("base64");
const openRequest = { poolId: "Pool1111111111111111111111111111111111111111", owner: owner.toBase58(), range: { kind: "preset", presetId: "standard" }, input: { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" }, slippageBps: 50 };
const call = (op: string, body: unknown, dex = "some-dex", ip = "203.0.113.1") => POST(
  new Request(`http://localhost/api/dex/${dex}/${op}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-real-ip": ip } }),
  { params: Promise.resolve({ dex, op }) },
);

describe("POST /api/dex/[dex]/[op]", () => {
  beforeEach(() => {
    resetDexRouteRateLimit();
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "development");
    vi.stubEnv("JUPITER_API_KEY", "route-test-secret");
    fake.ids = ["some-dex"];
    fake.adapter = {
      descriptor: dexDescriptors.descriptorFor("meteora-dlmm"),
      quoteOpen: vi.fn(async () => ({ poolId: openRequest.poolId, range: { lowerPrice: 1, upperPrice: 2, units: 10 }, steps: 2, rent: null, platformFeeRaw: "0" })),
      prepareOpen: vi.fn(async (_request: unknown, context: { step: number }) => ({
        step: context.step, of: 2, label: "Step", done: context.step === 2, planToken: "plan",
        prepared: { kind: "solana-tx", transaction: tx(), lastValidBlockHeight: 50 },
      })),
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off in production", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "production");
    expect((await call("quote-open", { request: openRequest })).status).toBe(404);
  });

  it("404s an unknown DEX or operation", async () => {
    expect((await call("quote-open", { request: openRequest }, "nope")).status).toBe(404);
    expect((await call("drain", {})).status).toBe(404);
  });

  it("quotes through the registry adapter", async () => {
    const response = await call("quote-open", { request: openRequest });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ steps: 2, platformFeeRaw: "0" });
  });

  it("rejects a malformed body with 400", async () => {
    const response = await call("open", { request: { ...openRequest, input: { token: "x", amountRaw: "1.5" } }, step: 1, priorSignatures: [] });
    expect(response.status).toBe(400);
  });

  it("returns a step with the wallet's send and landed permits", async () => {
    const response = await call("open", { request: openRequest, step: 1, priorSignatures: [] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ step: 1, of: 2, planToken: "plan", prepared: { kind: "solana-tx" } });
    expect(body.prepared.sendPermit).toMatch(/^[0-9a-f]{64}$/);
    expect(body.prepared.landedPermit).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a step not paid by the requesting wallet", async () => {
    (fake.adapter!.prepareOpen as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ step: 1, of: 2, label: "x", done: false, prepared: { kind: "solana-tx", transaction: tx(other), lastValidBlockHeight: 50 } });
    const response = await call("open", { request: openRequest, step: 1, priorSignatures: [] });
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("UPSTREAM");
  });

  it("maps a DexError to its status and plain message", async () => {
    (fake.adapter!.quoteOpen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DexError("INVALID_REQUEST", "The amount is zero."));
    const response = await call("quote-open", { request: openRequest });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The amount is zero.", code: "INVALID_REQUEST" });
  });

  it("says when a DEX has no recovery step", async () => {
    const response = await call("recovery", { wallet: owner.toBase58(), positionKey: "some-dex:abc", step: 1, priorSignatures: [] });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("UNSUPPORTED");
  });

  it("never returns a stack trace, an RPC URL or a credential in an error response", async () => {
    const leaky = "RPC failed at https://rpc.example-node.invalid/?api-key=sk_live_abcdef0123456789 token=abcdef0123456789abcdef\n    at Connection.send (/var/task/node_modules/@solana/web3.js/lib/index.cjs.js:1:2)";
    const quote = fake.adapter!.quoteOpen as ReturnType<typeof vi.fn>;
    const leakyStack = Object.assign(new Error(leaky), { stack: `Error: ${leaky}\n    at run (/var/task/route.js:9:9)` });
    quote.mockRejectedValueOnce(new DexError("UPSTREAM", leaky)).mockRejectedValueOnce(leakyStack);
    for (const expected of [502, 503]) {
      const response = await call("quote-open", { request: openRequest });
      expect(response.status).toBe(expected);
      const text = await response.text();
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/example-node|api-key|sk_live|abcdef0123456789/);
      expect(text).not.toMatch(/\bat \S+ \(|node_modules|\.js:\d+|\/var\/task/);
      expect(JSON.parse(text).error).toEqual(expect.any(String));
    }
  });

  it("never accepts a cosigner secret: only a public key, and no extra fields", async () => {
    const secret = Keypair.generate().secretKey;
    const bodies = [
      { request: { ...openRequest, cosigner: Buffer.from(secret).toString("base64") } },
      { request: { ...openRequest, cosigner: Array.from(secret) } },
      { request: { ...openRequest, cosignerSecret: Array.from(secret) } },
      { request: openRequest, secretKey: Array.from(secret) },
    ];
    for (const body of bodies) {
      expect((await call("open", { ...body, step: 1, priorSignatures: [] })).status).toBe(400);
    }
    expect(fake.adapter!.prepareOpen).not.toHaveBeenCalled();
    const cosigner = Keypair.generate().publicKey.toBase58();
    expect((await call("open", { request: { ...openRequest, cosigner }, step: 1, priorSignatures: [] })).status).toBe(200);
    expect((fake.adapter!.prepareOpen as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ cosigner });
  });

  it("passes the requesting wallet to recovery as the owner", async () => {
    const prepareRecovery = vi.fn(async () => ({ step: 1, of: 1, label: "Close", done: true, prepared: { kind: "solana-tx", transaction: tx(), lastValidBlockHeight: 50 } }));
    fake.adapter = { ...fake.adapter, prepareRecovery };
    const response = await call("recovery", { wallet: owner.toBase58(), positionKey: "some-dex:abc", step: 1, priorSignatures: [] });
    expect(response.status).toBe(200);
    expect(prepareRecovery).toHaveBeenCalledWith("some-dex:abc", owner.toBase58(), { step: 1, priorSignatures: [] });
  });

  it("routes add / withdraw / claim / compound to the adapter with the requesting wallet as owner, returning permitted steps", async () => {
    const step = async () => ({ step: 1, of: 1, label: "Op", done: true, prepared: { kind: "solana-tx", transaction: tx(), lastValidBlockHeight: 50 } });
    const prepareAdd = vi.fn(step);
    const prepareWithdraw = vi.fn(step);
    const prepareClaim = vi.fn(step);
    const prepareCompound = vi.fn(step);
    fake.adapter = { ...fake.adapter, prepareAdd, prepareWithdraw, prepareClaim, prepareCompound };
    const common = { owner: owner.toBase58(), positionKey: "some-dex:abc", step: 1, priorSignatures: [] };
    const context = { step: 1, priorSignatures: [] };
    const added = await call("add", { ...common, input: { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" } });
    expect(added.status).toBe(200);
    expect((await added.json()).prepared).toMatchObject({ sendPermit: expect.any(String), landedPermit: expect.any(String) });
    expect(prepareAdd).toHaveBeenCalledWith("some-dex:abc", owner.toBase58(), { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" }, context);
    expect((await call("withdraw", { ...common, fraction: 0.5, output: "pool-tokens" })).status).toBe(200);
    expect(prepareWithdraw).toHaveBeenCalledWith("some-dex:abc", owner.toBase58(), { fraction: 0.5, output: "pool-tokens" }, context);
    expect((await call("claim", common)).status).toBe(200);
    expect(prepareClaim).toHaveBeenCalledWith("some-dex:abc", owner.toBase58(), context);
    const compounded = await call("compound", common);
    expect(compounded.status).toBe(200);
    expect((await compounded.json()).prepared).toMatchObject({ sendPermit: expect.any(String), landedPermit: expect.any(String) });
    expect(prepareCompound).toHaveBeenCalledWith("some-dex:abc", owner.toBase58(), context);
  });

  it("400s a position op with a non-base58 owner, a bad share or an extra field, before the adapter runs", async () => {
    const prepareWithdraw = vi.fn();
    const prepareClaim = vi.fn();
    fake.adapter = { ...fake.adapter, prepareWithdraw, prepareClaim };
    const common = { owner: owner.toBase58(), positionKey: "some-dex:abc", step: 1, priorSignatures: [] };
    for (const body of [
      { ...common, owner: "0x" + "ab".repeat(20) },
      { ...common, owner: owner.toBase58() + "1" },
      { ...common, extra: 1 },
    ]) {
      expect((await call("claim", body)).status).toBe(400);
      expect((await call("compound", body)).status).toBe(400);
    }
    for (const fraction of [0, -0.1, 1.01]) expect((await call("withdraw", { ...common, fraction, output: "pool-tokens" })).status).toBe(400);
    expect((await call("withdraw", { ...common, fraction: 1, output: "bogus" })).status).toBe(400);
    // A known output the DEX does not list in capabilities.withdrawOutputs (Meteora: pool tokens only) is refused before the adapter.
    for (const output of ["usdc", "sol"]) {
      const refused = await call("withdraw", { ...common, fraction: 1, output });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: "UNSUPPORTED", error: expect.stringMatching(/isn't available for this pool yet/) });
    }
    expect(prepareWithdraw).not.toHaveBeenCalled();
    expect(prepareClaim).not.toHaveBeenCalled();
  });

  it("returns 404 POSITION_NOT_FOUND when the adapter says the position belongs to another wallet", async () => {
    fake.adapter = { ...fake.adapter, prepareClaim: vi.fn(async () => { throw new DexError("POSITION_NOT_FOUND", "That Meteora position belongs to another wallet."); }) };
    const response = await call("claim", { owner: other.toBase58(), positionKey: "some-dex:abc", step: 1, priorSignatures: [] });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That Meteora position belongs to another wallet.", code: "POSITION_NOT_FOUND" });
  });

  it("returns 503 with a plain message when the deployment is misconfigured", async () => {
    (fake.adapter!.quoteOpen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DexError("MISCONFIGURED", "Opening positions is temporarily unavailable."));
    const response = await call("quote-open", { request: openRequest });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Opening positions is temporarily unavailable.", code: "MISCONFIGURED" });
  });

  it("refuses a units range outside the DEX's legal bin ids with 400, before the adapter runs", async () => {
    const units = (lower: number, upper: number) => ({ request: { ...openRequest, range: { kind: "units", lower, upper } } });
    for (const [lower, upper] of [[-443_637, 0], [0, 443_637], [10, 9]]) {
      const response = await call("quote-open", units(lower!, upper!));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      expect((await call("open", { ...units(lower!, upper!), step: 1, priorSignatures: [] })).status).toBe(400);
    }
    expect(fake.adapter!.quoteOpen).not.toHaveBeenCalled();
    expect(fake.adapter!.prepareOpen).not.toHaveBeenCalled();
    expect((await call("quote-open", units(-443_636, 443_636))).status).toBe(200);
  });

  it("lists a wallet's positions through the registry adapter (read-only, strict body)", async () => {
    const position = { key: "some-dex:abc", source: "meteora-dlmm", chain: "solana", nativeId: "abc", liquidity: "0" };
    const listPositions = vi.fn(async () => [position]);
    fake.adapter = { ...fake.adapter, listPositions };
    const response = await call("positions", { owner: owner.toBase58() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ positions: [position] });
    expect(listPositions).toHaveBeenCalledWith(owner.toBase58());
    expect((await call("positions", { owner: owner.toBase58(), extra: 1 })).status).toBe(400);
    listPositions.mockRejectedValueOnce(new DexError("UPSTREAM", "The Meteora request could not be completed: fetch failed at https://rpc.example/key"));
    const failed = await call("positions", { owner: owner.toBase58() });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("rpc.example");
  });

  it("400s a positions owner that is not a base58 Solana public key (the DEX's signer is a Solana wallet), before any read", async () => {
    const listPositions = vi.fn(async () => []);
    fake.adapter = { ...fake.adapter, listPositions };
    for (const bad of [
      "0x" + "ab".repeat(20), // an EVM address
      "0OIl" + owner.toBase58().slice(4), // characters outside base58
      "1".repeat(31), // too short
      Keypair.generate().secretKey.reduce((text, byte) => text + "123456789A"[byte % 10], "").slice(0, 64), // 64 chars, not 32 bytes
      owner.toBase58() + "1", // decodes to 33 bytes
      "",
    ]) {
      const response = await call("positions", { owner: bad });
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Invalid request", issues: [{ path: "owner" }] });
    }
    expect((await call("positions", { owner: 42 })).status).toBe(400);
    expect(listPositions).not.toHaveBeenCalled();
    expect((await call("positions", { owner: ` ${owner.toBase58()} ` })).status).toBe(200);
    expect(listPositions).toHaveBeenCalledWith(owner.toBase58());
  });

  it("rate limits positions per IP (429 with Retry-After) without touching other IPs", async () => {
    const listPositions = vi.fn(async () => []);
    fake.adapter = { ...fake.adapter, listPositions };
    for (let i = 0; i < DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE; i++) expect((await call("positions", { owner: owner.toBase58() })).status).toBe(200);
    const limited = await call("positions", { owner: owner.toBase58() });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "Too many requests. Please wait a minute.", code: "RATE_LIMITED" });
    expect(listPositions).toHaveBeenCalledTimes(DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE);
    expect((await call("positions", { owner: owner.toBase58() }, "some-dex", "203.0.113.2")).status).toBe(200);
    // Other ops still have the route-wide budget left.
    expect((await call("quote-open", { request: openRequest })).status).toBe(200);
  });

  it("rate limits every op on the route per IP, before reading the body or resolving the DEX", async () => {
    for (let i = 0; i < DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE; i++) expect((await call("quote-open", { request: openRequest })).status).toBe(200);
    expect((await call("quote-open", { request: openRequest })).status).toBe(429);
    expect((await call("open", { request: openRequest, step: 1, priorSignatures: [] })).status).toBe(429);
    expect((await call("quote-open", { request: openRequest }, "nope")).status).toBe(429);
    expect(fake.adapter!.quoteOpen).toHaveBeenCalledTimes(DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE);
    expect((await call("quote-open", { request: openRequest }, "some-dex", "203.0.113.9")).status).toBe(200);
  });

  it("does not count requests while the route is off (production 404, no limiter state)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "production");
    for (let i = 0; i <= DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE; i++) expect((await call("positions", { owner: owner.toBase58() })).status).toBe(404);
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "development");
    fake.adapter = { ...fake.adapter, listPositions: vi.fn(async () => []) };
    expect((await call("positions", { owner: owner.toBase58() })).status).toBe(200);
  });
});
