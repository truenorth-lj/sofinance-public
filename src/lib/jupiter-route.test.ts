import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildRoute, JupiterNoRouteError } from "./jupiter-route";
import { JupiterHttpError, resetJupiterRuntime, setJupiterLogger, setJupiterRetryConfig } from "./jupiter";

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", "test-only");
  setJupiterLogger(() => {}); setJupiterRetryConfig({ maxAttempts: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetJupiterRuntime(); });

it.each([429, 502, 503])("preserves the typed /build upstream error HTTP %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "upstream" }, {
    status, headers: { "Retry-After": "30" },
  })));
  const pending = buildRoute("wallet", "A", "B", 10n);
  await expect(pending).rejects.toBeInstanceOf(JupiterHttpError);
  await expect(pending).rejects.toMatchObject({ status, retryAfterMs: 30_000, path: "/swap/v2/build" });
});

it("keeps genuine no-route distinct", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "no routes found" }, { status: 400 })));
  await expect(buildRoute("wallet", "A", "B", 10n)).rejects.toBeInstanceOf(JupiterNoRouteError);
});

it("does not replace a transport or parent cancellation cause with no-route", async () => {
  const failure = new TypeError("fetch failed");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(buildRoute("wallet", "A", "B", 10n)).rejects.toBe(failure);
  const controller = new AbortController(); const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  await expect(buildRoute("wallet", "A", "B", 10n, false, { maxAccounts: 24 }, controller.signal)).rejects.toBe(reason);
});
