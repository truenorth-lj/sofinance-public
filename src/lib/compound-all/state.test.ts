import { describe, expect, it } from "vitest";
import type { PositionKey } from "@/lib/unified-positions/model";
import { dexDescriptors } from "@/lib/dex/client";
import {
  compoundAllApprovals, compoundAllFlowFor, compoundAllReducer, createCompoundAllState, nextQueuedRow, summarizeCompoundAll,
  type CompoundAllEvent, type CompoundAllRowInput, type CompoundAllState,
} from "./state";

const ray = (n: number): CompoundAllRowInput => ({ key: `raydium-clmm:ray${n}`, dex: "raydium-clmm", flow: "native-harvest", positionId: `ray${n}` });
const met = (n: number, outOfRange = false): CompoundAllRowInput => ({ key: `meteora-dlmm:met${n}`, dex: "meteora-dlmm", flow: "registry", positionId: `met${n}`, outOfRange });
const apply = (state: CompoundAllState, ...events: CompoundAllEvent[]) => events.reduce(compoundAllReducer, state);
const row = (state: CompoundAllState, key: string) => state.rows.find((item) => item.key === key)!;
const started = (inputs: CompoundAllRowInput[], every?: number) => apply(createCompoundAllState(inputs, every), { type: "start" });
const sent = (key: PositionKey, signature = `sig-${key}`): CompoundAllEvent[] => [
  { type: "row/stage", key, stage: "preparing" }, { type: "row/stage", key, stage: "awaiting-wallet" },
  { type: "row/stage", key, stage: "confirming", signature }, { type: "row/done", key, signature },
];

describe("default selection and approval count", () => {
  it("selects every row except out-of-range Meteora rows, which are flagged as sending part of the fees to the wallet", () => {
    const state = createCompoundAllState([ray(1), { ...ray(2), outOfRange: true }, met(1), met(2, true)]);
    expect(state.rows.map((r) => [r.key, r.selected, r.partToWallet, r.status])).toEqual([
      ["raydium-clmm:ray1", true, false, "queued"], ["raydium-clmm:ray2", true, false, "queued"],
      ["meteora-dlmm:met1", true, false, "queued"], ["meteora-dlmm:met2", false, true, "queued"],
    ]);
    expect(state.phase).toBe("setup");
  });
  it("counts one approval per selected row plus one for the Raydium cleanup batch", () => {
    let state = createCompoundAllState([ray(1), ray(2), met(1), met(2, true)]);
    expect(compoundAllApprovals(state)).toEqual({ rows: 3, cleanup: 1, total: 4 });
    state = apply(state, { type: "select", key: "meteora-dlmm:met2", selected: true });
    expect(compoundAllApprovals(state)).toEqual({ rows: 4, cleanup: 1, total: 5 });
    state = apply(state, { type: "select", key: "raydium-clmm:ray1", selected: false }, { type: "select", key: "raydium-clmm:ray2", selected: false });
    expect(compoundAllApprovals(state)).toEqual({ rows: 2, cleanup: 0, total: 2 });
    expect(compoundAllApprovals(createCompoundAllState([]))).toEqual({ rows: 0, cleanup: 0, total: 0 });
  });
  it("refuses duplicate rows and a bad checkpoint size", () => {
    expect(() => createCompoundAllState([ray(1), ray(1)])).toThrow(/Duplicate/);
    expect(() => createCompoundAllState([ray(1)], 0)).toThrow(/checkpointEvery/);
  });
});

describe("transitions", () => {
  it("select only changes rows before Start; Start needs a selected row", () => {
    const setup = createCompoundAllState([met(1, true)]);
    expect(compoundAllReducer(setup, { type: "start" })).toBe(setup);
    const chosen = apply(setup, { type: "select", key: "meteora-dlmm:met1", selected: true });
    expect(row(chosen, "meteora-dlmm:met1").selected).toBe(true);
    expect(compoundAllReducer(chosen, { type: "select", key: "meteora-dlmm:met1", selected: true })).toBe(chosen);
    expect(compoundAllReducer(chosen, { type: "select", key: "meteora-dlmm:nope", selected: false })).toBe(chosen);
    const running = apply(chosen, { type: "start" });
    expect(running.phase).toBe("running");
    expect(compoundAllReducer(running, { type: "select", key: "meteora-dlmm:met1", selected: false })).toBe(running);
    expect(compoundAllReducer(running, { type: "start" })).toBe(running);
  });
  it("a row goes queued → preparing → awaiting-wallet → confirming → done, one attempt", () => {
    let state = started([met(1), met(2)]);
    state = apply(state, { type: "row/stage", key: "meteora-dlmm:met1", stage: "preparing" });
    expect([row(state, "meteora-dlmm:met1").status, row(state, "meteora-dlmm:met1").attempts, state.active]).toEqual(["preparing", 1, "meteora-dlmm:met1"]);
    // Another row cannot start while one is in flight (strictly sequential).
    expect(compoundAllReducer(state, { type: "row/stage", key: "meteora-dlmm:met2", stage: "preparing" })).toBe(state);
    state = apply(state, { type: "row/stage", key: "meteora-dlmm:met1", stage: "awaiting-wallet" });
    expect(row(state, "meteora-dlmm:met1").status).toBe("awaiting-wallet");
    state = apply(state, { type: "row/stage", key: "meteora-dlmm:met1", stage: "confirming", signature: "s1" });
    expect(row(state, "meteora-dlmm:met1")).toMatchObject({ status: "confirming", signature: "s1", attempts: 1 });
    state = apply(state, { type: "row/done", key: "meteora-dlmm:met1", signature: "s1" });
    expect(row(state, "meteora-dlmm:met1")).toMatchObject({ status: "done", signature: "s1" });
    expect([state.active, state.sinceCheckpoint, state.cleanup.status]).toEqual([null, 1, "none"]);
    expect(nextQueuedRow(state)?.key).toBe("meteora-dlmm:met2");
  });
  it("row/done and row/failed apply only to the active in-flight row", () => {
    const state = started([met(1)]);
    expect(compoundAllReducer(state, { type: "row/done", key: "meteora-dlmm:met1", signature: "s" })).toBe(state);
    expect(compoundAllReducer(state, { type: "row/failed", key: "meteora-dlmm:met1", failure: "failed", error: "x", retryable: true })).toBe(state);
  });
  it("a done Raydium row queues the cleanup row with its signature", () => {
    const state = apply(started([ray(1), ray(2), met(1)]), ...sent("raydium-clmm:ray1", "r1"), ...sent("meteora-dlmm:met1", "m1"), ...sent("raydium-clmm:ray2", "r2"));
    expect(state.cleanup).toMatchObject({ status: "pending", sources: ["r1", "r2"] });
  });
  it.each(["rejected", "expired", "failed"] as const)("a %s row pauses the run; Retry re-queues it for a fresh prepare", (failure) => {
    let state = apply(started([met(1), met(2)]), { type: "row/stage", key: "meteora-dlmm:met1", stage: "preparing" },
      { type: "row/stage", key: "meteora-dlmm:met1", stage: "awaiting-wallet" });
    state = apply(state, { type: "row/failed", key: "meteora-dlmm:met1", failure, error: "why", retryable: true });
    expect(state.phase).toBe("paused-failure");
    expect(row(state, "meteora-dlmm:met1")).toMatchObject({ status: failure, error: "why", retryable: true });
    expect(compoundAllReducer(state, { type: "row/stage", key: "meteora-dlmm:met2", stage: "preparing" })).toBe(state);
    state = apply(state, { type: "row/retry" });
    expect([state.phase, state.active, row(state, "meteora-dlmm:met1").status]).toEqual(["running", null, "queued"]);
    state = apply(state, { type: "row/stage", key: "meteora-dlmm:met1", stage: "preparing" });
    expect(row(state, "meteora-dlmm:met1")).toMatchObject({ attempts: 2, error: undefined, status: "preparing" });
  });
  it("Retry is refused for a row whose send may still land; Skip moves on", () => {
    let state = apply(started([met(1), met(2)]), { type: "row/stage", key: "meteora-dlmm:met1", stage: "confirming", signature: "s" },
      { type: "row/failed", key: "meteora-dlmm:met1", failure: "failed", error: "still confirming", retryable: false });
    expect(compoundAllReducer(state, { type: "row/retry" })).toBe(state);
    state = apply(state, { type: "row/skip" });
    expect([state.phase, state.active, row(state, "meteora-dlmm:met1").status, state.sinceCheckpoint]).toEqual(["running", null, "skipped", 1]);
    expect(compoundAllReducer(state, { type: "row/skip" })).toBe(state);
  });
  it("pauses at the checkpoint only between rows with rows left, and Continue resets the count", () => {
    let state = started([met(1), met(2), met(3)], 2);
    expect(compoundAllReducer(state, { type: "checkpoint" })).toBe(state);
    state = apply(state, ...sent("meteora-dlmm:met1"), ...sent("meteora-dlmm:met2"));
    expect(state.sinceCheckpoint).toBe(2);
    state = apply(state, { type: "checkpoint" });
    expect(state.phase).toBe("paused-checkpoint");
    expect(compoundAllReducer(state, { type: "row/stage", key: "meteora-dlmm:met3", stage: "preparing" })).toBe(state);
    state = apply(state, { type: "continue" });
    expect([state.phase, state.sinceCheckpoint]).toEqual(["running", 0]);
    expect(compoundAllReducer(state, { type: "continue" })).toBe(state);
    const last = apply(started([met(1), met(2)], 2), ...sent("meteora-dlmm:met1"), ...sent("meteora-dlmm:met2"));
    expect(compoundAllReducer(last, { type: "checkpoint" })).toBe(last);
  });
  it("rows/complete ends the run, or hands over to the cleanup row when Raydium rows were done", () => {
    const meteora = apply(started([met(1)]), ...sent("meteora-dlmm:met1"));
    expect(apply(meteora, { type: "rows/complete" })).toMatchObject({ phase: "finished", rowsComplete: true });
    const queued = started([met(1)]);
    expect(compoundAllReducer(queued, { type: "rows/complete" })).toBe(queued);
    let state = apply(started([ray(1)]), ...sent("raydium-clmm:ray1", "r1"), { type: "rows/complete" });
    expect([state.phase, state.rowsComplete, state.cleanup.status]).toEqual(["running", true, "pending"]);
    state = apply(state, { type: "cleanup/stage", stage: "preparing" }, { type: "cleanup/stage", stage: "awaiting-wallet" },
      { type: "cleanup/stage", stage: "confirming" });
    expect(state.cleanup.status).toBe("confirming");
    state = apply(state, { type: "cleanup/done", signatures: ["c1"] });
    expect(state.phase).toBe("finished");
    expect(state.cleanup).toMatchObject({ status: "done", signatures: ["c1"], sources: ["r1"] });
  });
  it("cleanup stages wait until every row is finished", () => {
    const state = apply(started([ray(1), ray(2)]), ...sent("raydium-clmm:ray1"));
    expect(compoundAllReducer(state, { type: "cleanup/stage", stage: "preparing" })).toBe(state);
  });
  it("a failed cleanup pauses with Retry (cleanup/run) or Skip, and cancel keeps it offered", () => {
    let state = apply(started([ray(1)]), ...sent("raydium-clmm:ray1", "r1"), { type: "rows/complete" }, { type: "cleanup/stage", stage: "preparing" },
      { type: "cleanup/failed", error: "wallet closed" });
    expect([state.phase, state.cleanup.status, state.cleanup.error]).toEqual(["paused-cleanup-failure", "failed", "wallet closed"]);
    const retried = apply(state, { type: "cleanup/run" });
    expect([retried.phase, retried.cleanup.status, retried.cleanup.error]).toEqual(["running", "pending", undefined]);
    const skipped = apply(state, { type: "cleanup/skip" });
    expect([skipped.phase, skipped.cleanup.status]).toEqual(["finished", "skipped"]);
    expect(summarizeCompoundAll(skipped).recoveryPath).toBe("/app/portfolio/recovery");
    state = apply(state, { type: "cancel" });
    expect([state.phase, state.cleanup.status, state.cancelled]).toEqual(["cleanup-offered", "offered", true]);
  });
});

describe("cancel", () => {
  it("before Start ends with nothing signed", () => {
    expect(apply(createCompoundAllState([met(1)]), { type: "cancel" })).toMatchObject({ phase: "cancelled", cancelled: true });
  });
  it("between rows leaves the rest unsigned and offers the cleanup for Raydium rows already done", () => {
    const state = apply(started([ray(1), met(1), ray(2)]), ...sent("raydium-clmm:ray1", "r1"), { type: "cancel" });
    expect(state.rows.map((r) => r.status)).toEqual(["done", "not-signed", "not-signed"]);
    expect([state.phase, state.cleanup.status, state.cleanup.sources]).toEqual(["cleanup-offered", "offered", ["r1"]]);
    const run = apply(state, { type: "cleanup/run" });
    expect([run.phase, run.cleanup.status, run.rowsComplete]).toEqual(["running", "pending", true]);
    expect(apply(run, { type: "cleanup/stage", stage: "preparing" }, { type: "cleanup/done" }).phase).toBe("cancelled");
    expect(apply(state, { type: "cleanup/skip" })).toMatchObject({ phase: "cancelled", cleanup: { status: "skipped" } });
  });
  it("without Raydium rows done, ends at once", () => {
    const state = apply(started([met(1), met(2)]), ...sent("meteora-dlmm:met1"), { type: "cancel" });
    expect([state.phase, state.rows[1]!.status, state.cleanup.status]).toEqual(["cancelled", "not-signed", "none"]);
  });
  it("during a row waits for that row, then stops (a stop before the wallet marks it unsigned)", () => {
    let state = apply(started([met(1), met(2)]), { type: "row/stage", key: "meteora-dlmm:met1", stage: "preparing" }, { type: "cancel" });
    expect([state.phase, state.cancelRequested]).toEqual(["running", true]);
    expect(compoundAllReducer(state, { type: "cancel" })).toBe(state);
    expect(compoundAllReducer(state, { type: "checkpoint" })).toBe(state);
    state = apply(state, { type: "row/failed", key: "meteora-dlmm:met1", failure: "failed", error: "stopped", retryable: true, notSigned: true });
    expect(state.rows.map((r) => r.status)).toEqual(["not-signed", "not-signed"]);
    expect([state.phase, state.cancelRequested]).toEqual(["cancelled", false]);
  });
  it("during a row that then lands keeps it done and still offers the cleanup", () => {
    const state = apply(started([ray(1), ray(2)]), { type: "row/stage", key: "raydium-clmm:ray1", stage: "awaiting-wallet" }, { type: "cancel" },
      { type: "row/done", key: "raydium-clmm:ray1", signature: "r1" });
    expect(state.rows.map((r) => r.status)).toEqual(["done", "not-signed"]);
    expect(state.phase).toBe("cleanup-offered");
  });
  it("during a row the user rejected keeps the rejection", () => {
    const state = apply(started([met(1)]), { type: "row/stage", key: "meteora-dlmm:met1", stage: "awaiting-wallet" }, { type: "cancel" },
      { type: "row/failed", key: "meteora-dlmm:met1", failure: "rejected", error: "User rejected", retryable: true });
    expect([state.rows[0]!.status, state.rows[0]!.retryable, state.phase]).toEqual(["rejected", false, "cancelled"]);
  });
  it("from a failure pause or a checkpoint pause stops for good", () => {
    const failed = apply(started([ray(1), met(1), met(2)]), ...sent("raydium-clmm:ray1", "r1"), { type: "row/stage", key: "meteora-dlmm:met1", stage: "preparing" },
      { type: "row/failed", key: "meteora-dlmm:met1", failure: "failed", error: "x", retryable: true }, { type: "cancel" });
    expect(failed.rows.map((r) => r.status)).toEqual(["done", "failed", "not-signed"]);
    expect(failed.phase).toBe("cleanup-offered");
    const paused = apply(started([met(1), met(2)], 1), ...sent("meteora-dlmm:met1"), { type: "checkpoint" }, { type: "cancel" });
    expect([paused.phase, paused.rows[1]!.status]).toEqual(["cancelled", "not-signed"]);
  });
  it("after the rows, before the cleanup starts, turns the cleanup into an offer", () => {
    const state = apply(started([ray(1)]), ...sent("raydium-clmm:ray1", "r1"), { type: "rows/complete" }, { type: "cancel" });
    expect([state.phase, state.cleanup.status]).toEqual(["cleanup-offered", "offered"]);
  });
  it("is ignored once the run ended or while the cleanup is in flight", () => {
    const done = apply(started([met(1)]), ...sent("meteora-dlmm:met1"), { type: "rows/complete" });
    expect(compoundAllReducer(done, { type: "cancel" })).toBe(done);
    const cleaning = apply(started([ray(1)]), ...sent("raydium-clmm:ray1"), { type: "rows/complete" }, { type: "cleanup/stage", stage: "awaiting-wallet" });
    expect(compoundAllReducer(cleaning, { type: "cancel" })).toBe(cleaning);
  });
});

describe("end-of-run summary", () => {
  it("counts done, skipped, failed, unsigned and unselected rows, and points at recovery when the cleanup did not run", () => {
    const state = apply(started([ray(1), met(1), met(2), met(3), met(4, true)]),
      ...sent("raydium-clmm:ray1", "r1"),
      { type: "row/stage", key: "meteora-dlmm:met1", stage: "preparing" }, { type: "row/failed", key: "meteora-dlmm:met1", failure: "expired", error: "e", retryable: true },
      { type: "row/skip" }, ...sent("meteora-dlmm:met2", "m2"),
      { type: "row/stage", key: "meteora-dlmm:met3", stage: "awaiting-wallet" }, { type: "row/failed", key: "meteora-dlmm:met3", failure: "rejected", error: "no", retryable: true },
      { type: "cancel" });
    expect(summarizeCompoundAll(state)).toEqual({ selected: 4, done: 2, skipped: 1, notSigned: 0, failed: 1, notSelected: 1,
      signatures: ["r1", "m2"], cleanup: "offered", recoveryPath: "/app/portfolio/recovery" });
    const cleaned = apply(state, { type: "cleanup/run" }, { type: "cleanup/stage", stage: "preparing" }, { type: "cleanup/done" });
    expect(summarizeCompoundAll(cleaned).recoveryPath).toBeNull();
  });
});

describe("compoundAllFlowFor (read from the DEX registry)", () => {
  it("Raydium uses its native harvest compound, Meteora the registry compound, Orca and Uniswap v4 none", () => {
    expect(compoundAllFlowFor(dexDescriptors.descriptorFor("raydium-clmm"))).toBe("native-harvest");
    expect(compoundAllFlowFor(dexDescriptors.descriptorFor("meteora-dlmm"))).toBe("registry");
    expect(compoundAllFlowFor(dexDescriptors.descriptorFor("orca-whirlpool"))).toBeNull();
    expect(compoundAllFlowFor(dexDescriptors.descriptorFor("uniswap-v4-rhc"))).toBeNull();
    expect(compoundAllFlowFor(null)).toBeNull();
  });
});
