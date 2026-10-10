import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getTokenMetadata } from "./token-metadata";

describe("getTokenMetadata", () => {
  it("keeps only exact requested mints and trusted icon URLs", async () => {
    const mintA = "So11111111111111111111111111111111111111112";
    const mintB = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      { id: mintA, name: " Wrapped SOL ", symbol: " SOL ", decimals: 9,
        icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/logo.png", isVerified: true },
      { id: mintB, name: "USD Coin", symbol: "USDC", decimals: 6,
        icon: "https://untrusted.example/logo.png", isVerified: false },
      { id: "not-requested", name: "Fake SOL", symbol: "SOL", decimals: 9 },
    ]))) as unknown as typeof fetch;
    const metadata = await getTokenMetadata([mintA, mintB], fetcher, "test-key");
    expect(Object.keys(metadata)).toEqual([mintA, mintB]);
    expect(metadata[mintA]).toMatchObject({ name: "Wrapped SOL", symbol: "SOL", isVerified: true });
    expect(metadata[mintB]).toMatchObject({ icon: null, isVerified: false });
    expect(String(vi.mocked(fetcher).mock.calls[0]?.[0])).toContain(`${mintA}%2C${mintB}`);
  });

  it("falls back cleanly when Jupiter metadata is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    expect(await getTokenMetadata(["mint"], fetcher, "test-key")).toEqual({});
    expect(await getTokenMetadata(["mint"], fetcher, "")).toEqual({});
    expect(vi.mocked(fetcher).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
