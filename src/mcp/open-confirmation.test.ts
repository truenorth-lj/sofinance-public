import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { FinalityStatus } from "@/lib/transaction-finality";
import type { ServerEvent } from "@/lib/analytics/server-capture";
import { captureMcpOpenWhenConfirmed, OPEN_CONFIRM_DEADLINE_MS, OPEN_CONFIRM_MAX_POLLS } from "./open-confirmation";

const event: ServerEvent = { event: "open_position_success", distinctId: "wallet:abc", properties: { source: "mcp" } };
const open = { signature: "5".repeat(88), lastValidBlockHeight: 123, event };

function harness(statuses: (FinalityStatus | Error)[]) {
  let clock = 0;
  const readStatus = vi.fn(async () => {
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const send = vi.fn<(events: ServerEvent[]) => Promise<void>>(async () => {});
  const sleep = vi.fn(async (ms: number) => { clock += ms; });
  return { readStatus, send, sleep, now: () => clock, elapsed: () => clock };
}

describe("captureMcpOpenWhenConfirmed", () => {
  it("sends open_position_success once confirmed, passing lastValidBlockHeight", async () => {
    const deps = harness(["pending", "confirmed"]);
    expect(await captureMcpOpenWhenConfirmed(open, deps)).toBe("confirmed");
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith([event]);
    expect(deps.readStatus).toHaveBeenCalledWith({ signature: open.signature, lastValidBlockHeight: 123 });
    expect(deps.readStatus).toHaveBeenCalledTimes(2);
  });

  it("finalized also counts", async () => {
    const deps = harness(["finalized"]);
    expect(await captureMcpOpenWhenConfirmed(open, deps)).toBe("finalized");
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "expired"] as const)("%s: stops early and sends nothing", async (status) => {
    const deps = harness(["pending", status]);
    expect(await captureMcpOpenWhenConfirmed(open, deps)).toBe(status);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.readStatus).toHaveBeenCalledTimes(2);
  });

  it("never confirmed: gives up within ~30 s and 15 status calls, sends nothing", async () => {
    const deps = harness(["pending"]);
    expect(await captureMcpOpenWhenConfirmed(open, deps)).toBe("timeout");
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.readStatus.mock.calls.length).toBeLessThanOrEqual(OPEN_CONFIRM_MAX_POLLS);
    expect(deps.elapsed()).toBeLessThanOrEqual(OPEN_CONFIRM_DEADLINE_MS);
    expect([OPEN_CONFIRM_DEADLINE_MS, OPEN_CONFIRM_MAX_POLLS]).toEqual([30_000, 15]);
  });

  it("a transient RPC error is retried", async () => {
    const deps = harness([new Error("429"), "confirmed"]);
    expect(await captureMcpOpenWhenConfirmed(open, deps)).toBe("confirmed");
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
});
