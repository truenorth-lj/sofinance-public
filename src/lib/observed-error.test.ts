import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dataServiceFailure,
  GATEWAY_PARSE_CODE,
  GATEWAY_TIMEOUT_CODE,
  logObservedError,
} from "./observed-error";
import { publicIssue } from "./refresh-monitoring";
import { RwaStoreError } from "./rwa-store-types";
import { PositionHistoryStoreError } from "./position-history-store-types";
import { StockEntryPriceStoreError } from "./stock-entry-price-store-types";

const password = "super-secret-db-password";
const databaseUrl = `postgres://sofinance_owner:${password}@ep-private.neon.tech/sofinance`;

function postgresError() {
  const error = Object.assign(new Error(`connect failed ${databaseUrl} DATABASE_URL=${databaseUrl}`), { code: "08006" });
  error.name = "PostgresError";
  return error;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("dataServiceFailure", () => {
  it("keeps a real lease loss, and distinguishes abort, parse, and unavailable", () => {
    expect(dataServiceFailure(new RwaStoreError("LEASE_LOST"))).toEqual({ status: 409, code: "LEASE_LOST" });
    expect(dataServiceFailure(new PositionHistoryStoreError("LEASE_LOST"))).toEqual({ status: 409, code: "LEASE_LOST" });
    expect(dataServiceFailure(new StockEntryPriceStoreError("INVALID_REQUEST"))).toEqual({ status: 503, code: "INVALID_REQUEST" });
    expect(dataServiceFailure(new DOMException("aborted", "AbortError"))).toEqual({ status: 503, code: GATEWAY_TIMEOUT_CODE });
    expect(dataServiceFailure(new DOMException("timed out", "TimeoutError"))).toEqual({ status: 503, code: GATEWAY_TIMEOUT_CODE });
    const timedOut = new TypeError("fetch failed");
    timedOut.cause = new DOMException("timed out", "TimeoutError");
    expect(dataServiceFailure(timedOut).code).toBe(GATEWAY_TIMEOUT_CODE);
    expect(dataServiceFailure(new SyntaxError(`Unexpected token ${databaseUrl}`)).code).toBe(GATEWAY_PARSE_CODE);
    expect(dataServiceFailure(postgresError())).toEqual({ status: 503, code: "RWA_STORE_UNAVAILABLE" });
  });
});

describe("logObservedError", () => {
  it("logs name, SQLSTATE, status, and store code, and not the database URL", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = Object.assign(postgresError(), { status: 503 });
    logObservedError("rwa-data-service", upstream, { route: "/v1/rwa", storeCode: "RWA_STORE_UNAVAILABLE", job: "rwa-refresh" });
    logObservedError("rwa-data-service", new SyntaxError(`Unexpected token ${databaseUrl}`), { route: "/v1/rwa", storeCode: GATEWAY_PARSE_CODE });
    const payload = JSON.stringify(logged.mock.calls);
    expect(payload).toContain("PostgresError");
    expect(payload).toContain("08006");
    expect(payload).toContain("503");
    expect(payload).toContain("RWA_STORE_UNAVAILABLE");
    expect(payload).toContain("/v1/rwa");
    expect(payload).toContain("rwa-refresh");
    expect(payload).toContain("SyntaxError");
    expect(payload).toContain(GATEWAY_PARSE_CODE);
    expect(payload).not.toContain(password);
    expect(payload).not.toContain("postgres://");
    expect(payload).not.toContain("DATABASE_URL");
    expect(payload).not.toContain("neon.tech");
    expect(publicIssue(postgresError(), "Refresh failed")).toBe("Refresh failed");
    expect(publicIssue(new RwaStoreError("LEASE_LOST"), "Job lease was lost before completion")).toBe("LEASE_LOST");
  });
});
