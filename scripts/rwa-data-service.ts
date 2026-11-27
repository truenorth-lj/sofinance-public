/** Private-network PostgreSQL gateway; public transport is authenticated HTTPS through Zeabur. */
import { createServer } from "node:http";
import { getRwaConfig, getRwaServiceConfig } from "../src/lib/config/rwa-env";
import { validRwaAuthorization } from "../src/lib/rwa-auth";
import {
  createRwaDatabase,
  PostgresRwaStore,
} from "../src/lib/rwa-postgres-store";
import { storeRequestSchema } from "../src/lib/rwa-store-types";
import { PostgresPositionHistoryStore } from "../src/lib/position-history-postgres-store";
import { positionStoreRequestSchema } from "../src/lib/position-history-store-types";
import { PostgresStockEntryPriceStore } from "../src/lib/stock-entry-price-postgres-store";
import { entryPriceStoreRequestSchema } from "../src/lib/stock-entry-price-store-types";
import { dataServiceFailure, logObservedError } from "../src/lib/observed-error";
import { parseRwaRefreshUrl, triggerRwaRefresh } from "../src/lib/rwa-refresh-trigger";

const config = getRwaConfig(),
  service = getRwaServiceConfig();
if (!config.databaseUrl || !config.secret || config.secret.length < 32)
  throw new Error("RWA service configuration is incomplete");
const refreshSecret: string = config.secret;
const db = createRwaDatabase(config.databaseUrl),
  store = new PostgresRwaStore(db);
const positionStore = new PostgresPositionHistoryStore(db);
const entryPriceStore = new PostgresStockEntryPriceStore(db);
const server = createServer(async (req, res) => {
  const isPositionHistory = req.url === "/v1/position-history";
  const isEntryPrices = req.url === "/v1/entry-prices";
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
  if ((req.url !== "/v1/rwa" && !isPositionHistory && !isEntryPrices) || req.method !== "POST") {
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
      if (bytes > (isPositionHistory ? 16_000_000 : isEntryPrices ? 64_000 : 2_000_000)) {
        reply(413, { code: "BODY_TOO_LARGE" });
        return;
      }
      chunks.push(part);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (isEntryPrices) {
      const request = entryPriceStoreRequestSchema.safeParse(body);
      if (!request.success) {
        reply(400, { code: "INVALID_REQUEST" });
        return;
      }
      reply(200, await entryPriceStore.request(request.data));
      return;
    }
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
    const failure = dataServiceFailure(error);
    const route = isEntryPrices ? "/v1/entry-prices" : isPositionHistory ? "/v1/position-history" : "/v1/rwa";
    // Classification fields only: never the request, Authorization header, or raw database message.
    logObservedError("rwa-data-service", error, { route, storeCode: failure.code });
    reply(failure.status, { code: failure.code });
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
  const url = parseRwaRefreshUrl(service.refreshUrl, { allowRailwayPrivateHttp: false });
  busy = true;
  try {
    const outcome = await triggerRwaRefresh({ url, secret: refreshSecret, method: "POST", timeoutMs: 250_000 });
    if (outcome.status === null) console.error("rwa-scheduler request failed");
    else console.log("rwa-scheduler", JSON.stringify({ status: outcome.status }));
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
