// POST /api/mcp-token hands out an MCP config URL. Production must never point it at the
// per-deployment *.vercel.app host (protected, pinned to one build).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/capture", () => ({ captureApiRouteError: vi.fn() }));

const { GET, POST } = await import("./route");

async function mintConfigUrl(): Promise<string> {
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const challenge = await (await GET(new NextRequest(`https://x.test/api/mcp-token?wallet=${wallet}`))).json();
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), keypair.secretKey));
  const response = await POST(new NextRequest("https://x.test/api/mcp-token", {
    method: "POST",
    body: JSON.stringify({ wallet, message: challenge.message, signature }),
  }));
  expect(response.status).toBe(200);
  return (await response.json()).mcpConfig.mcpServers.sofinance.url;
}

describe("POST /api/mcp-token mcpConfig url", () => {
  beforeEach(() => {
    vi.stubEnv("JUPITER_API_KEY", "test-signing-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("production uses the canonical site, not VERCEL_URL", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", "sofinance-abc123-team.vercel.app");
    expect(await mintConfigUrl()).toBe("https://sofinancelab.xyz/api/mcp");
  });

  it("a preview deployment points at itself", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "sofinance-abc123-team.vercel.app");
    expect(await mintConfigUrl()).toBe("https://sofinance-abc123-team.vercel.app/api/mcp");
  });

  it("NEXT_PUBLIC_APP_URL wins, and off Vercel falls back to the canonical site", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.invalid.example/");
    expect(await mintConfigUrl()).toBe("https://app.invalid.example/api/mcp");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
    vi.stubEnv("VERCEL_URL", undefined);
    expect(await mintConfigUrl()).toBe("https://sofinancelab.xyz/api/mcp");
  });
});
