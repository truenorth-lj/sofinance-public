import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { clearMintSymbolsCache, RAYDIUM_MINT_IDS, resolveMintSymbols } from "./mint-symbols";

/** Public Token-2022 xStock / RWA mint ids (not wallets). */
const HOODX = "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg";
const HOOD = "HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A";
const SPCX = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
const SPCXX = "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8";

describe("resolveMintSymbols", () => {
  it("prefers on-chain Token-2022 symbols and then Raydium mint/ids", async () => {
    clearMintSymbolsCache();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(RAYDIUM_MINT_IDS);
      return new Response(JSON.stringify({
        success: true,
        data: [
          { address: HOODX, symbol: "HOODx", name: "Robinhood xStock" },
          { address: HOOD, symbol: "HOOD", name: "Robinhood" },
          { address: SPCX, symbol: "SPCX", name: "SpaceX" },
          { address: SPCXX, symbol: "SPCXx", name: "SpaceX xStock" },
        ],
      }));
    }) as unknown as typeof fetch;

    const fromChain = await resolveMintSymbols([HOODX, HOOD], {
      fetcher,
      bypassCache: true,
      onChain: { [HOODX]: "HOODx" },
    });
    expect(fromChain[HOODX]).toBe("HOODx");
    expect(fromChain[HOOD]).toBe("HOOD");

    const fromRaydium = await resolveMintSymbols([SPCX, SPCXX], {
      fetcher,
      bypassCache: true,
    });
    expect(fromRaydium).toEqual({ [SPCX]: "SPCX", [SPCXX]: "SPCXx" });
  });

  it("falls back to Jupiter when Raydium has no row", async () => {
    clearMintSymbolsCache();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api-v3.raydium.io")) {
        return new Response(JSON.stringify({ success: true, data: [] }));
      }
      return new Response(JSON.stringify([
        { id: SPCXX, name: "SpaceX xStock", symbol: "SPCXx", decimals: 8 },
        { id: SPCX, name: "SpaceX", symbol: "SPCX", decimals: 6 },
      ]));
    }) as unknown as typeof fetch;

    const symbols = await resolveMintSymbols([SPCXX, SPCX], { fetcher, bypassCache: true });
    expect(symbols).toEqual({ [SPCXX]: "SPCXx", [SPCX]: "SPCX" });
  });
});
