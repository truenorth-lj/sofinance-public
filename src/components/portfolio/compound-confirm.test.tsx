// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompoundConfirm } from "./compound-confirm";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows Unclaimed fees and does not render a Protocol fee row", async () => {
  const onConfirm = vi.fn();
  await act(async () => root.render(createElement(CompoundConfirm, {
    unclaimedUsd: 1.25, blocked: null, loading: false, disabled: false, onConfirm,
  })));
  expect(container.querySelector("[data-testid=compound-confirm-unclaimed]")?.textContent).toBe("$1.25");
  expect(container.textContent).toContain("Unclaimed fees");
  expect(container.querySelector("[data-testid=compound-confirm-fee]")).toBeNull();
  expect(container.textContent).not.toContain("Protocol fee");
  expect(container.textContent).not.toMatch(/0\.10%/);
  expect(container.textContent).not.toMatch(/backtest|earn|yield|auto-rebalance|guarantee/i);
});
