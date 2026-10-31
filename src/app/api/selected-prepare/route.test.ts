import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/tx-send/permit", () => ({ sendPermitFor: vi.fn(() => "send-permit"), txPermitsFor: vi.fn(() => ({ sendPermit: "send-permit", landedPermit: "landed-permit" })) }));
vi.mock("@sofinance/engine/api-input", () => ({ parseSelectedQuoteRequest: vi.fn() }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: vi.fn() }));
vi.mock("@/lib/selected-permit", () => ({ issueSelectedPermit: vi.fn(() => "permit") }));
import { parseSelectedQuoteRequest } from "@sofinance/engine/api-input";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { POST as prepare } from "./route";
import { POST as preflight } from "../selected-preflight/route";
const selection = { positionMint: "position", inputMint: "mint", inputKind: "token" as const };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseSelectedQuoteRequest).mockResolvedValue({ wallet: "wallet", selection,
    amount: "0.01", floorBps: 9900, toleranceBps: 100 });
  vi.mocked(buildAndSimulateSelectedZap).mockResolvedValue({
    summary: { simulated: true, quote: { passesFloor: false, requested: "10000000", floorBps: 9900 } },
    transaction: { message: { serialize: () => new Uint8Array([1]) }, serialize: () => new Uint8Array([1]) },
  } as unknown as Awaited<ReturnType<typeof buildAndSimulateSelectedZap>>);
});
it.each([["preflight", preflight], ["prepare", prepare]])("%s treats resale cost as informational", async (_, handler) => {
  const response = await handler(new Request("http://localhost/api/selected", { method: "POST" }));
  expect(response.status).toBe(200);
  expect(buildAndSimulateSelectedZap).toHaveBeenCalledWith("wallet", selection, "0.01", 9900, 100,
    expect.objectContaining({ enforceResaleFloor: false, signal: expect.any(AbortSignal) }));
  const body = await response.json(); expect(body.simulated).toBe(true); expect(body.quote.passesFloor).toBe(false);
});

it.each([["preflight", preflight], ["prepare", prepare]])("%s returns typed availability errors and cancels its request", async (_, handler) => {
  vi.mocked(buildAndSimulateSelectedZap).mockRejectedValue(new JupiterHttpError(429, "/swap/v2/build", 30_000));
  const response = await handler(new Request("http://localhost/api/selected", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("30");
  expect(await response.json()).toMatchObject({ code: "jupiter_rate_limited", retryAfterMs: 30_000 });
  const options = vi.mocked(buildAndSimulateSelectedZap).mock.calls[0]?.[5];
  expect(options?.signal?.aborted).toBe(true);
  expect(options?.budget?.retriesLeft).toBe(1);
});
