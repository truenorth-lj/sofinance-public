import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHistoryRpcFetch, createHistoryRpcConnections, resetHistoryRpcPacingForTests } from "./position-history-rpc";
import { PUBLIC_SOLANA_RPC_URL, resolveProviderPair, resetRpcRuntime } from "@sofinance/engine/rpc";

const env = { SOLANA_RPC_URL: "https://history-test.example/rpc/private-key" };
const signature = "a".repeat(64);
function request(method = "getSignaturesForAddress", sig = signature): RequestInit {
  return { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: [sig, { encoding: "jsonParsed" }] }) };
}
function receipt(sig = signature) {
  return { slot: 10, blockTime: 1000, version: 0, meta: { err: null, fee: 1, preBalances: [], postBalances: [],
    logMessages: ["Program log: ready"], innerInstructions: [] }, transaction: { signatures: [sig],
    message: { accountKeys: [], instructions: [], recentBlockhash: "1".repeat(32) } } };
}
const response = (result: unknown = []) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }));
const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); resetRpcRuntime(); });
afterEach(async () => {
  await Promise.resolve(); await Promise.resolve();
  vi.useRealTimers(); resetHistoryRpcPacingForTests(); resetRpcRuntime();
});

describe("history-only paced physical RPC transport", () => {
  it("paces FIFO starts across two views sharing one endpoint and records observer-local work", async () => {
    const starts: { at: number; id: string }[] = [];
    const fetcher: typeof fetch = vi.fn(async (_input, init) => {
      starts.push({ at: Date.now(), id: JSON.parse(init!.body as string).id }); return response();
    });
    const a = createHistoryRpcFetch(new AbortController().signal, env, { fetch: fetcher });
    const b = createHistoryRpcFetch(new AbortController().signal, env, { fetch: fetcher });
    const calls = [a.fetch(env.SOLANA_RPC_URL, request()), b.fetch(env.SOLANA_RPC_URL, { ...request(),
      body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "getSignaturesForAddress", params: [] }) }), a.fetch(env.SOLANA_RPC_URL, request())];
    await tick(); expect(starts).toHaveLength(1);
    await tick(124); expect(starts).toHaveLength(1);
    await tick(1); expect(starts.map(item => item.id)).toEqual(["1", "2"]);
    await tick(125); await Promise.all(calls);
    expect(starts.map(item => item.at)).toEqual([0, 125, 250]);
    expect(a.observer.snapshot()).toMatchObject({ attemptCount: 2, primaryAttempts: 0, defaultAttempts: 2, queuedMs: 250 });
    expect(b.observer.snapshot()).toMatchObject({ attemptCount: 1, queuedMs: 125 });
    const changed = a.observer.snapshot(); changed.attemptCount = 99;
    expect(a.observer.snapshot().attemptCount).toBe(2);
  });

  it("uses four starts per second for known public Solana and leaves non-history fetches alone", async () => {
    const starts: number[] = [], fetcher: typeof fetch = vi.fn(async () => { starts.push(Date.now()); return response(); });
    const transport = createHistoryRpcFetch(new AbortController().signal, {}, { fetch: fetcher });
    const first = transport.fetch(PUBLIC_SOLANA_RPC_URL, request()), second = transport.fetch(PUBLIC_SOLANA_RPC_URL, request());
    await tick(250); await Promise.all([first, second]);
    expect(starts).toEqual([0, 250]);
    await transport.fetch(PUBLIC_SOLANA_RPC_URL, request("sendTransaction"));
    await transport.fetch(PUBLIC_SOLANA_RPC_URL, request("getAccountInfo"));
    expect(starts).toEqual([0, 250, 250, 250]);
    expect(transport.observer.snapshot().attemptCount).toBe(2);
  });

  it("shares Retry-After cooldown across views, including HTTP-date and missing-header defaults", async () => {
    const starts: number[] = [];
    const fetcher: typeof fetch = vi.fn(async () => {
      starts.push(Date.now());
      return starts.length === 1 ? new Response("limited", { status: 429, headers: { "Retry-After": "2" } }) : response();
    });
    const a = createHistoryRpcFetch(new AbortController().signal, env, { fetch: fetcher });
    const b = createHistoryRpcFetch(new AbortController().signal, env, { fetch: fetcher });
    const first = a.fetch(env.SOLANA_RPC_URL, request()); await tick(); await first;
    const second = b.fetch(env.SOLANA_RPC_URL, request());
    await tick(1999); expect(starts).toEqual([0]);
    await tick(1); await second; expect(starts).toEqual([0, 2000]);
    expect(a.observer.snapshot().rateLimitCount).toBe(1); expect(b.observer.snapshot().rateLimitCount).toBe(0);
    await tick(125);
    const dateFetch: typeof fetch = vi.fn(async () => new Response("limited", { status: 429,
      headers: { "Retry-After": new Date(Date.now() + 3000).toUTCString() } }));
    await createHistoryRpcFetch(new AbortController().signal, env, { fetch: dateFetch }).fetch(env.SOLANA_RPC_URL, request());
    const dateCall = b.fetch(env.SOLANA_RPC_URL, request());
    await tick(2875); await dateCall; expect(starts.at(-1)).toBe(5000);
    await tick(125);
    await createHistoryRpcFetch(new AbortController().signal, env, { fetch: async () => new Response("limited", { status: 429 }) }).fetch(env.SOLANA_RPC_URL, request());
    const defaultCall = b.fetch(env.SOLANA_RPC_URL, request());
    await tick(999); expect(starts.at(-1)).toBe(5000);
    await tick(1); await defaultCall; expect(starts.at(-1)).toBe(6125);
  });

  it("removes an aborted queued request immediately without consuming a slot or leaving a timer", async () => {
    const fetcher: typeof fetch = vi.fn(async () => response());
    const first = createHistoryRpcFetch(new AbortController().signal, env, { fetch: fetcher }).fetch(env.SOLANA_RPC_URL, request());
    await tick(); await first;
    const controller = new AbortController(), queued = createHistoryRpcFetch(controller.signal, env, { fetch: fetcher });
    const pending = queued.fetch(env.SOLANA_RPC_URL, request());
    const rejected = expect(pending).rejects.toThrow("left");
    controller.abort(new Error("left")); await rejected;
    expect(queued.observer.snapshot().attemptCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await tick(2000); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("holds all eight active slots through body consumption and promptly releases aborted bodies", async () => {
    const bodies: { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] = [];
    const fetcher: typeof fetch = vi.fn(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodies.push({ controller, signal: init!.signal! }); },
    })));
    const controllers = Array.from({ length: 9 }, () => new AbortController());
    const views = controllers.map(controller => createHistoryRpcFetch(controller.signal, env, { fetch: fetcher }));
    const promises = views.map(view => view.fetch(env.SOLANA_RPC_URL, request()));
    const rejected = expect(promises[0]).rejects.toThrow("left");
    await tick(2000); expect(fetcher).toHaveBeenCalledTimes(8);
    controllers[0]!.abort(new Error("left")); await rejected; await tick();
    expect(fetcher).toHaveBeenCalledTimes(9);
    for (const body of bodies.slice(1)) { body.controller.enqueue(new TextEncoder().encode("{}")); body.controller.close(); }
    await Promise.all(promises.slice(1));
    expect(views.reduce((sum, view) => sum + view.observer.snapshot().attemptCount, 0)).toBe(9);
  });

  it("reserves batch weight and prevents queued singles from leapfrogging a full batch", async () => {
    const starts: number[] = [], pending: (() => void)[] = [];
    const fetcher: typeof fetch = vi.fn(async () => {
      starts.push(Date.now()); return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        pending.push(() => { controller.enqueue(new TextEncoder().encode("[]")); controller.close(); });
      } }));
    });
    const transport = createHistoryRpcFetch(new AbortController().signal, env, { fetch: fetcher });
    const batch = (count: number) => ({ ...request(), body: JSON.stringify(Array.from({ length: count }, (_, i) => ({
      jsonrpc: "2.0", id: i, method: "getTransaction", params: [signature] }))) });
    const a = transport.fetch(env.SOLANA_RPC_URL, batch(4)), b = transport.fetch(env.SOLANA_RPC_URL, batch(8));
    const c = transport.fetch(env.SOLANA_RPC_URL, request());
    await tick(1000); expect(starts).toEqual([0]);
    pending[0]!(); await a; await tick(); expect(starts).toEqual([0, 1000]);
    await tick(1000); expect(starts).toEqual([0, 1000]);
    pending[1]!(); await b; await tick(); expect(starts).toEqual([0, 1000, 2000]);
    pending[2]!(); await c;
    expect(transport.observer.snapshot()).toMatchObject({ attemptCount: 3, maxActive: 1 });
  });

  it("paces every actual retry and labels successful internal fallback receipts by their leaf provider", async () => {
    const fallbackEnv = { SOLAMI_API_KEY: "secret-solami-key", SOLANA_RPC_URL: "https://fallback.example/private-token" };
    const starts: number[] = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      starts.push(Date.now());
      const body = JSON.parse(init!.body as string);
      if (String(input).includes("solami")) return new Response("limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: receipt(body.params[0]) }));
    });
    const connections = createHistoryRpcConnections(new AbortController().signal, fallbackEnv,
      { fetch: fetcher, retry: { maxAttempts: 2, baseMs: 0, budgetMs: 5000 } });
    const lookup = connections.connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    await tick(3000); const tx = await lookup;
    expect(tx!.transaction.signatures[0]).toBe(signature);
    expect(starts).toEqual([0, 1000, 1000]);
    expect(connections.observer.snapshot()).toMatchObject({ attemptCount: 3, rateLimitCount: 2,
      primaryAttempts: 2, defaultAttempts: 1 });
    expect(connections.observer.receiptProvider(signature)).toBe("default");
    expect(connections.observer.receiptProvider("unknown")).toBeUndefined();
    const output = JSON.stringify(connections.observer.snapshot());
    expect(output).not.toMatch(/secret-solami-key|private-token|http/);
  });

  it("tracks primary receipt attribution, precise decoded body bytes/time and body-size guard", async () => {
    const configured = { SOLAMI_API_KEY: "secret" }, pair = resolveProviderPair(configured);
    const value = JSON.stringify({ jsonrpc: "2.0", id: "1", result: receipt() });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const transport = createHistoryRpcFetch(new AbortController().signal, configured, { fetch: async () =>
      new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })) });
    const pending = transport.fetch(pair.primary.endpoint, request("getTransaction"));
    await tick(30); stream.enqueue(new TextEncoder().encode(value)); stream.close(); await pending;
    expect(transport.observer.snapshot()).toMatchObject({ responseBytes: Buffer.byteLength(value), requestMs: 30, primaryAttempts: 1 });
    expect(transport.observer.receiptProvider(signature)).toBe("solami");
    await tick(125);
    const oversized = createHistoryRpcFetch(new AbortController().signal, configured, { fetch: async () =>
      new Response(new Uint8Array(16 * 1024 * 1024 + 1)) });
    await expect(oversized.fetch(pair.primary.endpoint, request())).rejects.toThrow("temporarily unavailable");
  });

  it("does not expose invalid receipt attribution, handles bodyless status and cannot reset a cooldown", async () => {
    const transport = createHistoryRpcFetch(new AbortController().signal, env, { fetch: async () => response({ ...receipt(),
      transaction: { ...receipt().transaction, signatures: ["b".repeat(64)] } }) });
    await transport.fetch(env.SOLANA_RPC_URL, request("getTransaction"));
    expect(transport.observer.receiptProvider(signature)).toBeUndefined();
    expect(() => resetHistoryRpcPacingForTests()).toThrow("temporarily unavailable");
    await tick(125);
    const bodyless = createHistoryRpcFetch(new AbortController().signal, env, { fetch: async () => new Response(null, { status: 204 }) });
    expect((await bodyless.fetch(env.SOLANA_RPC_URL, request())).status).toBe(204);
  });
});
