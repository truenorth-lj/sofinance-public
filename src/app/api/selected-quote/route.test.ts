import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/api-input", () => ({ parseSelectedQuoteRequest: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn(() => ({}) ) }));
vi.mock("@/lib/selected-quote", () => ({ searchSelectedQuoteBundle: vi.fn() }));
import { parseSelectedQuoteRequest } from "@sofinance/engine/api-input";
import { searchSelectedQuoteBundle } from "@/lib/selected-quote";
import { SelectedNoRouteError } from "@/lib/selected-no-route";
import { jupiterRelayActive, jupiterRequest, setJupiterRelayHint } from "@sofinance/engine/jupiter/client";
import { AmountTooSmallError } from "@/lib/selected-amount-error";
import { POST as quote } from "./route";

const selection = { positionMint: "position", inputMint: "mint", inputKind: "token" as const };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchSelectedQuoteBundle).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.mocked(parseSelectedQuoteRequest).mockResolvedValue({ wallet: "wallet", selection,
    amount: "0.01", floorBps: 9900, toleranceBps: 100 });
});

it("returns a coded amount-too-small body without treating it as Jupiter HTTP 400", async () => {
  vi.mocked(searchSelectedQuoteBundle).mockRejectedValue(new AmountTooSmallError());
  const response = await quote(new Request("http://localhost/api/selected-quote", { method: "POST" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Amount too small to swap into this position — try a larger amount",
    code: "amount_too_small",
  });
});

it("returns a coded no-route body without treating it as Jupiter HTTP 400", async () => {
  vi.mocked(searchSelectedQuoteBundle).mockRejectedValue(new SelectedNoRouteError("SPCX", "INTC", "spcx", "intc"));
  const response = await quote(new Request("http://localhost/api/selected-quote", { method: "POST" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "No route from SPCX to INTC within the transaction size limit. Try USDC, SOL, or one of the pool's tokens.",
    code: "jupiter_no_route",
    inputMint: "spcx",
    outputMint: "intc",
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("keeps the deadline budget and cancels outstanding quote work after success", async () => {
  vi.mocked(searchSelectedQuoteBundle).mockResolvedValue({ quote: { requested: "9007199254740993" } } as never);
  const response = await quote(new Request("http://localhost/api/selected-quote", { method: "POST" }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ requested: "9007199254740993" });
  const options = vi.mocked(searchSelectedQuoteBundle).mock.calls[0]![5]!;
  expect(options.signal!.aborted).toBe(true); expect(options.budget!.retriesLeft).toBe(1);
  expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("Server-Timing")).toContain("total;dur=");
});
it.each([499, 504])("keeps HTTP %s for cancellation/deadline across a delayed quote", async status => {
  if (status === 504) vi.useFakeTimers();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(searchSelectedQuoteBundle).mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ quote: { requested: "1" } } as never); started();
  }));
  const controller = new AbortController();
  const pending = quote(new Request("http://localhost/api/selected-quote", { method: "POST", signal: controller.signal }));
  await entered;
  if (status === 499) controller.abort(); else await vi.advanceTimersByTimeAsync(8001);
  const response = await pending;
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: status === 499 ? "Request cancelled" : "Preparation took too long; please retry" });
  release();
});

it("preserves relay AsyncLocalStorage and missing-quote 409 through the native binding", async () => {
  vi.mocked(searchSelectedQuoteBundle).mockImplementationOnce(async () => {
    await Promise.resolve(); expect(jupiterRelayActive()).toBe(true); setJupiterRelayHint("fixture", 9n);
    await jupiterRequest({ path: "/swap/v1/quote", query: { amount: "1" } });
    throw new Error("unreachable");
  });
  const response = await quote(new Request("http://localhost/api/selected-quote", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jupiterRelay: { responses: {}, hints: { fixture: "7" } } }) }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "jupiter_relay_needed", hints: { fixture: "9" }, needs: [expect.any(Object)] });
  expect(jupiterRelayActive()).toBe(false);
});
it("preserves successful relay hints through the native quote binding", async () => {
  vi.mocked(searchSelectedQuoteBundle).mockImplementationOnce(async () => {
    await Promise.resolve(); expect(jupiterRelayActive()).toBe(true); setJupiterRelayHint("fixture", 9n);
    return { quote: { requested: "1" } } as never;
  });
  const response = await quote(new Request("http://localhost/api/selected-quote", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jupiterRelay: { responses: {} } }) }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ requested: "1" });
  expect(JSON.parse(response.headers.get("x-jupiter-relay-hints")!)).toEqual({ fixture: "9" });
});
