import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { POST } from "./route";
const request = (patch = {}) => new Request("http://localhost/api/lp-decision", {method:"POST", body:JSON.stringify({requestId:"test",contextVersion:1,amountAtomic:"1000000000",asset:"USDC",decimals:6,numeraire:"USDC",targetDate:"2026-11-09",demo:false,...patch})});
it("returns structured unavailable in production and never calls transaction endpoints", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09"));
  const response = await POST(request()); const body = await response.json();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body.requestId).toBe("test"); expect(body.status).toBe("unavailable"); expect(body.probability).toBeNull(); expect(body.executable).toBe(false);
  vi.useRealTimers();
});
it("rejects malformed, oversized, unknown fields and invalid inputs", async () => {
  expect((await POST(request({amountAtomic:"-1"}))).status).toBe(400);
  expect((await POST(request({prepare:true}))).status).toBe(400);
  expect((await POST(new Request("http://localhost",{method:"POST",body:"bad"}))).status).toBe(400);
  expect((await POST(new Request("http://localhost",{method:"POST",body:" ".repeat(4097)}))).status).toBe(413);
});
