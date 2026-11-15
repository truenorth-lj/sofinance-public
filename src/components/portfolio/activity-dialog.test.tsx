// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordActivity, resetSessionActivity } from "@/lib/portfolio/session-activity";
import { ActionDialog } from "./action-dialog";
import { ActivityList } from "./activity-list";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetSessionActivity(); vi.unstubAllGlobals(); });
const render = (node: ReactNode) => act(async () => root.render(node));

describe("Activity", () => {
  it("shows a compound once: a saved record replaces the session summary with the same signature", async () => {
    recordActivity({ id: "compound:sig", positionKey: "p", title: "Compound confirmed", status: "success", signature: "sig" });
    recordActivity({ id: "add:other", positionKey: "p", title: "Liquidity added", status: "success", signature: "other" });
    await render(createElement(ActivityList, { positionKey: "p", savedSignatures: ["sig"], records: createElement("p", { "data-testid": "saved" }, "Compound sig") }));
    expect([...container.querySelectorAll("[data-testid=activity-entry]")].map((entry) => entry.textContent)).toEqual([expect.stringContaining("Liquidity added")]);
    expect(container.querySelectorAll("[data-testid=saved]")).toHaveLength(1);
    expect(container.querySelector("[data-testid=activity-empty]")).toBeNull();
  });
});

describe("ActionDialog page scroll lock", () => {
  it("keeps the page locked until the last open popup closes", async () => {
    document.documentElement.style.overflow = "scroll";
    const dialogs = (a: boolean, b: boolean) => <div>
      <ActionDialog open={a} onClose={() => {}} title="A" testId="a">A</ActionDialog>
      <ActionDialog open={b} onClose={() => {}} title="B" testId="b">B</ActionDialog>
    </div>;
    await render(dialogs(true, true));
    expect(document.documentElement.style.overflow).toBe("hidden");
    await render(dialogs(false, true));
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.hasAttribute("data-portfolio-popup-open")).toBe(true);
    await render(dialogs(false, false));
    expect(document.documentElement.style.overflow).toBe("scroll");
    expect(document.documentElement.hasAttribute("data-portfolio-popup-open")).toBe(false);
  });
});
