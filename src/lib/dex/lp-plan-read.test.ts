import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { directUsdcExitPreview } from "@sofinance/engine/exit-preview-support";
import { readLpObservations, readLpExitPreview, dexRegistry } from "./index";
import { POST } from "@/app/api/lp-decision/route";
import type { DecisionRequest } from "@/lib/lp-accounting";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ exit: vi.fn() }));
vi.mock("@sofinance/engine/lp-exit-data", () => ({ readFullExitPreview: backend.exit }));
const POOL = "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72";
const OTHER = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("captures the initiating context before lazy/RPC awaits and retains live cancellation for read-only observations", async () => {
  const command: DecisionRequest = { requestId: "initial", contextVersion: 1, poolId: POOL, amountAtomic: "9007199254740993",
    asset: "USDC", decimals: 6, numeraire: "USDC", targetDate: "2026-12-01", demo: false };
  const controller = new AbortController(), gate = deferred<Response>(), started = deferred<void>();
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (options?.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    if (String(url).startsWith("https://api-v3.raydium.io/")) { started.resolve(); return gate.promise; }
    throw new Error("Unexpected upstream read");
  });
  const pending = readLpObservations("raydium-clmm", command, fetcher, controller.signal);
  command.poolId = OTHER; command.positionId = OTHER; command.amountAtomic = "1"; command.requestId = "changed";
  await started.promise;
  const firstSignal = fetcher.mock.calls[0]?.[1]?.signal;
  expect(firstSignal?.aborted).toBe(false); controller.abort(); expect(firstSignal?.aborted).toBe(true);
  gate.resolve(Response.json({ success: true, data: [{ id: POOL, programId: CLMM_PROGRAM_ID.toBase58(),
    mintA: { address: OTHER, decimals: 9 }, mintB: { address: POOL, decimals: 6 }, price: 2, feeRate: 0.003 }] }));
  const result = await pending;
  expect(result.pool?.id).toBe(POOL); expect(result.position).toBeNull(); expect(result.exitPrincipal).toBeNull();
  expect(result.market).toBeNull(); expect(result.ledger).toEqual([]);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    `https://api-v3.raydium.io/pools/info/ids?ids=${POOL}`,
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${POOL}/ohlcv/day?aggregate=1&limit=100&currency=usd&token=base`,
  ]);
  expect(result.attempts.at(-1)).toMatchObject({ source: "GeckoTerminal OHLCV", status: "error" });
});

it("keeps preview results/errors and optional argument arity intact independently of generic plan admission", async () => {
  const result = directUsdcExitPreview(), controller = new AbortController(), fetcher = vi.fn<typeof fetch>();
  backend.exit.mockResolvedValue(result);
  expect(dexRegistry.isDisabled("raydium-clmm", "plan")).toBe(true);
  expect(await readLpExitPreview("raydium-clmm", POOL, OTHER, false, fetcher, controller.signal)).toBe(result);
  expect(backend.exit).toHaveBeenCalledExactlyOnceWith(POOL, OTHER, false, fetcher, controller.signal);
  backend.exit.mockClear(); await readLpExitPreview("raydium-clmm", POOL);
  expect(backend.exit).toHaveBeenCalledExactlyOnceWith(POOL);
  const failure = new Error("upstream failure"); backend.exit.mockRejectedValueOnce(failure);
  await expect(readLpExitPreview("raydium-clmm", POOL)).rejects.toBe(failure);
});

it("rejects absent bindings before fetching or invoking the preview engine", async () => {
  const fetcher = vi.fn<typeof fetch>(), command: DecisionRequest = { requestId: "test", contextVersion: 1,
    amountAtomic: "1", asset: "USDC", decimals: 6, numeraire: "USDC", targetDate: "2026-12-01", demo: false };
  for (const id of ["unknown", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc"]) {
    await expect(readLpObservations(id, command, fetcher)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(readLpExitPreview(id, POOL, undefined, true, fetcher)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  expect(fetcher).not.toHaveBeenCalled(); expect(backend.exit).not.toHaveBeenCalled();
});

it("keeps the HTTP observation result partial, with no executable quote or probability claim", async () => {
  const fetcher = vi.fn<typeof fetch>(async url => String(url).startsWith("https://api-v3.raydium.io/")
    ? Response.json({ success: true, data: [{ id: POOL, programId: CLMM_PROGRAM_ID.toBase58(),
      mintA: { address: OTHER, decimals: 9 }, mintB: { address: POOL, decimals: 6 }, price: 2, feeRate: 0.003 }] })
    : Response.json({ data: { attributes: { ohlcv_list: [[1, 2, 3, 1, 2, 100]] } } }));
  vi.stubGlobal("fetch", fetcher);
  const response = await POST(new Request("https://example.test/api/lp-decision", { method: "POST", body: JSON.stringify({
    requestId: "observed", contextVersion: 7, poolId: POOL, amountAtomic: "9007199254740993", asset: "USDC", decimals: 6,
    numeraire: "USDC", targetDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), demo: false,
  }) }));
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ requestId: "observed", contextVersion: 7, status: "partial", executable: false,
    probability: null, observations: { pool: { id: POOL }, market: { eventTimeValuation: false }, exitPrincipal: null } });
  expect(body.warnings).toContain("Public observations retrieved. Historical USDC valuation, income attribution and full reconciliation are incomplete. Raw events do not necessarily represent attributable external income.");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});
