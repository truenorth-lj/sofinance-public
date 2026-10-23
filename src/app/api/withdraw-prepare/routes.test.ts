import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ build: vi.fn(), send: vi.fn(), status: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
vi.mock("@sofinance/engine/withdraw/build", () => ({ buildWithdraw: mocks.build }));
vi.mock("@/lib/withdraw/send", () => ({ submitWithdraw: mocks.send }));
vi.mock("@/lib/withdraw/status", () => ({ withdrawStatus: mocks.status }));
import { POST as quote } from "../withdraw-quote/route";
import { POST as prepare } from "./route";
import { POST as broadcast } from "../withdraw-broadcast/route";
import { POST as status } from "../withdraw-status/route";
const request = (body: unknown) => new Request("http://localhost/api/withdraw", { method: "POST", body: JSON.stringify(body) });
describe("withdraw routes", () => {
    beforeEach(() => vi.resetAllMocks());
    it("quotes with preview confirmation bypass and omits executable data", async () => {
        mocks.build.mockResolvedValue({ summary: { warning: true }, permit: "secret", unsignedTransaction: "tx" });
        const result = await quote(request({ percent: 50 }));
        expect(await result.json()).toEqual({ warning: true });
        expect(mocks.build).toHaveBeenCalledWith({ percent: 50 }, true);
        expect(result.headers.get("Cache-Control")).toBe("no-store");
    });
    it("returns the complete prepared authorization", async () => {
        mocks.build.mockResolvedValue({ summary: { stage: "withdraw" }, permit: "permit", unsignedTransaction: "tx" });
        const result = await prepare(request({ percent: 100 }));
        expect(await result.json()).toHaveProperty("permit", "permit");
        expect(mocks.build).toHaveBeenCalledWith({ percent: 100 });
    });
    it("delegates signed broadcast and status verification", async () => {
        mocks.send.mockResolvedValue({ signature: "signature" });
        mocks.status.mockResolvedValue({ status: "pending" });
        expect(await (await broadcast(request({ permit: "permit" }))).json()).toEqual({ signature: "signature" });
        expect(mocks.send).toHaveBeenCalledWith({ permit: "permit" });
        expect(await (await status(request({ signature: "signature" }))).json()).toEqual({ status: "pending" });
    });
    it("fails closed on high impact preparation and invalid signed authorization", async () => {
        mocks.build.mockRejectedValue(new Error("Confirm the high price impact before continuing"));
        mocks.send.mockRejectedValue(new Error("Withdrawal authorization does not match transaction"));
        expect((await prepare(request({}))).ok).toBe(false);
        expect((await broadcast(request({}))).ok).toBe(false);
    });
});
