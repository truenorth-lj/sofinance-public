import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "./route";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";

class ImmediateCloseSocket {
  send = vi.fn();
  close = vi.fn();
  private readonly listeners = new Map<string, () => void>();

  addEventListener(type: string, handler: () => void) {
    this.listeners.set(type, handler);
    if (type === "close") {
      queueMicrotask(() => {
        this.listeners.get("open")?.();
        this.listeners.get("close")?.();
      });
    }
  }
}

async function readAll(response: Response) {
  return response.text();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/pool-activity/stream", () => {
  it("returns unavailable when the data key is unset", async () => {
    vi.stubEnv("SOLAMI_DATA_API_KEY", "");
    const response = await GET(new Request(`http://localhost/api/pool-activity/stream?poolId=${POOL}`));
    const body = await readAll(response);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(body).toContain("event: unavailable");
    expect(body).toContain("\"available\":false");
    expect(body).not.toMatch(/api_key|sk_/);
  });

  it("emits unavailable when the upstream socket closes before a connected frame", async () => {
    vi.stubEnv("SOLAMI_DATA_API_KEY", "test-data-key");
    vi.stubGlobal("WebSocket", class extends ImmediateCloseSocket {
      constructor(url: string) {
        super();
        expect(String(url)).toContain("api_key=test-data-key");
      }
    });
    const response = await GET(new Request(`http://localhost/api/pool-activity/stream?poolId=${POOL}`));
    const body = await readAll(response);
    expect(body).toContain("event: unavailable");
    expect(body).toContain("upstream-close");
    expect(body).not.toContain("event: ready");
    expect(body).not.toMatch(/api_key|test-data-key|sk_/);
  });
});
