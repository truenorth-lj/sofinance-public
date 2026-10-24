// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { COMPOUND_STATE_RPC_RETRY_DELAYS_MS, useCompoundController } from "./use-compound-controller";

let activeWallet: string;
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: activeWallet, connected: true, signTransaction: vi.fn() }) }));

const RPC_MESSAGE = "Solana RPC is temporarily unavailable. Please retry in a moment.";
let controller: ReturnType<typeof useCompoundController>;
let container: HTMLDivElement, root: Root;
let fixture: ReturnType<typeof compoundHistoryFixture>;
let positionMint: string;
let stateReplies: Array<() => Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const rpcUnavailable = () => Response.json({ error: RPC_MESSAGE, code: "rpc_unavailable" }, { status: 503 });
const ok = () => Response.json({ ...fixture.state, wallet: activeWallet, positionMint });
const stateCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/compound-state").length;
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

function Probe() {
  const value = useCompoundController({ wallet: activeWallet, positionMint, externalBlocked: false });
  useLayoutEffect(() => { controller = value; });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  fixture = compoundHistoryFixture(); activeWallet = fixture.wallet; positionMint = testKeypair(81).publicKey.toBase58();
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/compound-state") return (stateReplies.shift() ?? ok)();
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("yield reading retries a rate-limited RPC quietly", () => {
  it("shows the yield, not the RPC error, when a retry succeeds", async () => {
    stateReplies = [rpcUnavailable, rpcUnavailable, ok];
    await act(async () => root.render(createElement(Probe)));
    await advance(1);
    expect(stateCalls()).toBe(1);
    expect(controller.error).toBe("");
    expect(controller.loading).toBe(true);
    await advance(COMPOUND_STATE_RPC_RETRY_DELAYS_MS[0]);
    expect(stateCalls()).toBe(2);
    await advance(COMPOUND_STATE_RPC_RETRY_DELAYS_MS[1]);
    expect(stateCalls()).toBe(3);
    expect(controller.error).toBe("");
    expect(controller.state?.positionMint).toBe(positionMint);
    expect(controller.loading).toBe(false);
  });

  it("shows the RPC error only after every retry is rate-limited", async () => {
    stateReplies = [rpcUnavailable, rpcUnavailable, rpcUnavailable, ok];
    await act(async () => root.render(createElement(Probe)));
    await advance(1);
    await advance(COMPOUND_STATE_RPC_RETRY_DELAYS_MS[0]);
    expect(controller.error).toBe("");
    await advance(COMPOUND_STATE_RPC_RETRY_DELAYS_MS[1]);
    expect(stateCalls()).toBe(3);
    expect(controller.error).toBe(RPC_MESSAGE);
    expect(controller.loading).toBe(false);
  });

  it("does not retry other read failures", async () => {
    stateReplies = [() => Response.json({ error: "Compound boundary tick array does not exist" }, { status: 400 })];
    await act(async () => root.render(createElement(Probe)));
    await advance(1);
    await advance(10_000);
    expect(stateCalls()).toBe(1);
    expect(controller.error).toBe("Compound boundary tick array does not exist");
  });
});
