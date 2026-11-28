import { describe, expect, it, vi } from "vitest";
import { createRebroadcaster, isAlreadyProcessedSendError, withRelayedResend } from "./cleanup-rebroadcast";

function clock(start = 1_000_000) { let at = start; return { now: () => at, advance: (ms: number) => { at += ms; }, at: () => at }; }

describe("createRebroadcaster", () => {
  it("re-sends the same signature only while Solana has not seen it, one interval after the last send", async () => {
    const time = clock(), send = vi.fn(async () => ({})), r = createRebroadcaster({ intervalMs: 6_000, now: time.now });
    const expiresAt = time.at() + 75_000;
    r.markSent("sig");
    expect(await r.tick({ signature: "sig", onChain: false, expiresAt, send })).toBe("skipped");
    time.advance(4_000);
    expect(await r.tick({ signature: "sig", onChain: false, expiresAt, send })).toBe("skipped");
    time.advance(2_000);
    expect(await r.tick({ signature: "sig", onChain: false, expiresAt, send })).toBe("sent");
    time.advance(5_999);
    expect(await r.tick({ signature: "sig", onChain: false, expiresAt, send })).toBe("skipped");
    time.advance(1);
    expect(await r.tick({ signature: "sig", onChain: false, expiresAt, send })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.attemptsFor("sig")).toBe(2);
  });
  it("never sends when the RPC has seen it or could not answer", async () => {
    const time = clock(), send = vi.fn(async () => ({})), r = createRebroadcaster({ intervalMs: 1, now: time.now });
    time.advance(10);
    expect(await r.tick({ signature: "s", onChain: true, expiresAt: time.at() + 10_000, send })).toBe("skipped");
    expect(await r.tick({ signature: "s", onChain: undefined, expiresAt: time.at() + 10_000, send })).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
  it("stops at the end of the prepared window", async () => {
    const time = clock(), send = vi.fn(async () => ({})), r = createRebroadcaster({ intervalMs: 1, now: time.now });
    const expiresAt = time.at() + 10_000;
    time.advance(9_999);
    expect(await r.tick({ signature: "s", onChain: false, expiresAt, send })).toBe("sent");
    time.advance(1);
    expect(await r.tick({ signature: "s", onChain: false, expiresAt, send })).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("stops after the attempt budget", async () => {
    const time = clock(), send = vi.fn(async () => ({})), r = createRebroadcaster({ intervalMs: 1, maxAttempts: 3, now: time.now });
    for (let index = 0; index < 6; index++) { time.advance(10); await r.tick({ signature: "s", onChain: false, expiresAt: time.at() + 10_000, send }); }
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("does not start a second send while one is in flight, and records a failed re-send without throwing", async () => {
    const time = clock(); let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const r = createRebroadcaster({ intervalMs: 1, now: time.now });
    time.advance(10);
    const first = r.tick({ signature: "s", onChain: false, expiresAt: time.at() + 10_000, send: slow });
    time.advance(10);
    expect(await r.tick({ signature: "s", onChain: false, expiresAt: time.at() + 10_000, send: slow })).toBe("skipped");
    release(); expect(await first).toBe("sent");
    time.advance(10);
    expect(await r.tick({ signature: "s", onChain: false, expiresAt: time.at() + 10_000, send: async () => { throw new Error("rate limited"); } })).toBe("failed");
    expect(r.failures()).toEqual(["rate limited"]);
  });
  it("tracks each signature on its own clock", async () => {
    const time = clock(), send = vi.fn(async () => ({})), r = createRebroadcaster({ intervalMs: 6_000, now: time.now });
    r.markSent("a"); time.advance(3_000); r.markSent("b"); time.advance(3_000);
    expect(await r.tick({ signature: "a", onChain: false, expiresAt: time.at() + 60_000, send })).toBe("sent");
    expect(await r.tick({ signature: "b", onChain: false, expiresAt: time.at() + 60_000, send })).toBe("skipped");
  });
});


describe("isAlreadyProcessedSendError", () => {
  it("recognises a second send of a signature Solana already has", () => {
    expect(isAlreadyProcessedSendError(new Error("This transaction has already been processed"))).toBe(true);
    expect(isAlreadyProcessedSendError(new Error("Transaction was already processed"))).toBe(true);
    expect(isAlreadyProcessedSendError(new Error("rate limited"))).toBe(false);
  });
});

describe("withRelayedResend", () => {
  it("hands the caller a function that sends the same signed bytes again", async () => {
    const send = vi.fn(async (signed: { n: number }, context: { k: string }) => { void context; return `sig-${signed.n}`; });
    let resend: (() => Promise<string>) | undefined;
    const wrapped = withRelayedResend(send, (fn) => { resend = fn; });
    await expect(wrapped({ n: 7 }, { k: "ctx" })).resolves.toBe("sig-7");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(resend!()).resolves.toBe("sig-7");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([{ n: 7 }, { k: "ctx" }]);
  });
});
