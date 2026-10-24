/** Private-network PostgreSQL gateway; public transport is authenticated HTTPS through Zeabur. */
import { createServer } from "node:http";
import { getRwaConfig, getRwaServiceConfig } from "../src/lib/config/rwa-env";
import { validRwaAuthorization } from "../src/lib/rwa-auth";
import {
  createRwaDatabase,
  PostgresRwaStore,
} from "../src/lib/rwa-postgres-store";
import { RwaStoreError, storeRequestSchema } from "../src/lib/rwa-store-types";
import { PostgresPositionHistoryStore } from "../src/lib/position-history-postgres-store";
import { PositionHistoryStoreError, positionStoreRequestSchema } from "../src/lib/position-history-store-types";

const config = getRwaConfig(),
  service = getRwaServiceConfig();
if (!config.databaseUrl || !config.secret || config.secret.length < 32)
  throw new Error("RWA service configuration is incomplete");
const db = createRwaDatabase(config.databaseUrl),
  store = new PostgresRwaStore(db);
const positionStore = new PostgresPositionHistoryStore(db);
const server = createServer(async (req, res) => {
  const isPositionHistory = req.url === "/v1/position-history";
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  const reply = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    if (isPositionHistory && Buffer.byteLength(payload) > 4_000_000) {
      res.statusCode = 503;
      res.end(JSON.stringify({ code: "POSITION_HISTORY_RESPONSE_TOO_LARGE" }));
      return;
    }
    res.statusCode = status;
    res.end(payload);
  };
  if (req.url === "/health" && req.method === "GET") {
    try {
      await db`SELECT 1`;
      reply(200, { status: "ok" });
    } catch {
      reply(503, { status: "unavailable" });
    }
    return;
  }
  if ((req.url !== "/v1/rwa" && !isPositionHistory) || req.method !== "POST") {
    reply(404, { code: "NOT_FOUND" });
    return;
  }
  if (!validRwaAuthorization(req.headers.authorization, config.secret)) {
    reply(401, { code: "UNAUTHORIZED" });
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const part = Buffer.from(chunk);
      bytes += part.length;
      if (bytes > (isPositionHistory ? 16_000_000 : 2_000_000)) {
        reply(413, { code: "BODY_TOO_LARGE" });
        return;
      }
      chunks.push(part);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    const parsed = isPositionHistory ? positionStoreRequestSchema.safeParse(body) : storeRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply(400, { code: "INVALID_REQUEST" });
      return;
    }
    const result = isPositionHistory
      ? await positionStore.request(positionStoreRequestSchema.parse(parsed.data))
      : await store.request(storeRequestSchema.parse(parsed.data));
    reply(200, result);
  } catch (error) {
    const code =
      error instanceof RwaStoreError || error instanceof PositionHistoryStoreError ? error.code : "RWA_STORE_UNAVAILABLE";
    // Only stable codes: never log the request, Authorization header, URL or database error detail.
    console.error("rwa-data-service", code);
    reply(code === "LEASE_LOST" ? 409 : 503, { code });
  }
});
server.requestTimeout = 15_000;
server.listen(service.port, "0.0.0.0", () =>
  console.log("rwa-data-service ready"),
);

let stopping = false,
  busy = false;
async function tick() {
  if (stopping || busy || !service.schedulerEnabled || !service.refreshUrl)
    return;
  const url = new URL(service.refreshUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Scheduler requires HTTPS");
  busy = true;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(250_000),
    });
    console.log("rwa-scheduler", JSON.stringify({ status: response.status }));
  } catch {
    console.error("rwa-scheduler request failed");
  } finally {
    busy = false;
  }
}
// Probe on wall-clock boundaries of the scheduler interval (default 15 minutes,
// SOFINANCE_RWA_SCHEDULER_INTERVAL_MS overrides). Every probe is a billed Vercel
// function call; the DB still gates each job by its own cadence (the job's
// nextDueAt is lastStartedAt + cadence, so a 15-minute probe never skips a
// 5/15-minute job that is due).
const intervalMs = service.schedulerIntervalMs;
let timer: ReturnType<typeof setTimeout>;
function schedule() {
  if (stopping) return;
  timer = setTimeout(
    () => {
      void tick().finally(schedule);
    },
    intervalMs - (Date.now() % intervalMs),
  );
}
schedule();
void tick();
async function stop() {
  stopping = true;
  clearTimeout(timer);
  server.close();
  await db.end({ timeout: 5 });
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
