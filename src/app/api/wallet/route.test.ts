import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ readConnection: vi.fn(), discover: vi.fn(), connection: {} }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcReadConnection: backend.readConnection }));
vi.mock("@sofinance/engine/wallet-discovery", () => ({ discoverWallet: backend.discover }));
const wallet = testKeypair(1).publicKey.toBase58();
const request = (owner = wallet) => new Request(`http://localhost/api/wallet?wallet=${owner}`);
beforeEach(() => {
  vi.resetAllMocks(); backend.readConnection.mockReturnValue(backend.connection);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

it("keeps the complete native discovery DTO, read RPC and no-store headers through the real lazy binding", async () => {
  const result = { wallet, slot: 42, fetchedAt: 12345, positions: [{ positionMint: "position", symbolA: "A" }],
    assets: [{ balance: "9007199254740993" }], extension: "unchanged" };
  backend.discover.mockResolvedValue(result);
  const response = await GET(request());
  expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(backend.readConnection).toHaveBeenCalledOnce();
  expect(backend.discover).toHaveBeenCalledExactlyOnceWith(wallet, backend.connection);
});

it("rejects a malformed wallet before creating a connection or calling discovery", async () => {
  const response = await GET(request("invalid"));
  expect(response.status).toBe(400); expect(backend.readConnection).not.toHaveBeenCalled(); expect(backend.discover).not.toHaveBeenCalled();
});

it("keeps wallet scan failures as HTTP503", async () => {
  backend.discover.mockRejectedValueOnce(new Error("Wallet scan unavailable"));
  const response = await GET(request());
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Wallet scan unavailable" });
});
