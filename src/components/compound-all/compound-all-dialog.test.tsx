// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompoundAllRunner, type CompoundAllDeps, type RowOutcome } from "@/lib/compound-all/runner";
import type { CompoundAllRowInput, CompoundAllState } from "@/lib/compound-all/state";
import { CompoundAllDialog, compoundAllDismissible, type CompoundAllActions } from "./compound-all-dialog";
import { cleanupThroughHost, CLEANUP_WAITING } from "./use-compound-all";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never) }));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const ray = (n: number): CompoundAllRowInput => ({ key: `raydium-clmm:r${n}` as CompoundAllRowInput["key"], dex: "raydium-clmm", flow: "native-harvest", positionId: `r${n}` });
const met = (n: number, outOfRange = false): CompoundAllRowInput => ({ key: `meteora-dlmm:m${n}` as CompoundAllRowInput["key"], dex: "meteora-dlmm", flow: "registry", positionId: `m${n}`, outOfRange });

/** A runner with scripted outcomes, rendered through the popup; every user answer goes back to the runner. */
function harness(rows: CompoundAllRowInput[], outcomes: Record<string, RowOutcome[]> = {}, cleanup: CompoundAllDeps["runCleanup"] = async () => ({ status: "done", signatures: ["c1"] })) {
  const runner = createCompoundAllRunner(rows, {
    runRow: async (row) => outcomes[row.key]?.shift() ?? { status: "done", signature: `sig-${row.positionId}` },
    runCleanup: cleanup,
  });
  const actions: CompoundAllActions = { select: runner.select, start: () => { void runner.start(); }, retry: runner.retry, skip: runner.skip,
    continue: runner.continue, cancel: runner.cancel, runCleanup: runner.runCleanup, skipCleanup: runner.skipCleanup };
  const render = async (state: CompoundAllState = runner.state) => {
    await act(async () => root.render(createElement(CompoundAllDialog, { open: true, state, labelOf: (key) => ({ title: `Pool ${key.split(":")[1]}`, subtitle: "A / B" }),
      dexName: (dex) => dex === "raydium-clmm" ? "Raydium CLMM" : "Meteora DLMM", actions, onClose: () => {} })));
  };
  current = { runner, render };
  return current;
}
let current: { runner: ReturnType<typeof createCompoundAllRunner>; render: (state?: CompoundAllState) => Promise<void> } | null = null;
const q = (sel: string) => container.querySelector<HTMLElement>(`[data-testid=${sel}]`);
const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid=${sel}]`)];
/** Lets the runner's promises run, then renders its latest state (the page re-renders on every runner event). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await current!.render();
};
const click = async (sel: string) => { await act(async () => { q(sel)!.click(); }); await settle(); };

describe("Compound all popup", () => {
  it("before Start: the approval count, a checkbox on every row, out-of-range Meteora unchecked with its label, and the final cleanup row", async () => {
    const { render, runner } = harness([ray(1), met(1, true), met(2)]);
    await render();
    expect(q("compound-all-approvals")!.textContent).toContain("Start asks for 3 wallet approvals");
    expect(q("compound-all-approvals")!.textContent).toContain("2 compounds + 1 cleanup");
    const checks = qa("compound-all-row-check") as HTMLInputElement[];
    expect(checks.map((c) => c.checked)).toEqual([true, false, true]);
    expect(qa("compound-all-out-of-range")).toHaveLength(1);
    expect(q("compound-all-out-of-range")!.textContent).toContain("Out of range");
    expect(q("compound-all-cleanup-row")).not.toBeNull();
    await act(async () => { checks[1]!.click(); });
    await settle();
    expect(runner.approvals()).toEqual({ rows: 3, cleanup: 1, total: 4 });
    expect(q("compound-all-approvals")!.textContent).toContain("4 wallet approvals");
    expect(container.textContent).not.toMatch(/backtest|earn|yield|apy|guarantee|open source/i);
  });

  it("no Raydium row selected: no cleanup row and no cleanup approval; nothing selected disables Start", async () => {
    const { render, runner } = harness([ray(1), met(1)]);
    runner.select(ray(1).key, false);
    await render();
    expect(q("compound-all-approvals")!.textContent).toContain("1 wallet approval");
    expect(q("compound-all-cleanup-row")).toBeNull();
    runner.select(met(1).key, false);
    await render();
    expect((q("compound-all-start") as HTMLButtonElement).disabled).toBe(true);
  });

  it("pauses after 10 rows with Continue / Stop", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => met(i + 1));
    const { render } = harness(rows);
    await render();
    await click("compound-all-start");
    await settle();
    expect(q("compound-all-body")!.dataset.phase).toBe("paused-checkpoint");
    expect(q("compound-all-checkpoint")!.textContent).toContain("10 positions done. Continue with the next ones?");
    expect(qa("compound-all-row").filter((row) => row.dataset.status === "done")).toHaveLength(10);
    await click("compound-all-continue");
    await settle();
    expect(q("compound-all-summary")!.textContent).toContain("Compounded12");
  });

  it("a failure pauses with Retry / Skip; a row that may still land offers Skip only", async () => {
    const { render } = harness([met(1), met(2)], {
      "meteora-dlmm:m1": [{ status: "rejected", error: "You rejected the request.", retryable: true }],
      "meteora-dlmm:m2": [{ status: "failed", error: "This compound is still confirming.", retryable: false }],
    });
    await render();
    await click("compound-all-start");
    await settle();
    expect(q("compound-all-body")!.dataset.phase).toBe("paused-failure");
    expect(q("compound-all-failure")!.textContent).toContain("Try it again, or skip it.");
    expect(q("compound-all-retry")).not.toBeNull();
    expect(container.textContent).toContain("You rejected the request.");
    await click("compound-all-retry");
    await settle();
    expect(q("compound-all-retry")).toBeNull();
    expect(q("compound-all-skip")).not.toBeNull();
    await click("compound-all-skip");
    await settle();
    expect(q("compound-all-summary")!.textContent).toContain("Skipped1");
  });

  it("the final cleanup row runs after the Raydium rows, and the summary follows", async () => {
    const cleanup = vi.fn(async () => ({ status: "done" as const, signatures: ["c1"] }));
    const { render } = harness([ray(1), met(1)], {}, cleanup);
    await render();
    await click("compound-all-start");
    await settle();
    expect(cleanup).toHaveBeenCalledWith(["sig-r1"], expect.anything());
    expect(q("compound-all-cleanup-row")!.dataset.status).toBe("done");
    expect(q("compound-all-summary")!.textContent).toContain("All done.");
    expect(q("compound-all-recovery")).toBeNull();
    expect(q("compound-all-close")).not.toBeNull();
  });

  it("after Stop the cleanup row is still offered; skipping it points to the recovery page", async () => {
    const { render } = harness([ray(1), ray(2)], { "raydium-clmm:r2": [{ status: "failed", error: "Simulation failed.", retryable: true, notSigned: true }] });
    await render();
    await click("compound-all-start");
    await settle();
    expect(q("compound-all-body")!.dataset.phase).toBe("paused-failure");
    await act(async () => { container.querySelector<HTMLButtonElement>("[data-testid=compound-all-failure] button")!.click(); }); // Stop
    await settle();
    await settle();
    expect(q("compound-all-body")!.dataset.phase).toBe("cleanup-offered");
    expect(q("compound-all-cleanup-row")).not.toBeNull();
    expect(q("compound-all-cleanup-offer")!.querySelector("a")!.getAttribute("href")).toBe("/app/portfolio/recovery");
    await click("compound-all-skip-cleanup");
    await settle();
    expect(q("compound-all-summary")!.textContent).toContain("Stopped.");
    expect(q("compound-all-recovery")!.querySelector("a")!.getAttribute("href")).toBe("/app/portfolio/recovery");
  });

  it("can't be dismissed mid-run", () => {
    const runner = createCompoundAllRunner([met(1)], { runRow: () => new Promise(() => {}), runCleanup: async () => ({ status: "done" }) });
    expect(compoundAllDismissible(runner.state)).toBe(true);
    void runner.start();
    expect(compoundAllDismissible(runner.state)).toBe(false);
    runner.cancel();
  });
});

describe("cleanupThroughHost (the selected position's cleanup batch)", () => {
  const receipts = [{ wallet: "w", positionMint: "p", sourceSignature: "s", compoundAccounts: [] as never }];
  it("re-reads the records, waits for the controller's admission, then starts its batch", async () => {
    let admitted = false;
    const host = { reloadSaved: vi.fn(), cleanupAdmission: vi.fn(() => admitted),
      startCleanupBatch: vi.fn(async (_r: unknown, onStage?: (s: "preparing" | "wallet" | "broadcasting") => void) => { onStage?.("wallet"); return { status: "done" as const, signatures: ["c"] }; }) };
    const stages: string[] = [];
    const run = cleanupThroughHost(host, { intervalMs: 1, waitMs: 1_000 })(receipts, (stage) => stages.push(stage));
    await new Promise((r) => setTimeout(r, 5));
    expect(host.startCleanupBatch).not.toHaveBeenCalled();
    admitted = true;
    expect(await run).toEqual({ status: "done", signatures: ["c"] });
    expect(host.reloadSaved).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(["awaiting-wallet"]);
  });
  it("gives up (nothing prepared) when an earlier compound never settles, and maps a refusal to a failure", async () => {
    const host = { reloadSaved: () => {}, cleanupAdmission: () => false, startCleanupBatch: vi.fn() };
    expect(await cleanupThroughHost(host, { intervalMs: 1, waitMs: 5 })(receipts, () => {})).toEqual({ status: "failed", error: CLEANUP_WAITING });
    expect(host.startCleanupBatch).not.toHaveBeenCalled();
    const refusing = { reloadSaved: () => {}, cleanupAdmission: () => true, startCleanupBatch: async () => ({ status: "refused" as const, error: "busy" }) };
    expect(await cleanupThroughHost(refusing)(receipts, () => {})).toEqual({ status: "failed", error: "busy" });
  });
});
