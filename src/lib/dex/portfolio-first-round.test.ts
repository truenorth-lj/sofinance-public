import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), gma: vi.fn(), single: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: mocks.rpc }));
import type { PortfolioInput } from "@/lib/portfolio/model";
import { raydiumPortfolioAccountKeys } from "./raydium-clmm/portfolio-keys.server";

// A registry double whose readers load lazily (Meteora's adapter import is slower than Raydium's), like the real modules.
const LAZY_MS = { "raydium-clmm": 2, "meteora-dlmm": 15 } as const;
vi.mock("./index", () => ({
  dexRegistry: {
    portfolioAccountKeys: async (source: keyof typeof LAZY_MS, ids: readonly string[]) =>
      source === "raydium-clmm" ? raydiumPortfolioAccountKeys(ids) : [...ids],
    preparePortfolio: async (source: keyof typeof LAZY_MS, input: PortfolioInput, _signal: AbortSignal, accounts: import("@solana/web3.js").Connection) => {
      await new Promise((resolve) => setTimeout(resolve, LAZY_MS[source]));
      const ids = input.positions.map((item) => item.key.split(":")[1]!);
      // Each DEX's own first read: Raydium one personal-position PDA per row, Meteora one batch of position accounts.
      if (source === "raydium-clmm") await Promise.all(raydiumPortfolioAccountKeys(ids).map((address) => accounts.getAccountInfo(new PublicKey(address), "confirmed")));
      else await accounts.getMultipleAccountsInfo(ids.map((id) => new PublicKey(id)), "confirmed");
      return async () => ({ figures: { stock: "X", shares: 1, valueUsd: 1, unclaimedFeesUsd: 0, cumulativeFeesUsd: 1 }, evaluatedAt: null, historyComplete: true, historyRefreshResolved: true });
    },
  },
}));
import { readPortfolio } from "./portfolio.server";

const address = () => Keypair.generate().publicKey.toBase58();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gma.mockImplementation(async (keys: PublicKey[]) => keys.map(() => null));
  mocks.rpc.mockReturnValue({ getMultipleAccountsInfo: mocks.gma, getAccountInfo: mocks.single });
});

describe("Portfolio first account round", () => {
  it("reads three Raydium positions and one Meteora position in one getMultipleAccounts, then serves both readers from it", async () => {
    const raydium = [address(), address(), address()], meteora = address();
    const result = await readPortfolio({ wallet: address(), positions: [...raydium.map((id) => ({ key: `raydium-clmm:${id}` })), { key: `meteora-dlmm:${meteora}` }] },
      new AbortController().signal);
    expect(result.positions.map((row) => row.status)).toEqual(["ready", "ready", "ready", "ready"]);
    expect(mocks.gma).toHaveBeenCalledTimes(1);
    expect(mocks.gma.mock.calls[0]![0].map(String)).toEqual([...raydiumPortfolioAccountKeys(raydium), meteora]);
    expect(mocks.gma.mock.calls[0]![1]).toBe("confirmed"); expect(mocks.single).not.toHaveBeenCalled();
  });
  it("lets each reader retry its own accounts when the shared first round is rate limited", async () => {
    mocks.gma.mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { status: 429 }));
    const meteora = address();
    const result = await readPortfolio({ wallet: address(), positions: [{ key: `raydium-clmm:${address()}` }, { key: `meteora-dlmm:${meteora}` }] }, new AbortController().signal);
    expect(result.positions.map((row) => row.status)).toEqual(["ready", "ready"]);
    expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.gma.mock.calls.length).toBeGreaterThan(1);
  });
});
