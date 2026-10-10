import { blurSubscribeFilter, blurWsUrl, eventMatchesPool, isBlurConfigured, parseBlurTrade } from "@/lib/solami-blur";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Hobby-safe default. Raise this on Pro and the stream holds longer;
 * the client EventSource reconnects when we close.
 */
export const maxDuration = 10;

const HOLD_MS = 8_000;
const HEARTBEAT_MS = 3_000;

function parsePoolId(raw: string | null) {
  if (!raw) throw new Error("poolId is required");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error("Invalid poolId");
  return raw;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const poolId = parsePoolId(url.searchParams.get("poolId"));

    if (!isBlurConfigured()) {
      return new Response(sse("unavailable", { available: false, poolId }), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const wsUrl = blurWsUrl(poolId);
    if (!wsUrl) {
      return new Response(sse("unavailable", { available: false, poolId }), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let socket: WebSocket | undefined;
        const timers: {
          heartbeat?: ReturnType<typeof setInterval>;
          hold?: ReturnType<typeof setTimeout>;
        } = {};

        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(sse(event, data)));
          } catch {
            cleanup();
          }
        };

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (timers.heartbeat) clearInterval(timers.heartbeat);
          if (timers.hold) clearTimeout(timers.hold);
          try {
            socket?.close();
          } catch {
            /* ignore */
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        request.signal.addEventListener("abort", cleanup);

        try {
          socket = new WebSocket(wsUrl);
        } catch {
          send("unavailable", { available: false, poolId, reason: "websocket-unavailable" });
          cleanup();
          return;
        }

        socket.addEventListener("open", () => {
          try {
            socket?.send(JSON.stringify(blurSubscribeFilter(poolId)));
          } catch {
            /* filter is best-effort; query-string type=swap,liquidity&address= still applies */
          }
          send("ready", { poolId, types: ["swap", "liquidity"] });
        });

        socket.addEventListener("message", (message) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(message.data));
          } catch {
            return;
          }
          if (!eventMatchesPool(parsed, poolId)) return;
          const record = parsed as { type?: string };
          const type = typeof record.type === "string" ? record.type : "swap";
          if (type === "liquidity") {
            send("liquidity", parsed);
            return;
          }
          const trade = parseBlurTrade(parsed);
          if (trade) send("swap", trade);
        });

        socket.addEventListener("error", () => {
          send("end", { reason: "upstream-error", poolId });
          cleanup();
        });

        socket.addEventListener("close", () => {
          send("end", { reason: "upstream-close", poolId });
          cleanup();
        });

        timers.heartbeat = setInterval(() => send("ping", { t: Date.now() }), HEARTBEAT_MS);
        timers.hold = setTimeout(() => {
          send("end", { reason: "maxDuration", poolId });
          cleanup();
        }, HOLD_MS);
      },
      cancel() {
        /* start() cleanup handles abort */
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pool activity stream failed";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
