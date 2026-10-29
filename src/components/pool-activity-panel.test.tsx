// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolActivityPanel } from "./pool-activity-panel";
import { renderToStaticMarkup } from "react-dom/server";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";

type Handler = (event: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Handler[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data: JSON.stringify(data) });
    }
  }
}

beforeEach(() => {
  // POOL_ACTIVITY_ENABLED is on for preview/development builds only.
  vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "preview");
});

afterEach(() => {
  vi.unstubAllEnvs();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PoolActivityPanel", () => {
  it("renders nothing until a pool id is provided", () => {
    const markup = renderToStaticMarkup(createElement(PoolActivityPanel, {}));
    expect(markup).toBe("");
  });

  it.each(["production", ""])("renders nothing and never fetches or streams when POOL_ACTIVITY_ENABLED is off (deploy env %j)", async (deployEnv) => {
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", deployEnv);
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async () => Response.json({ available: true }));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PoolActivityPanel, { poolId: POOL }));
      });
      expect(container.textContent).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(FakeEventSource.instances).toHaveLength(0);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it("hides the section when the snapshot is unavailable", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      available: false,
      poolId: POOL,
      pool: null,
      trades: [],
      fetchedAt: "2026-10-20T00:00:00.000Z",
      source: "unavailable",
    })));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PoolActivityPanel, { poolId: POOL }));
      });
      expect(container.textContent).toBe("");
      expect(FakeEventSource.instances).toHaveLength(0);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it("hides the live ticker when the stream is unavailable and does not reconnect", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      available: true,
      poolId: POOL,
      pool: {
        pool: POOL,
        dex: "raydium_clmm",
        mint: "MintA",
        quoteMint: "MintB",
        name: "SPCXx / SPCX",
        symbol: "SPCXx/SPCX",
        price: 1.0025,
        priceUsd: 1,
        tvlUsd: 50_000,
        fees24hUsd: 12.5,
        liquidityUsd: 50_000,
      },
      trades: [],
      fetchedAt: "2026-10-20T00:00:00.000Z",
      source: "solami-blur",
    })));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PoolActivityPanel, { poolId: POOL }));
      });
      expect(container.textContent).toContain("Live pool activity");
      expect(container.textContent).toContain("Snapshot · Blur");
      expect(container.textContent).not.toContain("Live · Blur");
      expect(FakeEventSource.instances).toHaveLength(1);
      await act(async () => {
        FakeEventSource.instances[0]!.emit("unavailable", { available: false, reason: "upstream-close" });
      });
      expect(container.textContent).not.toContain("Live · Blur");
      expect(container.textContent).not.toContain("No recent swaps");
      expect(container.querySelector("[aria-label='Recent swaps']")).toBeNull();
      expect(FakeEventSource.instances).toHaveLength(1);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
