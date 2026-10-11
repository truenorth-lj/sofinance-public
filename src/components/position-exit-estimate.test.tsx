// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionExitEstimate } from "./position-exit-estimate";

const POSITION = "DemoPosition1111111111111111111111111111111";
const ACCOUNT_A = "22222222222222222222222222222222";
const ACCOUNT_B = "33333333333333333333333333333333";
let root: Root;
let node: HTMLDivElement;

const buttons = () => [...node.querySelectorAll("button")];
const click = (text: string) => {
  const button = buttons().find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`no button "${text}"`);
  button.click();
};
const vector = (usdcAtomic = "1000000") => ({
  status: "verified-preview", executable: false, sent: false, recoveryUSDCAtomic: usdcAtomic, recoverySOLLamports: "8580200",
  networkAndPriorityLamports: "5000", observedAt: new Date(Date.now()).toISOString(), localExpiresAt: new Date(Date.now() + 15000).toISOString(), bytes: 1123,
});
const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const render = (props: Partial<Parameters<typeof PositionExitEstimate>[0]> = {}) =>
  act(async () => root.render(createElement(PositionExitEstimate, { positionId: POSITION, ...props })));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("manual preview", () => {
  it("shows actual vector, included costs and SOL risk, suppresses duplicate clicks and expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => { click("Preview exit"); click("Preview exit"); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(node.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    expect(node.textContent).toContain("Network and priority fee 5000 lamports");
    expect(node.textContent).toContain("SOL keeps its price exposure");
    expect(node.textContent).toContain("cannot be signed or sent");
    await flush(16000);
    expect(node.textContent).toContain("Exit estimate expired");
  });

  it("explains when a combined exit exceeds the 1232-byte packet limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "unavailable", reason: "Full atomic exit exceeds 1232 bytes: 1480", bytes: 1480,
      executable: false, sent: false, received: [{ mint: "So11111111111111111111111111111111111111112", amountAtomic: "1000" }] })));
    await act(async () => click("Preview exit"));
    expect(node.textContent).toContain("cannot fit in one Solana transaction");
    expect(node.textContent).toContain("1480");
    expect(node.textContent).toContain("separate vectors");
  });

  it("shows a distinct Jupiter quote outage instead of a Solana RPC failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "unavailable",
      error: "Jupiter swap quotes are temporarily unavailable. Please retry in a moment.", errorCode: "jupiter_unavailable", executable: false, sent: false }, { status: 503 })));
    await act(async () => click("Preview exit"));
    expect(node.textContent).toContain("Jupiter quotes unavailable");
    expect(node.textContent).toContain("Jupiter swap quotes are temporarily unavailable");
    expect(node.textContent).not.toContain("Solana RPC");
  });

  it("cancels transports ignoring abort, clears the stale result and permits retry", async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn((...args: [string, RequestInit]) => { void args; return new Promise<Response>((r) => { resolve = r; }); });
    vi.stubGlobal("fetch", fetcher);
    await act(async () => click("Preview exit"));
    await act(async () => click("Cancel"));
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => resolve(Response.json(vector())));
    expect(node.textContent).not.toContain("1.000000 USDC");
    fetcher.mockResolvedValueOnce(Response.json({ error: "RPC 429" }, { status: 503 }));
    await act(async () => click("Preview exit"));
    expect(node.textContent).toContain("RPC 429");
  });

  it("aborts the in-flight request on unmount", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => click("Preview exit"));
    await act(async () => root.render(null));
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });

  it("ends a stalled exit request and allows retry even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; })).mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => click("Preview exit"));
    await flush(45000);
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Exit estimate timed out");
    expect(node.textContent).not.toContain("Simulating exit…");
    expect(fetcher.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    await act(async () => click("Preview exit"));
    expect(node.textContent).toContain("1.000000 USDC");
    await act(async () => resolveFirst(Response.json(vector("999000000"))));
    expect(node.textContent).not.toContain("999.000000 USDC");
  });

  it("uses a known NFT token account for the preview without rediscovering the owner", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await render({ nftAccount: ACCOUNT_A });
    await act(async () => click("Preview exit"));
    expect(new URL(fetcher.mock.calls[0]?.[0], "http://localhost").searchParams.get("nftAccount")).toBe(ACCOUNT_A);
    expect(node.textContent).toContain("1.000000 USDC");
  });

  it("omits nftAccount when none is known so the server looks the holder up", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => click("Preview exit"));
    expect(new URL(fetcher.mock.calls[0]?.[0], "http://localhost").searchParams.has("nftAccount")).toBe(false);
  });
});

describe("automatic estimate", () => {
  const auto = (props: Partial<Parameters<typeof PositionExitEstimate>[0]> = {}) => render({ autoExit: true, ...props });

  it("waits for the account, then calculates once and offers recalculation after expiry", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await auto({ nftAccountPending: true });
    await flush(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(node.textContent).toContain("Waiting for position accounts…");
    await auto({ nftAccount: ACCOUNT_A });
    await flush(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(node.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    expect(node.textContent).not.toContain("Preview exit: USDC + SOL");
    await flush(16000);
    expect(node.textContent).toContain("Recalculate estimate");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never spins when no account will arrive: explains why and offers the manual preview", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await auto({ nftAccountPending: false });
    await flush(60000);
    expect(node.textContent).not.toContain("Waiting for position accounts…");
    expect(node.textContent).toContain("Connect that wallet, or preview this position manually");
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => click("Preview exit: USDC + SOL"));
    expect(new URL(fetcher.mock.calls[0]?.[0], "http://localhost").searchParams.has("nftAccount")).toBe(false);
    expect(node.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
  });

  it("stops waiting after a bounded time even if the parent keeps saying pending", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(vector())));
    await auto({ nftAccountPending: true });
    await flush(14000);
    expect(node.textContent).toContain("Waiting for position accounts…");
    expect(buttons().some((b) => b.textContent?.includes("Preview exit"))).toBe(false);
    await flush(2000);
    expect(node.textContent).not.toContain("Waiting for position accounts…");
    expect(buttons().some((b) => b.textContent?.includes("Preview exit: USDC + SOL"))).toBe(true);
  });

  it("still calculates automatically if the account arrives after the wait gave up", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal("fetch", fetcher);
    await auto({ nftAccountPending: true });
    await flush(16000);
    await auto({ nftAccount: ACCOUNT_B, nftAccountPending: false });
    await flush(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new URL(fetcher.mock.calls[0]?.[0], "http://localhost").searchParams.get("nftAccount")).toBe(ACCOUNT_B);
  });
});
