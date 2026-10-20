import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/api-input", () => ({ parseSelectedQuoteRequest: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn(() => ({}) ) }));
vi.mock("@/lib/selected-quote", () => ({ searchSelectedQuoteBundle: vi.fn() }));
import { parseSelectedQuoteRequest } from "@sofinance/engine/api-input";
import { searchSelectedQuoteBundle } from "@/lib/selected-quote";
import { SelectedNoRouteError } from "@/lib/selected-no-route";
import { POST as quote } from "./route";

const selection = { positionMint: "position", inputMint: "mint", inputKind: "token" as const };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(parseSelectedQuoteRequest).mockResolvedValue({ wallet: "wallet", selection,
    amount: "0.01", floorBps: 9900, toleranceBps: 100 });
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
