import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildRoute, quoteRoute, JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { JupiterHttpError, resetJupiterRuntime, setJupiterLogger, setJupiterRetryConfig } from "@sofinance/engine/jupiter";

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", "test-only");
  setJupiterLogger(() => {}); setJupiterRetryConfig({ maxAttempts: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetJupiterRuntime(); });

it.each([429, 502, 503])("preserves the typed /build upstream error HTTP %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "upstream" }, {
    status, headers: { "Retry-After": "30" },
  })));
  const pending = buildRoute("wallet", "A", "B", 10n);
  await expect(pending).rejects.toBeInstanceOf(JupiterHttpError);
  await expect(pending).rejects.toMatchObject({ status, retryAfterMs: 30_000, path: "/swap/v1/quote" });
});

it("keeps genuine no-route distinct", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "no routes found" }, { status: 400 })));
  await expect(buildRoute("wallet", "A", "B", 10n)).rejects.toBeInstanceOf(JupiterNoRouteError);
});

it("maps quoteRoute HTTP 400 NO_ROUTES_FOUND to JupiterNoRouteError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Response.json(
    { error: "No routes found", errorCode: "NO_ROUTES_FOUND" }, { status: 400 })));
  await expect(quoteRoute("A", "B", 10n)).rejects.toBeInstanceOf(JupiterNoRouteError);
  await expect(quoteRoute("A", "B", 10n)).rejects.toMatchObject({ code: "jupiter_no_route" });
});

it("does not replace a transport or parent cancellation cause with no-route", async () => {
  const failure = new TypeError("fetch failed");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(buildRoute("wallet", "A", "B", 10n)).rejects.toBe(failure);
  const controller = new AbortController(); const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  await expect(buildRoute("wallet", "A", "B", 10n, false, { maxAccounts: 24 }, controller.signal)).rejects.toBe(reason);
});

it("builds only with the shared v1 quote and swap-instructions client", async () => {
  const quote = { inputMint: "A", outputMint: "B", inAmount: "100", outAmount: "99", otherAmountThreshold: "98",
    swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [{ percent: 100,
      swapInfo: { ammKey: "pool", inputMint: "A", outputMint: "B", inAmount: "100", outAmount: "99" } }] };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(quote)).mockResolvedValueOnce(Response.json({
    computeBudgetInstructions: [], setupInstructions: [], otherInstructions: [], cleanupInstruction: null,
    swapInstruction: { programId: "program", data: "AQ==", accounts: [] }, addressLookupTableAddresses: ["table"],
  }));
  vi.stubGlobal("fetch", fetcher);
  const route = await buildRoute("wallet", "A", "B", 100n, false, { maxAccounts: 20, onlyDirectRoutes: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const quoteUrl = new URL(String(fetcher.mock.calls[0]![0]));
  expect(quoteUrl.pathname).toBe("/swap/v1/quote");
  expect(quoteUrl.searchParams.get("instructionVersion")).toBe("V2");
  expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe("/swap/v1/swap-instructions");
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ userPublicKey: "wallet", quoteResponse: {
    inputMint: "A", outputMint: "B", inAmount: "100" }, wrapAndUnwrapSol: false, prioritizationFeeLamports: 0 });
  expect(route.addressesByLookupTableAddress).toEqual({ table: [] });
  expect(route.routePlan[0]!.bps).toBe(10000);
});
