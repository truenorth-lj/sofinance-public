import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildRoute, quoteRoute } from "@sofinance/engine/swap/jupiter";
import { resetJupiterRuntime, setJupiterLogger, setJupiterRetryConfig } from "@sofinance/engine/jupiter";
import { JUPITER_MAX_ACCOUNTS } from "@sofinance/engine/jupiter-route-retry";

/**
 * Frozen Jupiter request shapes captured from the pre-refactor positional
 * `quoteRoute` / `buildRoute` API on main (D1 merge). The options-object
 * refactor must keep these query strings and swap-instruction bodies identical.
 * `maxPriceImpactBps` and `previewCache` are not query fields; fee bps 0 is
 * omitted from the query the same way as an unset fee.
 */
const QUOTE_MINIMAL = "/swap/v1/quote?inputMint=A&outputMint=B&amount=10&slippageBps=50&instructionVersion=V2&maxAccounts=24";
const QUOTE_CONSTRAINTS = "/swap/v1/quote?inputMint=A&outputMint=B&amount=10&slippageBps=50&instructionVersion=V2&excludeDexes=OpenBook%2CPhoenix&maxAccounts=20&onlyDirectRoutes=true";
const QUOTE_FEE_10 = "/swap/v1/quote?inputMint=A&outputMint=B&amount=10&slippageBps=50&instructionVersion=V2&platformFeeBps=10&maxAccounts=24";
const BUILD_MINIMAL_QUOTE = "/swap/v1/quote?inputMint=A&outputMint=B&amount=100&slippageBps=50&instructionVersion=V2&maxAccounts=48";
const BUILD_CONSTRAINTS_QUOTE = "/swap/v1/quote?inputMint=A&outputMint=B&amount=100&slippageBps=50&instructionVersion=V2&excludeDexes=OpenBook%2CPhoenix&maxAccounts=20&onlyDirectRoutes=true";
const BUILD_WRAP_QUOTE = "/swap/v1/quote?inputMint=A&outputMint=B&amount=100&slippageBps=50&instructionVersion=V2&maxAccounts=24";
const BUILD_DEST_QUOTE = "/swap/v1/quote?inputMint=A&outputMint=B&amount=100&slippageBps=50&instructionVersion=V2&maxAccounts=16&onlyDirectRoutes=true";

const SWAP_BODY = {
  userPublicKey: "wallet",
  wrapAndUnwrapSol: false,
  useSharedAccounts: false,
  dynamicComputeUnitLimit: false,
  prioritizationFeeLamports: 0,
  destinationTokenAccount: null as string | null,
  feeAccount: null as string | null,
  quoteInAmount: "100",
  quoteInputMint: "A",
  quoteOutputMint: "B",
  quoteSlippageBps: 50,
};

const quoteTemplate = {
  inputMint: "A", outputMint: "B", inAmount: "100", outAmount: "99", otherAmountThreshold: "98",
  swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0",
  routePlan: [{ percent: 100, swapInfo: { ammKey: "pool", inputMint: "A", outputMint: "B", inAmount: "100", outAmount: "99" } }],
};
const swapIx = {
  computeBudgetInstructions: [], setupInstructions: [], otherInstructions: [], cleanupInstruction: null,
  swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", data: "AQ==", accounts: [] },
  addressLookupTableAddresses: ["table"],
};

function installFetch() {
  const fetcher = vi.fn().mockImplementation((url: string) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/quote")) {
      const amount = parsed.searchParams.get("amount") ?? "0";
      const feeBps = parsed.searchParams.get("platformFeeBps");
      return Response.json({
        ...quoteTemplate,
        inputMint: parsed.searchParams.get("inputMint"),
        outputMint: parsed.searchParams.get("outputMint"),
        inAmount: amount, outAmount: amount, otherAmountThreshold: amount,
        slippageBps: Number(parsed.searchParams.get("slippageBps") ?? 50),
        ...(feeBps ? { platformFee: { feeBps: Number(feeBps), amount: "1" } } : {}),
      });
    }
    return Response.json(swapIx);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function requestPath(url: unknown) {
  const parsed = new URL(String(url));
  return `${parsed.pathname}${parsed.search}`;
}

function swapBody(init: { body?: string } | undefined) {
  const body = JSON.parse(String(init?.body));
  return {
    userPublicKey: body.userPublicKey,
    wrapAndUnwrapSol: body.wrapAndUnwrapSol,
    useSharedAccounts: body.useSharedAccounts,
    dynamicComputeUnitLimit: body.dynamicComputeUnitLimit,
    prioritizationFeeLamports: body.prioritizationFeeLamports,
    destinationTokenAccount: body.destinationTokenAccount ?? null,
    feeAccount: body.feeAccount ?? null,
    quoteInAmount: body.quoteResponse?.inAmount,
    quoteInputMint: body.quoteResponse?.inputMint,
    quoteOutputMint: body.quoteResponse?.outputMint,
    quoteSlippageBps: body.quoteResponse?.slippageBps,
  };
}

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", "test-only");
  setJupiterLogger(() => {});
  setJupiterRetryConfig({ maxAttempts: 1 });
  resetJupiterRuntime();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetJupiterRuntime(); });

it.each([
  { name: "quote-minimal", path: QUOTE_MINIMAL, run: () => quoteRoute("A", "B", 10n) },
  { name: "quote-constraints", path: QUOTE_CONSTRAINTS, run: () => quoteRoute("A", "B", 10n, {
    constraints: { maxAccounts: 20, onlyDirectRoutes: true, excludeDexes: "OpenBook,Phoenix" },
  }) },
  { name: "quote-fee-10", path: QUOTE_FEE_10, run: () => quoteRoute("A", "B", 10n, { constraints: { maxAccounts: 24 }, platformFeeBps: 10 }) },
  { name: "quote-fee-0 omitted from query", path: QUOTE_MINIMAL, run: () => quoteRoute("A", "B", 10n, { constraints: { maxAccounts: 24 }, platformFeeBps: 0 }) },
  { name: "quote-fee-10 previewCache true", path: QUOTE_FEE_10, run: () => quoteRoute("A", "B", 10n, {
    constraints: { maxAccounts: 24 }, platformFeeBps: 10, maxPriceImpactBps: 500, previewCache: true,
  }) },
  { name: "quote-fee-10 previewCache false (same query)", path: QUOTE_FEE_10, run: () => quoteRoute("A", "B", 10n, {
    constraints: { maxAccounts: 24 }, platformFeeBps: 10, maxPriceImpactBps: 500, previewCache: false,
  }) },
  { name: "quote-custom-impact (not a query field)", path: QUOTE_FEE_10, run: () => quoteRoute("A", "B", 10n, {
    constraints: { maxAccounts: 24 }, platformFeeBps: 10, maxPriceImpactBps: 10000,
  }) },
])("quoteRoute Jupiter query matches the pre-refactor snapshot: $name", async ({ path, run }) => {
  const fetcher = installFetch();
  await run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(requestPath(fetcher.mock.calls[0]![0])).toBe(path);
});

it.each([
  { name: "build-minimal (wide 48, previewCache false)", quote: BUILD_MINIMAL_QUOTE, body: SWAP_BODY,
    run: () => buildRoute("wallet", "A", "B", 100n) },
  { name: "build-constraints", quote: BUILD_CONSTRAINTS_QUOTE, body: SWAP_BODY,
    run: () => buildRoute("wallet", "A", "B", 100n, {
      wrapAndUnwrapSol: false,
      constraints: { maxAccounts: 20, onlyDirectRoutes: true, excludeDexes: "OpenBook,Phoenix" },
    }) },
  { name: "build-wrap-true", quote: BUILD_WRAP_QUOTE, body: { ...SWAP_BODY, wrapAndUnwrapSol: true },
    run: () => buildRoute("wallet", "A", "B", 100n, { wrapAndUnwrapSol: true, constraints: { maxAccounts: 24 } }) },
  { name: "build-destination (feeRoute 16, onlyDirect)", quote: BUILD_DEST_QUOTE,
    body: { ...SWAP_BODY, destinationTokenAccount: "DestAta11111111111111111111111111111111111" },
    run: () => buildRoute("wallet", "A", "B", 100n, {
      wrapAndUnwrapSol: false,
      constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.feeRoute, onlyDirectRoutes: true },
      destinationTokenAccount: "DestAta11111111111111111111111111111111111",
    }) },
])("buildRoute Jupiter query and swap-instruction body match the pre-refactor snapshot: $name", async ({ quote, body, run }) => {
  const fetcher = installFetch();
  await run();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(requestPath(fetcher.mock.calls[0]![0])).toBe(quote);
  expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe("/swap/v1/swap-instructions");
  expect(swapBody(fetcher.mock.calls[1]![1] as { body?: string })).toEqual(body);
});
