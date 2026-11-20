import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/capture", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sentry/capture")>(),
  captureApiRouteError: vi.fn(),
}));
import { captureApiRouteError } from "@/lib/sentry/capture";
import { runJob } from "./job";
import { RwaStoreError, type RwaStore } from "../rwa-store-types";

const password = "super-secret-db-password";
const databaseUrl = `postgres://sofinance_owner:${password}@ep-private.neon.tech/sofinance`;

function postgresError() {
  const error = Object.assign(new Error(`connect failed ${databaseUrl} DATABASE_URL=${databaseUrl}`), { code: "08006" });
  error.name = "PostgresError";
  return error;
}

function store(finish: () => Promise<unknown> | unknown) {
  return {
    request: vi.fn(async (input: { op: string }) => {
      if (input.op === "claim") return { job: "rwa-apr-refresh", owner: "00000000-0000-4000-8000-000000000001", epoch: 1 };
      if (input.op === "finish") return finish();
      throw new Error("step failed");
    }),
  } as unknown as RwaStore;
}

afterEach(() => { vi.clearAllMocks(); });

describe("refresh finish failures", () => {
  it("records a real lease loss as lease loss", async () => {
    const result = await runJob("rwa-apr-refresh", { store: store(() => { throw new RwaStoreError("LEASE_LOST"); }) });
    expect(result.status).toBe("error");
    expect(result.issues).toContain("Job lease was lost before completion");
    expect(result.issues).not.toContain("Job could not be finished");
    const finishCall = vi.mocked(captureApiRouteError).mock.calls.at(-1);
    expect(finishCall?.[0]).toMatchObject({ name: "Error", code: "LEASE_LOST" });
    expect(finishCall?.[1]).toMatchObject({ job: "rwa-apr-refresh", route: "/api/internal/rwa-refresh", status: 503, fallback: "Job lease was lost before completion" });
  });

  it("does not call a database disconnect a lease loss, and keeps the URL out of issues and monitoring", async () => {
    const failure = postgresError();
    const result = await runJob("rwa-apr-refresh", { store: store(() => { throw failure; }) });
    expect(result.status).toBe("error");
    expect(result.issues).toContain("step failed");
    expect(result.issues).toContain("Job could not be finished");
    expect(result.issues).not.toContain("Job lease was lost before completion");
    const finishCall = vi.mocked(captureApiRouteError).mock.calls.at(-1);
    const captured = finishCall?.[0] as Error & { pgCode?: string };
    expect(captured.name).toBe("PostgresError");
    expect(captured.pgCode).toBe("08006");
    expect(captured.message).toBe("Job could not be finished");
    expect(finishCall?.[1]).toMatchObject({ job: "rwa-apr-refresh", fallback: "Job could not be finished" });
    const payload = JSON.stringify({ issues: result.issues, calls: vi.mocked(captureApiRouteError).mock.calls }, (_key, item) => (
      item instanceof Error ? { ...item, name: item.name, message: item.message, stack: item.stack } : item
    ));
    expect(payload).not.toContain(password);
    expect(payload).not.toContain("postgres://");
    expect(payload).not.toContain("DATABASE_URL");
    expect(payload).not.toContain("neon.tech");
  });

  it("classifies a failed job body without storing the database URL", async () => {
    const failure = postgresError();
    const result = await runJob("rwa-apr-refresh", {
      store: {
        request: vi.fn(async (input: { op: string }) => {
          if (input.op === "claim") return { job: "rwa-apr-refresh", owner: "00000000-0000-4000-8000-000000000001", epoch: 1 };
          if (input.op === "finish") return null;
          throw failure;
        }),
      } as unknown as RwaStore,
    });
    expect(result.issues).toEqual(["Refresh failed"]);
    const captured = vi.mocked(captureApiRouteError).mock.calls[0]?.[0] as Error & { pgCode?: string };
    expect(captured.name).toBe("PostgresError");
    expect(captured.pgCode).toBe("08006");
    expect(captured.message).toBe("Refresh failed");
    expect(vi.mocked(captureApiRouteError).mock.calls[0]?.[1]).toMatchObject({ job: "rwa-apr-refresh", fallback: "Refresh failed" });
    const payload = JSON.stringify({ issues: result.issues, calls: vi.mocked(captureApiRouteError).mock.calls }, (_key, item) => (
      item instanceof Error ? { ...item, name: item.name, message: item.message, stack: item.stack } : item
    ));
    expect(payload).not.toContain(password);
    expect(payload).not.toContain("postgres://");
    expect(payload).not.toContain("DATABASE_URL");
    expect(payload).not.toContain("neon.tech");
  });
});
