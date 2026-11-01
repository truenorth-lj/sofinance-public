import { ComputeBudgetProgram, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fake = vi.hoisted(() => ({ adapter: null as null | Record<string, unknown>, ids: [] as string[] }));
vi.mock("@/lib/dex", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dex")>();
  return { ...original, dexRegistry: { ...original.dexRegistry, adapterFor: async (id: string) => (fake.ids.includes(id) ? fake.adapter : null) } };
});

import { DexError } from "@/lib/dex";
import { POST } from "./route";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const other = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const tx = (payer = owner) => Buffer.from(new VersionedTransaction(new TransactionMessage({
  payerKey: payer, recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })],
}).compileToV0Message()).serialize()).toString("base64");
const openRequest = { poolId: "Pool1111111111111111111111111111111111111111", owner: owner.toBase58(), range: { kind: "preset", presetId: "standard" }, input: { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" }, slippageBps: 50 };
const call = (op: string, body: unknown, dex = "some-dex") => POST(
  new Request(`http://localhost/api/dex/${dex}/${op}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  { params: Promise.resolve({ dex, op }) },
);

describe("POST /api/dex/[dex]/[op]", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "development");
    vi.stubEnv("JUPITER_API_KEY", "route-test-secret");
    fake.ids = ["some-dex"];
    fake.adapter = {
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
});
