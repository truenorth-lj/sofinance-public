import "server-only";
import { Socket } from "node:net";
import postgres from "postgres";
import { rwaConnectionTarget } from "../db/connection";
import type { RwaDatabaseRole } from "../db/target";
import { getRwaConfig } from "./config/rwa-env";

const expectedRoles = new WeakMap<postgres.Sql, RwaDatabaseRole>();
const identities = new WeakMap<postgres.Sql, Promise<void>>();
type PoolState = {
  retired: boolean;
  deadlineMs: number;
  boundIdentity: boolean;
  sockets: Set<Socket>;
  waiters: Set<() => void>;
  closing?: Promise<void>;
};
const pools = new WeakMap<postgres.Sql, PoolState>();

/** One budget for identity, pool queue, statements and COMMIT acknowledgement. */
export function rwaDatabaseDeadlineMs(config = getRwaConfig()) {
  return Math.min(Math.max(10_000, config.connectTimeoutMs + config.queryTimeoutMs), config.jobTimeoutMs - 1000);
}

// postgres-js 3.4.7 supports this documented hook but omits it from Options.
type SocketOptions = postgres.Options<Record<string, postgres.PostgresType>> & { socket: () => Promise<Socket> };

function openSocket(target: URL, state: PoolState, timeoutMs: number): Promise<Socket> {
  if (state.retired) return Promise.reject(new Error("RWA database pool retired"));
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    state.sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(new Error("RWA database connect timeout")), timeoutMs);
    const failed = () => { clearTimeout(timer); reject(new Error("RWA database connection failed")); };
    // Keep an error listener until postgres-js attaches its own after this promise resolves.
    socket.on("error", failed);
    socket.once("close", () => { clearTimeout(timer); state.sockets.delete(socket); failed(); });
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.connect(Number(target.port || 5432), target.hostname);
  });
}

/** Retire synchronously, then end driver queues AND destroy the transport before callers fail. */
function retireRwaDatabase(db: postgres.Sql, state: PoolState) {
  if (state.closing) return state.closing;
  state.retired = true;
  identities.delete(db);
  if (runtime?.db === db) runtime = undefined;
  // end({timeout:0}) fences future driver queries and rejects queued queries, but
  // Connection.terminate() only socket.end()s. Destroy owned TCP sockets as well:
  // do not drain buffered writes or leave a half-open TLS transport running.
  const ending = db.end({ timeout: 0 });
  for (const socket of state.sockets) socket.destroy();
  state.sockets.clear();
  state.closing = ending.catch(() => {}).then(() => {
    for (const fail of state.waiters) fail();
  });
  return state.closing;
}

/** Never retries work. A timeout/disconnect can mean an UNKNOWN committed write. */
export function runRwaDatabaseRequest<T>(db: postgres.Sql, work: () => Promise<T>): Promise<T> {
  const state = pools.get(db);
  if (!state) throw new Error("Unmanaged RWA database pool");
  if (state.retired) return Promise.reject(new Error("RWA database request unavailable; write outcome may be unknown"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); state.waiters.delete(fail); };
    const fail = () => { cleanup(); reject(new Error("RWA database request unavailable; write outcome may be unknown")); };
    state.waiters.add(fail);
    const timer = setTimeout(() => { void retireRwaDatabase(db, state); }, state.deadlineMs);
    // Both outcomes are observed even after expiry. Late continuations use an
    // ended pool, never a replacement pool, and cannot replay business writes.
    void Promise.resolve().then(work).then(
      value => { if (!state.retired) { cleanup(); resolve(value); } },
      error => { if (!state.retired) { cleanup(); reject(error); } },
    );
  });
}

/** Direct sessions only: startup settings cover non-transaction reads as well as writes. PG17+. */
export function createRwaDatabase(url: string, schemaName = "public") {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) throw new Error("Invalid database schema");
  const config = getRwaConfig();
  const target = rwaConnectionTarget(url, config.expectedRole, config.storeMode === "neon" || config.isVercel);
  const state: PoolState = { retired: false, deadlineMs: rwaDatabaseDeadlineMs(config),
    boundIdentity: config.storeMode === "neon", sockets: new Set(), waiters: new Set() };
  const options: SocketOptions = {
    ssl: target.ssl,
    max: config.poolMax, connect_timeout: config.connectTimeoutMs / 1000,
    idle_timeout: 20, max_lifetime: 600, prepare: false,
    connection: { options: `-c search_path=${schemaName} -c statement_timeout=${config.queryTimeoutMs} -c lock_timeout=3000 -c transaction_timeout=8000` },
    onnotice: () => {}, debug: false,
    socket: () => openSocket(new URL(target.url), state, config.connectTimeoutMs),
    onclose: () => { for (const socket of state.sockets) if (socket.destroyed) state.sockets.delete(socket); },
  };
  const db = postgres(target.url, options);
  pools.set(db, state);
  expectedRoles.set(db, config.expectedRole);
  return db;
}

/** Check the SQL identity before business reads/writes. Transient failures may retry next request. */
export async function assertRwaDatabaseIdentity(db: postgres.Sql) {
  // The legacy gateway service owns a fixed pool for its lifetime. Its HTTP
  // client keeps the existing fetch deadline; do not retire that service's pool
  // here. Runtime direct wrappers always bound the whole request themselves.
  if (pools.get(db)?.boundIdentity) return runRwaDatabaseRequest(db, () => checkIdentity(db));
  return checkIdentity(db);
}

async function checkIdentity(db: postgres.Sql) {
  let checked = identities.get(db);
  if (!checked) {
    checked = (async () => {
      const expectedRole = expectedRoles.get(db) ?? getRwaConfig().expectedRole;
      const [target] = await db`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::integer AS version`;
      if (target?.database !== "sofinance" || target.role !== expectedRole || target.version < 170000)
        throw new Error("RWA database identity or PostgreSQL version mismatch");
    })();
    identities.set(db, checked);
  }
  try { await checked; }
  catch { if (identities.get(db) === checked) identities.delete(db); throw new Error("RWA database identity check failed"); }
}

let runtime: { key: string; db: postgres.Sql } | undefined;
/** One pool per process for BOTH stores. Opens, when configured, remains a separate explicit store. */
export function getRwaDatabase() {
  const config = getRwaConfig();
  if (!config.databaseUrl) throw new Error("RWA database is unavailable");
  // Validate on every selection, including cache hits; no gateway/insecure fallback on Neon failure.
  rwaConnectionTarget(config.databaseUrl, config.expectedRole, config.storeMode === "neon" || config.isVercel);
  const key = JSON.stringify([config.databaseUrl, config.storeMode, config.expectedRole, config.isVercel,
    config.poolMax, config.connectTimeoutMs, config.queryTimeoutMs, config.jobTimeoutMs]);
  if (!runtime || runtime.key !== key) {
    const previous = runtime;
    runtime = { key, db: createRwaDatabase(config.databaseUrl) };
    // Config is immutable in deployed functions; close a replaced pool during local config changes.
    if (previous) void retireRwaDatabase(previous.db, pools.get(previous.db)!);
  }
  return runtime.db;
}
