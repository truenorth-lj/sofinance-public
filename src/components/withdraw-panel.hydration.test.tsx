// @vitest-environment happy-dom
import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WithdrawPanel } from "./withdraw-panel";
import { withdrawCheckpoint, withdrawKey, withdrawPosition, withdrawWallet } from "@/lib/test-support/withdraw-checkpoint-fixtures";

vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: withdrawWallet, connected: true, signTransaction: vi.fn() }) }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const panel = () => createElement(WithdrawPanel, { wallet: withdrawWallet, positionMint: withdrawPosition, mintA: withdrawPosition, mintB: withdrawWallet,
  label: (m: string) => m, onClose: vi.fn(), onConfirmed: vi.fn(), onBusyChange: vi.fn() });
let root: Root | null = null; let container: HTMLDivElement;
beforeEach(() => { localStorage.clear(); container = document.createElement("div"); document.body.append(container); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; container.remove(); vi.restoreAllMocks(); });

it("hydrates without a mismatch when a saved withdrawal exists, then shows the interrupted note and Resume (PR10 items 6, 9)", async () => {
  // Server HTML has no storage: it renders the fresh form.
  container.innerHTML = renderToString(panel());
  localStorage.setItem(withdrawKey, JSON.stringify(withdrawCheckpoint("withdraw")));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const recoverable: unknown[] = [];
  await act(async () => { root = hydrateRoot(container, panel(), { onRecoverableError: (error) => recoverable.push(error) }); });
  expect(recoverable).toEqual([]);
  expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrat/i);
  expect(container.querySelector('[data-testid="withdraw-interrupted"]')?.textContent).toMatch(/interrupted after step 1 of 2/);
  expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Resume withdrawal")).toBe(true);
});

it("no saved withdrawal: no interrupted note", async () => {
  container.innerHTML = renderToString(panel());
  await act(async () => { root = hydrateRoot(container, panel()); });
  expect(container.querySelector('[data-testid="withdraw-interrupted"]')).toBeNull();
});
