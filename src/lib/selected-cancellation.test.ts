import { afterEach, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
import { rpcConnection, resetRpcRuntime } from "@sofinance/engine/rpc";
import { quoteRoute, buildRoute } from "@sofinance/engine/swap/jupiter";

afterEach(() => { resetRpcRuntime(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("cancels actual RPC, lightweight quote and build fetches with the same request signal", async () => {
  vi.stubEnv("JUPITER_API_KEY", "fake-key-for-abort-test");
  const controller = new AbortController(); const cancelled: string[] = [];
  const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    const kind = String(_url).includes("/build") ? "build" : String(_url).includes("/quote") ? "quote" : "rpc";
    signal?.addEventListener("abort", () => { cancelled.push(kind); reject(signal.reason); }, { once: true });
  }));
  vi.stubGlobal("fetch", fetcher);
  const connection = rpcConnection(undefined, { env: { SOLANA_RPC_URL: "http://127.0.0.1:8899" }, signal: controller.signal, fetch: fetcher });
  const keys = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const work = [
    connection.getMultipleAccountsInfoAndContext(keys, "confirmed"),
    quoteRoute(keys[0]!.toBase58(), keys[1]!.toBase58(), 100n, { maxAccounts: 24 }, controller.signal),
    buildRoute(keys[0]!.toBase58(), keys[0]!.toBase58(), keys[1]!.toBase58(), 100n, false, { maxAccounts: 24 }, controller.signal),
  ];
  // web3.js schedules the underlying fetch on the next microtask.
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  controller.abort(new DOMException("cancelled", "AbortError"));
  const results = await Promise.allSettled(work);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(cancelled.sort()).toEqual(["quote", "quote", "rpc"]);
  expect(fetcher).toHaveBeenCalledTimes(3); // cancellation cannot start provider fallback/retries
});
