import { custom, type Transport } from "viem";

/** Replays a recorded JSON-RPC capture (see fixtures/README.md). Unknown requests fail loudly so tests stay hermetic. */
export type RpcCapture = {
  code: string | null;
  entries: { key: { method: string; params: unknown }; responses: { v: { result?: unknown; error?: { code?: number; data?: unknown } }; n: number }[] }[];
};

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export class ReplayMissError extends Error {}

export function replayTransport(capture: RpcCapture, misses: string[] = []): Transport {
  const queues = new Map<string, { v: { result?: unknown; error?: { code?: number; data?: unknown } }; n: number }[]>();
  for (const e of capture.entries) queues.set(stableStringify(e.key), e.responses.map(r => ({ ...r })));
  return custom({
    async request({ method, params }) {
      const key = stableStringify({ method, params });
      const queue = queues.get(key);
      if (!queue?.length) { misses.push(method); throw new ReplayMissError(`no recorded response for ${method}`); }
      const head = queue[0]!;
      if (head.n > 1 || queue.length === 1) head.n = Math.max(1, head.n - 1); else queue.shift();
      const v = head.v;
      if (v.error) throw Object.assign(new Error("execution reverted"), { code: v.error.code ?? 3, data: v.error.data });
      return v.result === "$code" ? capture.code : v.result;
    },
  });
}
