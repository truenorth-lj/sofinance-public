// Proves that every server call site still gets the SAME value from the env as before the
// lib/config/server-env refactor (the old inline `process.env.JUPITER_API_KEY [|| ""]` reads).
// Real: token-metadata, rwa-jupiter-tags, mint-symbols, jupiter-route, mcp-token, verify-sign-token.
// Mocked: the heavy builders and the permit issuers of the four prepare routes (only the secret argument is asserted).
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The relay permit has its own tests (tx-send route); here only the prepare permit issuer is observed.
vi.mock("@/lib/tx-send/permit", () => ({ sendPermitFor: vi.fn(() => "send-permit"), txPermitsFor: vi.fn(() => ({ sendPermit: "send-permit", landedPermit: "landed-permit" })) }));
vi.mock("@sofinance/engine/api-input", () => ({ parseSelectedQuoteRequest: vi.fn(), parseWallet: vi.fn((w: string) => w) }));
vi.mock("@/lib/open-api", () => ({ parseOpenQuoteRequest: vi.fn(), parseOpenPrepareRequest: vi.fn() }));
vi.mock("@/lib/compound-api", () => ({ parseCompoundSelection: vi.fn(), readCompoundBody: vi.fn() }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: vi.fn() }));
vi.mock("@sofinance/engine/open-atomic", () => ({ buildAndSimulateOpenPosition: vi.fn() }));
vi.mock("@sofinance/engine/compound-atomic", () => ({ buildAndSimulateCompound: vi.fn() }));
vi.mock("@sofinance/engine/compound-recovery", () => ({ buildAndSimulateCompoundRecovery: vi.fn() }));
vi.mock("@/lib/selected-permit", () => ({ issueSelectedPermit: vi.fn(() => "permit") }));
vi.mock("@/lib/open-permit", () => ({ issueOpenPositionPermit: vi.fn(() => "permit") }));
vi.mock("@/lib/compound-permit", () => ({ issueCompoundPermit: vi.fn(() => "permit") }));

import { NextRequest } from "next/server";
import { parseSelectedQuoteRequest } from "@sofinance/engine/api-input";
import { parseOpenPrepareRequest } from "@/lib/open-api";
import { parseCompoundSelection, readCompoundBody } from "@/lib/compound-api";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { buildAndSimulateOpenPosition } from "@sofinance/engine/open-atomic";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { buildAndSimulateCompoundRecovery } from "@sofinance/engine/compound-recovery";
import { issueSelectedPermit } from "@/lib/selected-permit";
import { issueOpenPositionPermit } from "@/lib/open-permit";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { createSignToken } from "@/lib/pending-sign-token";
import { clearUsedChallengeNonces, verifyMcpToken } from "@/lib/mcp-auth";
import { buildRoute } from "@sofinance/engine/swap/jupiter";
import { fetchJupiterTagsByMint } from "@/lib/rwa-jupiter-tags";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { resolveMintSymbols } from "@sofinance/engine/mint-symbols";
import { POST as preparedOpen } from "@/app/api/open-prepare/route";
import { POST as preparedSelected } from "@/app/api/selected-prepare/route";
import { POST as preparedCompound } from "@/app/api/compound-prepare/route";
import { POST as preparedRecovery } from "@/app/api/compound-recover-prepare/route";
import { POST as verifySignToken } from "@/app/api/verify-sign-token/route";
import { GET as challengeGet, POST as mcpTokenPost } from "@/app/api/mcp-token/route";

const tx = { message: { serialize: () => Buffer.from("m") }, serialize: () => Buffer.from("t") };
const built = { summary: { quote: { requested: "1", floorBps: 9900, liquidity: "1", rangeSide: "inside" }, expiresAt: 1,
  lastValidBlockHeight: 1, startingLiquidity: "1", startingBalances: {} }, transaction: tx } as never;
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", undefined);
  vi.stubEnv("E2E_KEYLESS_JUPITER", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); clearUsedChallengeNonces(); });

describe("prepare routes pass the signing secret to the permit issuer (getSigningSecret semantics)", () => {
  async function secretUsed(run: () => Promise<Response>, issuer: { mock: { calls: unknown[][] } }) {
    const response = await run();
    expect(response.status).toBe(200);
    return issuer.mock.calls.at(-1)?.[0];
  }
  const cases: [string, () => Promise<Response>, { mock: { calls: unknown[][] } }, () => void][] = [
    ["open-prepare", () => preparedOpen(post("/api/open-prepare", {})), vi.mocked(issueOpenPositionPermit), () => {
      vi.mocked(parseOpenPrepareRequest).mockResolvedValue({ wallet: "w", selection: {}, amount: "1", range: {}, floorBps: 1, toleranceBps: 1, nftMint: "m" } as never);
      vi.mocked(buildAndSimulateOpenPosition).mockResolvedValue(built);
    }],
    ["selected-prepare", () => preparedSelected(post("/api/selected-prepare", {})), vi.mocked(issueSelectedPermit), () => {
      vi.mocked(parseSelectedQuoteRequest).mockResolvedValue({ wallet: "w", selection: {}, amount: "1", floorBps: 1, toleranceBps: 1 } as never);
      vi.mocked(buildAndSimulateSelectedZap).mockResolvedValue(built);
    }],
    ["compound-prepare", () => preparedCompound(post("/api/compound-prepare", {})), vi.mocked(issueCompoundPermit), () => {
      vi.mocked(parseCompoundSelection).mockResolvedValue({ wallet: "w", positionMint: "p", sourceSignatures: [] } as never);
      vi.mocked(buildAndSimulateCompound).mockResolvedValue(built);
    }],
    ["compound-recover-prepare", () => preparedRecovery(post("/api/compound-recover-prepare", {})), vi.mocked(issueCompoundPermit), () => {
      vi.mocked(readCompoundBody).mockResolvedValue({ wallet: "w", compoundAccounts: [] } as never);
      vi.mocked(buildAndSimulateCompoundRecovery).mockResolvedValue(built);
    }],
  ];
  it.each(cases)("%s", async (_name, run, issuer, arrange) => {
    arrange();
    vi.stubEnv("JUPITER_API_KEY", "route-secret");
    expect(await secretUsed(run, issuer)).toBe("route-secret");
    vi.stubEnv("JUPITER_API_KEY", undefined);
    expect(await secretUsed(run, issuer)).toBe("");   // unset -> "" (the issuer then refuses to sign)
    vi.stubEnv("JUPITER_API_KEY", "  padded  ");
    expect(await secretUsed(run, issuer)).toBe("  padded  ");   // nothing is trimmed
  });
});

describe("verify-sign-token", () => {
  const payload = { kind: "open-position", wallet: "w", unsignedTransaction: "u", permit: "p", submitArgs: {}, expiresAt: Date.now() + 60_000 } as never;
  it("uses the signing secret: a token made with the key verifies; unset -> configuration error", async () => {
    const token = await createSignToken(payload, "sign-secret");
    vi.stubEnv("JUPITER_API_KEY", "sign-secret");
    const ok = await verifySignToken(post("/api/verify-sign-token", { token }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).wallet).toBe("w");
    vi.stubEnv("JUPITER_API_KEY", "another-secret");
    expect((await verifySignToken(post("/api/verify-sign-token", { token }))).status).not.toBe(200);
    vi.stubEnv("JUPITER_API_KEY", undefined);
    const unset = await verifySignToken(post("/api/verify-sign-token", { token }));
    expect(unset.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await unset.json())).toContain("Sign token secret not configured");
  });
});

describe("mcp-token", () => {
  async function signedChallenge() {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const challenge = await (await challengeGet(new NextRequest(`http://localhost/api/mcp-token?wallet=${wallet}`))).json();
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), keypair.secretKey));
    return { wallet, message: challenge.message as string, signature };
  }
  const issue = (body: unknown) => mcpTokenPost(new NextRequest("http://localhost/api/mcp-token", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  it("signs the token with the key; unset key is a 500 configuration error", async () => {
    vi.stubEnv("JUPITER_API_KEY", "mcp-secret");
    const first = await signedChallenge();
    const response = await issue(first);
    expect(response.status).toBe(200);
    const { token } = await response.json();
    expect(verifyMcpToken(token, "mcp-secret")?.wallet).toBe(first.wallet);
    expect(verifyMcpToken(token, "other-secret")).toBeNull();

    vi.stubEnv("JUPITER_API_KEY", undefined);
    const second = await signedChallenge();
    const unset = await issue(second);
    expect(unset.status).toBe(500);
    expect((await unset.json()).error).toBe("Server configuration error: JUPITER_API_KEY not set");
  });
});

const mint = "So11111111111111111111111111111111111111112";
describe("Jupiter-facing readers default to the env key but accept an override", () => {
  const okJson = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const keyHeader = (fetcher: typeof fetch, call = 0) => {
    const init = vi.mocked(fetcher).mock.calls[call]?.[1] as { headers?: Record<string, string> } | undefined;
    return init?.headers?.["x-api-key"];
  };
  const fresh = () => Keypair.generate().publicKey.toBase58();   // unique mints: the readers cache by mint

  it("getTokenMetadata: default parameter", async () => {
    vi.stubEnv("JUPITER_API_KEY", "meta-key");
    const fetcher = okJson([]);
    await getTokenMetadata([fresh()], fetcher);
    expect(keyHeader(fetcher)).toBe("meta-key");
    const explicit = okJson([]);
    await getTokenMetadata([fresh()], explicit, "explicit-key");
    expect(keyHeader(explicit)).toBe("explicit-key");
    vi.stubEnv("JUPITER_API_KEY", undefined);
    const keyless = okJson([]);
    await getTokenMetadata([fresh()], keyless);
    expect(keyHeader(keyless)).toBeUndefined();
  });

  it("fetchJupiterTagsByMint: options.apiKey ?? env", async () => {
    vi.stubEnv("JUPITER_API_KEY", "tags-key");
    const fetcher = okJson([]);
    await fetchJupiterTagsByMint([fresh()], { fetcher, bypassCache: true });
    expect(keyHeader(fetcher)).toBe("tags-key");
    const explicit = okJson([]);
    await fetchJupiterTagsByMint([fresh()], { fetcher: explicit, bypassCache: true, apiKey: "explicit-key" });
    expect(keyHeader(explicit)).toBe("explicit-key");
  });

  it("resolveMintSymbols: options.jupiterApiKey ?? env reaches the Jupiter fallback", async () => {
    vi.stubEnv("JUPITER_API_KEY", "symbols-key");
    const calls: [string, string | undefined][] = [];
    const fetcher = vi.fn(async (url: URL | string, init?: { headers?: Record<string, string> }) => {
      calls.push([String(url), init?.headers?.["x-api-key"]]);
      return new Response("[]");
    }) as unknown as typeof fetch;
    await resolveMintSymbols([fresh()], { fetcher, bypassCache: true });
    const jupiter = calls.filter(([url]) => url.includes("jup.ag"));
    expect(jupiter.length).toBeGreaterThan(0);
    expect(jupiter.every(([, key]) => key === "symbols-key")).toBe(true);
    calls.length = 0;
    await resolveMintSymbols([fresh()], { fetcher, bypassCache: true, jupiterApiKey: "explicit-key" });
    expect(calls.filter(([url]) => url.includes("jup.ag")).every(([, key]) => key === "explicit-key")).toBe(true);
  });

  it("buildRoute: unset key is refused (unless the e2e keyless flag is set), set key goes to the quote request", async () => {
    await expect(buildRoute("w", mint, mint, 1n)).rejects.toThrow("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
    vi.stubEnv("E2E_KEYLESS_JUPITER", "1");
    await expect(buildRoute("w", mint, mint, 0n)).rejects.toThrow("Route amount must be greater than zero");
    vi.stubEnv("E2E_KEYLESS_JUPITER", undefined);
    vi.stubEnv("JUPITER_API_KEY", "route-key");
    await expect(buildRoute("w", mint, mint, 0n)).rejects.toThrow("Route amount must be greater than zero");
  });
});
