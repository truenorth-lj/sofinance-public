/** Offline protocol peer: real postgres-js 3.4.7, real Drizzle and both store wrappers.
 * No listener, DNS, TCP, SQL server, .env file or production credential is used. */
import { EventEmitter } from "node:events";
import tls from "node:tls";
import dns from "node:dns";
import net from "node:net";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";

vi.mock("server-only", () => ({}));
const transport = vi.hoisted(() => ({ makeSocket: (): unknown => { throw new Error("Peer not installed"); } }));
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, Socket: function () { return transport.makeSocket(); } };
});
import { assertRwaDatabaseIdentity, getRwaDatabase, runRwaDatabaseRequest, rwaDatabaseDeadlineMs } from "./rwa-database";
import { getRwaStore } from "./rwa-store";
import { getPositionHistoryStore } from "./position-history-store";

type Mode = "identity" | "business" | "transaction" | "commit" | "healthy" | "connect" | "startup";
const frame = (tag: string, body = Buffer.alloc(0)) => {
  const bytes = Buffer.alloc(body.length + 5);
  bytes[0] = tag.charCodeAt(0); bytes.writeInt32BE(body.length + 4, 1); body.copy(bytes, 5);
  return bytes;
};
const ready = frame("Z", Buffer.from("I"));
function description(identity: boolean) {
  const columns = identity ? ["database", "role", "version"] : [];
  const count = Buffer.alloc(2); count.writeUInt16BE(columns.length);
  return frame("T", Buffer.concat([count, ...columns.map((name, index) => {
    const metadata = Buffer.alloc(18); metadata.writeUInt32BE(index === 2 ? 23 : 25, 6);
    return Buffer.concat([Buffer.from(name + "\0"), metadata]);
  })]));
}
function identityRow() {
  const count = Buffer.from([0, 3]);
  return frame("D", Buffer.concat([count, ...["sofinance", "sofinance", "180000"].map(value => {
    const length = Buffer.alloc(4); length.writeInt32BE(value.length);
    return Buffer.concat([length, Buffer.from(value)]);
  })]));
}
class Wire extends EventEmitter {
  readyState = "open";
  destroyed = false;
  startup = true;
  statement = "";
  inTransaction = false;
  peer?: Wire;
  parent?: Wire;
  commands: string[] = [];
  constructor(public mode: Mode, readonly ssl = true) { super(); }
  connect() { if (this.mode !== "connect") setImmediate(() => this.emit("connect")); return this; }
  setKeepAlive() { return this; }
  reply(bytes: Buffer) { setImmediate(() => { if (!this.destroyed) this.emit("data", bytes); }); }
  write(bytes: Buffer, cb?: () => void) {
    if (this.destroyed) throw new Error("Write after transport destruction");
    if (this.ssl) this.reply(Buffer.from("S"));
    else if (this.startup) {
      this.startup = false;
      if (this.mode !== "startup") this.reply(Buffer.concat([frame("R", Buffer.alloc(4)), ready]));
    } else {
      const messages: string[] = [];
      for (let offset = 0; offset < bytes.length;) {
        const tag = String.fromCharCode(bytes[offset]!);
        const length = bytes.readInt32BE(offset + 1);
        if (tag === "P") {
          const start = bytes.indexOf(0, offset + 5) + 1;
          this.statement = bytes.toString("utf8", start, bytes.indexOf(0, start));
        }
        if (tag === "Q") this.statement = bytes.toString("utf8", offset + 5, offset + length);
        messages.push(tag); offset += length + 1;
      }
      const identity = this.statement.includes("current_database()");
      const types = this.statement.includes("pg_catalog.pg_type");
      if (messages.includes("E") || messages.includes("Q")) {
        this.commands.push(this.statement);
        const commit = this.statement.trim().toLowerCase() === "commit";
        const command = this.statement.trim().split(" ")[0]!.toUpperCase();
        if (command === "BEGIN") this.inTransaction = true;
        if (command === "COMMIT" || command === "ROLLBACK") this.inTransaction = false;
        if ((identity && this.mode === "identity") || (commit && this.mode === "commit") ||
          (this.mode === "transaction" && command === "INSERT") ||
          (!identity && !types && this.mode === "business")) return true;
        this.reply(Buffer.concat([
          ...(messages.includes("P") ? [frame("1"), description(identity)] : []),
          ...(messages.includes("B") ? [frame("2")] : []),
          ...(identity ? [identityRow()] : []),
          frame("C", Buffer.from(`${command} 0\0`)), frame("Z", Buffer.from(this.inTransaction ? "T" : "I")),
        ]));
      } else if (messages.includes("P")) {
        // Parameterized Drizzle calls describe first, then bind/execute separately.
        this.reply(Buffer.concat([frame("1"), frame("t", Buffer.alloc(2)), description(identity)]));
      }
    }
    cb?.(); return true;
  }
  // Intentionally half-open: end() alone must NOT be sufficient to close the peer.
  end() { this.readyState = "writeOnly"; return this; }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true; this.readyState = "closed";
    if (error) this.emit("error", error);
    this.peer?.destroy();
    this.parent?.destroy();
    setImmediate(() => this.emit("close", false));
    return this;
  }
}
let mode: Mode;
let raws: Wire[];
let peers: Wire[];
let databases: Set<postgres.Sql>;
let sequence = 0;
const release = { op: "release" as const, lease: { positionMint: "1".repeat(32),
  owner: "11111111-1111-4111-8111-111111111111", epoch: 1, revision: 0 } };
async function flush() {
  for (let i = 0; i < 35; i++) { await vi.advanceTimersByTimeAsync(1); await immediate(); }
}
function db() { const value = getRwaDatabase(); databases.add(value); return value; }
function observe<T>(promise: Promise<T>) {
  const outcome = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  void promise.then(value => { outcome.settled = true; outcome.value = value; }, error => { outcome.settled = true; outcome.error = error; });
  return outcome;
}
function commands() { return [...peers, ...raws.filter(raw => !raw.ssl)].flatMap(peer => peer.commands); }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mode = "healthy"; raws = []; peers = []; databases = new Set();
  vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "neon"); vi.stubEnv("SOFINANCE_RWA_DB_EXPECTED_ROLE", "sofinance");
  vi.stubEnv("VERCEL", "1"); vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "https://forbidden.invalid");
  vi.stubEnv("DATABASE_URL", `postgres://sofinance:dummy@ep-f2-${++sequence}.aws.neon.tech/sofinance`);
  vi.stubEnv("SOFINANCE_RWA_DB_POOL_MAX", "1"); vi.stubEnv("SOFINANCE_RWA_DB_CONNECT_TIMEOUT_MS", "1000");
  vi.stubEnv("SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS", "1000"); vi.stubEnv("SOFINANCE_RWA_JOB_TIMEOUT_MS", "90000");
  vi.stubEnv("SOFINANCE_RWA_JOB_LEASE_MS", "120000");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Forbidden gateway fallback"); }));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => { throw new Error("Forbidden real TCP"); });
  vi.spyOn(dns, "lookup").mockImplementation(() => { throw new Error("Forbidden real DNS"); });
  transport.makeSocket = () => {
    const raw = new Wire(mode, process.env.SOFINANCE_RWA_STORE_MODE !== "gateway"); raws.push(raw); return raw;
  };
  vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) => {
    expect(options).toMatchObject({ rejectUnauthorized: true, servername: new URL(process.env.DATABASE_URL!).hostname });
    const raw = options.socket as unknown as Wire;
    const peer = new Wire(raw.mode, false); raw.peer = peer; peer.parent = raw; peers.push(peer);
    setImmediate(() => peer.emit("secureConnect"));
    return peer as unknown as tls.TLSSocket;
  }) as typeof tls.connect);
});
afterEach(async () => {
  // Force real driver cleanup even for reserved/half-open test transports.
  const ending = [...databases].map(value => value.end({ timeout: 0 }));
  for (const raw of raws) raw.destroy();
  await flush(); await Promise.all(ending);
  expect(fetch).not.toHaveBeenCalled();
  expect(dns.lookup).not.toHaveBeenCalled(); expect(net.Socket.prototype.connect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});
describe("F2 actual-driver offline deadline and recovery", () => {
  it("bounds shared pending identity for both wrappers and retained wrappers recover on one fresh pool", async () => {
    mode = "identity"; const first = db();
    const rwa = getRwaStore(), position = getPositionHistoryStore();
    const outcomes = [observe(rwa.request({ op: "activePools" })), observe(position.request(release)),
      observe(assertRwaDatabaseIdentity(first)), observe(assertRwaDatabaseIdentity(first))];
    await flush();
    expect(commands().filter(sql => sql.includes("current_database()"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2500); await flush();
    expect(outcomes.every(outcome => !outcome.settled)).toBe(true);
    await vi.advanceTimersByTimeAsync(7500); await flush();
    expect(outcomes.every(outcome => outcome.settled && outcome.error instanceof Error)).toBe(true);
    expect(outcomes[0]!.error).toMatchObject({ code: "RWA_STORE_UNAVAILABLE" });
    expect(outcomes[1]!.error).toMatchObject({ code: "POSITION_STORE_UNAVAILABLE" });
    expect(raws.every(raw => raw.destroyed)).toBe(true);
    mode = "healthy"; const replacement = db(); expect(replacement).not.toBe(first);
    const recovered = [observe(rwa.request({ op: "activePools" })), observe(position.request(release))];
    await flush();
    expect(recovered.map(result => result.value)).toEqual([[], false]);
    expect(commands().filter(sql => sql.includes("current_database()"))).toHaveLength(2);
    expect(db()).toBe(replacement); // Old identity/error cleanup must not evict the new pool.
  });
  it("removes queued mutations behind an exhausted pool; late replies never run queued work", async () => {
    const first = db(); const checked = observe(assertRwaDatabaseIdentity(first)); await flush(); expect(checked.settled).toBe(true);
    const reserved = observe(first.reserve()); await flush(); expect(reserved.value).toBeDefined();
    const requests = [observe(getRwaStore().request({ op: "activePools" })), observe(getPositionHistoryStore().request(release))];
    await flush(); expect(commands()).toHaveLength(2); // Type discovery and identity only.
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(requests.every(result => result.error instanceof Error)).toBe(true);
    // The retired reservation is dead; even a late protocol reply cannot drain its queue.
    peers[0]!.reply(ready); await flush();
    expect(commands().some(sql => /position_history_state|rwa_pool_latest/.test(sql))).toBe(false);
    const replacement = db(); expect(replacement).not.toBe(first);
    const recovered = observe(getPositionHistoryStore().request(release)); await flush(); expect(recovered.value).toBe(false);
  });
  it.each(["rwa", "position"])("bounds %s business response after cached identity, without replay", async store => {
    const first = db(); const identity = observe(assertRwaDatabaseIdentity(first)); await flush(); expect(identity.error).toBeUndefined();
    mode = "business";
    peers[0]!.mode = "business";
    const request = observe(store === "rwa" ? getRwaStore().request({ op: "activePools" }) : getPositionHistoryStore().request(release));
    await flush(); const sent = commands().length; expect(request.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(request.error).toMatchObject({ code: store === "rwa" ? "RWA_STORE_UNAVAILABLE" : "POSITION_STORE_UNAVAILABLE" });
    expect(commands()).toHaveLength(sent); expect(raws[0]!.destroyed).toBe(true);
    mode = "healthy"; db(); const recovery = observe(getRwaStore().request({ op: "activePools" })); await flush(); expect(recovery.value).toEqual([]);
  });
  it("treats a lost COMMIT acknowledgement as failure, stops queued writes and never retries the transaction", async () => {
    mode = "commit"; const first = db();
    const claim = observe(getRwaStore().request({ op: "claim", job: "rwa-discovery", force: false }));
    await flush(); expect(commands().filter(sql => sql.trim() === "commit")).toHaveLength(1);
    const queued = observe(getPositionHistoryStore().request(release)); await flush();
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(claim.error).toMatchObject({ code: "RWA_STORE_UNAVAILABLE" });
    expect(queued.error).toMatchObject({ code: "POSITION_STORE_UNAVAILABLE" });
    expect(commands().filter(sql => sql.includes('insert into "background_job_state"'))).toHaveLength(1);
    expect(commands().some(sql => sql.includes("position_history_state"))).toBe(false);
    expect(db()).not.toBe(first);
    const recovered = observe(getRwaStore().request({ op: "activePools" })); await flush();
    expect(recovered.value).toEqual([]);
    // A fresh request reconnects, but the unknown-outcome claim is never replayed.
    expect(commands().filter(sql => sql.includes('insert into "background_job_state"'))).toHaveLength(1);
  });
  it("terminates an interrupted transaction body before its next mutation or COMMIT", async () => {
    mode = "transaction"; db();
    const claim = observe(getRwaStore().request({ op: "claim", job: "rwa-discovery", force: false }));
    await flush();
    expect(commands().filter(sql => sql.includes('insert into "background_job_state"'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(claim.error).toMatchObject({ code: "RWA_STORE_UNAVAILABLE" });
    expect(commands().some(sql => sql.includes('update "background_job_state"') || sql.trim() === "commit")).toBe(false);
    expect(raws.every(raw => raw.destroyed)).toBe(true);
  });
  it("prevents an old continuation from writing or invalidating a newer pool after timeout", async () => {
    const first = db(); let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const operation = observe(runRwaDatabaseRequest(first, async () => { await gate; await first`INSERT INTO late_mutation VALUES (1)`; }));
    await flush(); await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(operation.error).toBeInstanceOf(Error);
    const replacement = db(); resume(); await flush();
    expect(commands().some(sql => sql.includes("late_mutation"))).toBe(false);
    expect(db()).toBe(replacement);
  });
  it.each(["connect", "startup"] as const)("also bounds stalled %s before readiness", async stall => {
    mode = stall; db(); const result = observe(getRwaStore().request({ op: "activePools" })); await flush();
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(result.error).toMatchObject({ code: "RWA_STORE_UNAVAILABLE" });
    expect(raws.every(raw => raw.destroyed)).toBe(true);
  });
  it("preserves larger configured query budgets while staying below the job/lease bound", () => {
    expect(rwaDatabaseDeadlineMs()).toBe(10_000);
    vi.stubEnv("SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS", "15000"); expect(rwaDatabaseDeadlineMs()).toBe(16_000);
    vi.stubEnv("SOFINANCE_RWA_DB_CONNECT_TIMEOUT_MS", "15000"); expect(rwaDatabaseDeadlineMs()).toBe(30_000);
    vi.stubEnv("SOFINANCE_RWA_JOB_TIMEOUT_MS", "10000"); expect(rwaDatabaseDeadlineMs()).toBe(9000);
  });
  it("preserves the non-Vercel private direct transport used by gateway deployments", async () => {
    vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "gateway"); vi.stubEnv("VERCEL", "");
    vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://sofinance:dummy@private-db.test/sofinance");
    const first = db(); expect(first.options.ssl).toBe(false);
    const results = [observe(getRwaStore().request({ op: "activePools" })), observe(getPositionHistoryStore().request(release))];
    await flush();
    expect(results.map(result => result.value)).toEqual([[], false]);
    expect(peers).toHaveLength(0); expect(raws).toHaveLength(1); expect(db()).toBe(first);
  });
});
