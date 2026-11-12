import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { gated, json, NO_STORE, readJson } from "./route";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";

const Schema = z.object({ action: z.literal("prepare"), amount: z.string().regex(/^\d+$/) }).strict();

describe("api route helpers", () => {
  it("NO_STORE is the shared no-store header", () => {
    expect(NO_STORE).toBe(NO_STORE_HEADERS);
    expect(NO_STORE).toEqual({ "Cache-Control": "no-store" });
  });

  it("json sets Cache-Control: no-store, the status, and merged headers", async () => {
    const ok = json({ ok: true });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await ok.json()).toEqual({ ok: true });
    const limited = json({ error: "Too many requests." }, 429, { "Retry-After": "60" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("readJson returns 400 Invalid JSON or Invalid request + issues, and the parsed body when valid", async () => {
    const badJson = await readJson(new Request("https://example.test", { method: "POST", body: "{not json" }), Schema);
    expect(badJson).toBeInstanceOf(Response);
    if (badJson instanceof Response) {
      expect(badJson.status).toBe(400);
      expect(badJson.headers.get("Cache-Control")).toBe("no-store");
      expect(await badJson.json()).toEqual({ error: "Invalid JSON" });
    }

    const invalid = await readJson(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action: "broadcast" }) }), Schema);
    expect(invalid).toBeInstanceOf(Response);
    if (invalid instanceof Response) {
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("Cache-Control")).toBe("no-store");
      const body = await invalid.json() as { error: string; issues: { path: string; message: string }[] };
      expect(body.error).toBe("Invalid request");
      expect(body.issues.some((issue) => issue.path === "action")).toBe(true);
    }

    const parsed = await readJson(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action: "prepare", amount: "1" }) }), Schema);
    expect(parsed).toEqual({ action: "prepare", amount: "1" });
  });

  it("gated 404s without calling the handler when the flag is off, and forwards the request when on", async () => {
    const handler = vi.fn(async () => json({ ok: true }));
    const off = await gated(() => false, handler)(new Request("https://example.test"));
    expect(off.status).toBe(404);
    expect(off.headers.get("Cache-Control")).toBe("no-store");
    expect(await off.json()).toEqual({ error: "Not found" });
    expect(handler).not.toHaveBeenCalled();

    const on = await gated(() => true, handler)(new Request("https://example.test", { method: "POST" }));
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
