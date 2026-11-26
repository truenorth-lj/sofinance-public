import { describe, expect, it, vi } from "vitest";
import { createCompoundAllRunner, type CleanupOutcome, type CompoundAllDeps, type RowOutcome } from "./runner";
import type { CompoundAllRow, CompoundAllRowInput, CompoundAllState } from "./state";

const ray = (n: number): CompoundAllRowInput => ({ key: `raydium-clmm:ray${n}`, dex: "raydium-clmm", flow: "native-harvest", positionId: `ray${n}` });
const met = (n: number, outOfRange = false): CompoundAllRowInput => ({ key: `meteora-dlmm:met${n}`, dex: "meteora-dlmm", flow: "registry", positionId: `met${n}`, outOfRange });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/**
 * Mocked prepare + send: every call of `runRow` is one fresh prepare of that row (the real executors prepare inside
 * it). Each call waits for the test to answer it, so the test sees exactly what is in flight.
 */
function harness(inputs: CompoundAllRowInput[], options: { checkpointEvery?: number; cleanup?: () => Promise<CleanupOutcome> } = {}) {
  const prepares: string[] = [];
  const pending: Array<{ row: CompoundAllRow; resolve: (outcome: RowOutcome) => void; isCurrent: () => boolean; stage: (s: "awaiting-wallet" | "confirming", sig?: string) => void }> = [];
  let inFlight = 0, maxInFlight = 0;
  const cleanups: string[][] = [];
  const deps: CompoundAllDeps = {
    runRow: (row, context) => {
      prepares.push(row.key); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<RowOutcome>((resolve) => pending.push({ row, isCurrent: context.isCurrent, stage: context.onStage,
        resolve: (outcome) => { inFlight--; resolve(outcome); } }));
    },
    runCleanup: vi.fn(async (sources, context) => {
      cleanups.push([...sources]); context.onStage("awaiting-wallet");
      return options.cleanup ? options.cleanup() : { status: "done" as const, signatures: ["cleanup-sig"] };
    }),
  };
  const runner = createCompoundAllRunner(inputs, deps, { checkpointEvery: options.checkpointEvery });
  const phases: CompoundAllState["phase"][] = [];
  runner.subscribe((state) => { if (phases.at(-1) !== state.phase) phases.push(state.phase); });
  const answer = async (outcome: RowOutcome) => {
    const next = pending.shift();
    if (!next) throw new Error("no row in flight");
    if (outcome.status === "done") { next.stage("awaiting-wallet"); next.stage("confirming", outcome.signature); }
    next.resolve(outcome); await flush();
  };
  const done = (sig: string) => answer({ status: "done", signature: sig });
  return { runner, prepares, pending, cleanups, deps, phases, answer, done, maxInFlight: () => maxInFlight };
}
const statuses = (state: CompoundAllState) => state.rows.map((row) => row.status);

describe("compound-all runner", () => {
  it("runs selected rows strictly one at a time, preparing each only after the previous one confirmed, then the cleanup row", async () => {
    const h = harness([ray(1), met(1), met(2, true), ray(2)]);
    expect(h.runner.approvals()).toEqual({ rows: 3, cleanup: 1, total: 4 });
    const finished = h.runner.start(); await flush();
    expect(h.prepares).toEqual(["raydium-clmm:ray1"]);
    expect(h.runner.state.rows[0]!.status).toBe("preparing");
    await h.done("r1");
    expect(h.prepares).toEqual(["raydium-clmm:ray1", "meteora-dlmm:met1"]);
    await h.done("m1");
    // The out-of-range Meteora row was left unselected, so it is never prepared.
    expect(h.prepares).toEqual(["raydium-clmm:ray1", "meteora-dlmm:met1", "raydium-clmm:ray2"]);
    expect(h.cleanups).toEqual([]);
    await h.done("r2");
    const state = await finished;
    expect(h.maxInFlight()).toBe(1);
    expect(statuses(state)).toEqual(["done", "done", "queued", "done"]);
    expect(h.cleanups).toEqual([["r1", "r2"]]);
    expect(state.phase).toBe("finished");
    expect(state.cleanup).toMatchObject({ status: "done", signatures: ["cleanup-sig"] });
    expect(h.runner.summary()).toMatchObject({ selected: 3, done: 3, notSelected: 1, signatures: ["r1", "m1", "r2"], recoveryPath: null });
  });

  it("never runs a cleanup row when no Raydium row was done", async () => {
    const h = harness([met(1)]);
    const finished = h.runner.start(); await flush();
    await h.done("m1");
    expect((await finished).cleanup.status).toBe("none");
    expect(h.deps.runCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", { status: "expired", error: "This request expired.", retryable: true }],
    ["rejected", { status: "rejected", error: "User rejected the request", retryable: true }],
    ["failed", { status: "failed", error: "Simulation failed", retryable: true }],
  ] as const)("pauses on a %s row; Retry prepares that row again (a fresh transaction)", async (_name, failure) => {
    const h = harness([met(1), met(2)]);
    const finished = h.runner.start(); await flush();
    await h.answer(failure);
    expect(h.runner.state.phase).toBe("paused-failure");
    expect(h.runner.state.rows[0]).toMatchObject({ status: failure.status, error: failure.error, retryable: true, attempts: 1 });
    expect(h.prepares).toEqual(["meteora-dlmm:met1"]);
    h.runner.retry(); await flush();
    expect(h.prepares).toEqual(["meteora-dlmm:met1", "meteora-dlmm:met1"]);
    expect(h.runner.state.rows[0]).toMatchObject({ status: "preparing", attempts: 2, error: undefined });
    await h.done("m1"); await h.done("m2");
    expect(statuses(await finished)).toEqual(["done", "done"]);
  });

  it("Skip moves past a failed row; a row that may still land offers no Retry", async () => {
    const h = harness([met(1), met(2)]);
    const finished = h.runner.start(); await flush();
    await h.answer({ status: "failed", error: "still confirming", retryable: false });
    expect(h.runner.retry()).toBe(false);
    expect(h.prepares).toEqual(["meteora-dlmm:met1"]);
    h.runner.skip(); await flush();
    expect(h.prepares).toEqual(["meteora-dlmm:met1", "meteora-dlmm:met2"]);
    await h.done("m2");
    const state = await finished;
    expect(statuses(state)).toEqual(["skipped", "done"]);
    expect(h.runner.summary()).toMatchObject({ done: 1, skipped: 1 });
  });

  it("cancel while a row is in flight lets that row answer, stops before the wallet, and leaves the rest unsigned", async () => {
    const h = harness([met(1), met(2), met(3)]);
    const finished = h.runner.start(); await flush();
    expect(h.pending[0]!.isCurrent()).toBe(true);
    h.runner.cancel(); await flush();
    expect(h.pending[0]!.isCurrent()).toBe(false);
    await h.answer({ status: "failed", error: "Your wallet or inputs changed, so nothing was sent.", retryable: true, notSigned: true });
    const state = await finished;
    expect(statuses(state)).toEqual(["not-signed", "not-signed", "not-signed"]);
    expect(state.phase).toBe("cancelled");
    expect(h.prepares).toEqual(["meteora-dlmm:met1"]);
  });

  it("after a cancel the cleanup row is offered for Raydium rows already done, and runs only when asked", async () => {
    const h = harness([ray(1), ray(2), met(1)]);
    const finished = h.runner.start(); await flush();
    await h.done("r1");
    h.runner.cancel(); await flush();
    await h.answer({ status: "rejected", error: "User rejected", retryable: true });
    expect(h.runner.state.phase).toBe("cleanup-offered");
    expect(statuses(h.runner.state)).toEqual(["done", "rejected", "not-signed"]);
    expect(h.deps.runCleanup).not.toHaveBeenCalled();
    h.runner.runCleanup();
    const state = await finished;
    expect(h.cleanups).toEqual([["r1"]]);
    expect([state.phase, state.cleanup.status]).toEqual(["cancelled", "done"]);
  });

  it("a cancel from a failure pause still offers the cleanup; skipping it points the summary at recovery", async () => {
    const h = harness([ray(1), met(1), met(2)]);
    const finished = h.runner.start(); await flush();
    await h.done("r1");
    await h.answer({ status: "failed", error: "Simulation failed", retryable: true });
    h.runner.cancel(); await flush();
    expect(h.runner.state.phase).toBe("cleanup-offered");
    h.runner.skipCleanup();
    const state = await finished;
    expect([state.phase, state.cleanup.status]).toEqual(["cancelled", "skipped"]);
    expect(h.runner.summary()).toMatchObject({ done: 1, failed: 1, notSigned: 1, recoveryPath: "/app/portfolio/recovery" });
    expect(h.deps.runCleanup).not.toHaveBeenCalled();
  });

  it("pauses after every 10 finished rows and waits for Continue", async () => {
    const inputs = Array.from({ length: 23 }, (_, i) => met(i + 1));
    const h = harness(inputs);
    const finished = h.runner.start(); await flush();
    for (let i = 1; i <= 10; i++) await h.done(`m${i}`);
    expect(h.runner.state.phase).toBe("paused-checkpoint");
    expect(h.prepares).toHaveLength(10);
    await flush();
    expect(h.prepares).toHaveLength(10);
    h.runner.continue(); await flush();
    expect(h.prepares).toHaveLength(11);
    // A skipped row counts toward the 10 as well.
    await h.answer({ status: "failed", error: "x", retryable: true }); h.runner.skip(); await flush();
    for (let i = 12; i <= 20; i++) await h.done(`m${i}`);
    expect(h.runner.state.phase).toBe("paused-checkpoint");
    expect(h.prepares).toHaveLength(20);
    h.runner.continue(); await flush();
    for (let i = 21; i <= 23; i++) await h.done(`m${i}`);
    // No pause after the last row.
    const state = await finished;
    expect(state.phase).toBe("finished");
    expect(h.phases.filter((phase) => phase === "paused-checkpoint")).toHaveLength(2);
    expect(h.maxInFlight()).toBe(1);
  });

  it("a failed cleanup pauses with Retry and Skip", async () => {
    let fail = true;
    const h = harness([ray(1)], { cleanup: async () => fail ? { status: "failed", error: "Wallet closed" } : { status: "done" } });
    const finished = h.runner.start(); await flush();
    await h.done("r1");
    expect(h.runner.state.phase).toBe("paused-cleanup-failure");
    expect(h.runner.state.cleanup).toMatchObject({ status: "failed", error: "Wallet closed" });
    fail = false; h.runner.runCleanup();
    const state = await finished;
    expect(h.cleanups).toEqual([["r1"], ["r1"]]);
    expect([state.phase, state.cleanup.status]).toEqual(["finished", "done"]);
  });

  it("an executor throw becomes a non-retryable failure (it may follow a send)", async () => {
    const runner = createCompoundAllRunner([met(1)], { runRow: async () => { throw new Error("boom"); }, runCleanup: async () => ({ status: "done" }) });
    void runner.start(); await flush();
    expect(runner.state.phase).toBe("paused-failure");
    expect(runner.state.rows[0]).toMatchObject({ status: "failed", error: "boom", retryable: false });
  });

  it("does nothing until Start, and Start with nothing selected sends nothing", async () => {
    const h = harness([met(1, true)]);
    await flush();
    expect(h.prepares).toEqual([]);
    expect((await h.runner.start()).phase).toBe("setup");
    expect(h.prepares).toEqual([]);
    h.runner.select("meteora-dlmm:met1", true);
    const finished = h.runner.start(); await flush();
    expect(h.runner.start()).toBe(finished);
    await h.done("m1");
    expect((await finished).phase).toBe("finished");
  });
});
