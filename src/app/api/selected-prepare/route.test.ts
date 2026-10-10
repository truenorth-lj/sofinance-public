import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-input", () => ({ parseSelectedQuoteRequest: vi.fn() }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: vi.fn() }));
vi.mock("@/lib/selected-permit", () => ({ issueSelectedPermit: vi.fn(() => "permit") }));
import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
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
    { enforceResaleFloor: false });
  const body = await response.json(); expect(body.simulated).toBe(true); expect(body.quote.passesFloor).toBe(false);
});
