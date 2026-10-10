import {
  blurSubscribeFilter,
  blurWsUrl,
  encodeSseEvent,
  formatSseComment,
  isBlurConfigured,
  parseBlurLiveEvent,
  rememberBlurEvent,
} from "@/lib/solami-blur";

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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const poolId = parsePoolId(url.searchParams.get("poolId"));

    const unavailable = encodeSseEvent("unavailable", { available: false, poolId });
    if (!isBlurConfigured() || !unavailable) {
      return new Response(unavailable ?? "event: unavailable\ndata: {}\n\n", {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const wsUrl = blurWsUrl(poolId);
    if (!wsUrl) {
      return new Response(unavailable, {
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
        const seen = new Set<string>();
        const timers: {
          heartbeat?: ReturnType<typeof setInterval>;
          hold?: ReturnType<typeof setTimeout>;
        } = {};

        const enqueue = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };

        const send = (event: string, data: unknown) => {
          const chunk = encodeSseEvent(event, data);
          if (chunk) enqueue(chunk);
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
            /* filter is best-effort; query-string type=swap,liquidity&pool= still applies */
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
          const event = parseBlurLiveEvent(parsed, poolId);
          if (!event) return;
          if (!rememberBlurEvent(seen, event.trade)) return;
          send(event.kind, event.trade);
        });

        socket.addEventListener("error", () => {
          send("end", { reason: "upstream-error", poolId });
          cleanup();
        });

        socket.addEventListener("close", () => {
          send("end", { reason: "upstream-close", poolId });
          cleanup();
        });

        timers.heartbeat = setInterval(() => {
          enqueue(formatSseComment("heartbeat"));
          send("ping", { t: Date.now() });
        }, HEARTBEAT_MS);
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
