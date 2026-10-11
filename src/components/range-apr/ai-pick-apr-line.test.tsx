// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { AiPickAprLine } from "./ai-pick-apr-line";
import type { PoolRangeAprState } from "./use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ state: { status: "loading" } as PoolRangeAprState }));
vi.mock("./use-pool-range-apr", () => ({ usePoolRangeApr: () => mocks.state }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => root.render(createElement(AiPickAprLine, { poolId: "pool" })));
  return container.querySelector("[data-testid='ai-pick-apr']")!.textContent;
}

describe("AiPickAprLine", () => {
  it("labels the value 'AI-pick est. APR' (APR, not APY) and shows the AI preset estimate", () => {
    const data = payloadFixture();
    mocks.state = { status: "ready", data };
    const value = render();
    expect(container.textContent).toContain("AI-pick est. APR");
    expect(container.textContent).not.toMatch(/APY/);
    const ai = data.presets.find((preset) => preset.id === "ai")!.estimate;
    expect(ai.status).toBe("ok");
    expect(value).toMatch(/^~\d/);
  });

  it("matches the value the modal headline shows for the AI pick (same formatter, same estimate)", async () => {
    const { formatEstimate } = await import("@/lib/range-apr/format");
    const data = payloadFixture();
    mocks.state = { status: "ready", data };
    expect(render()).toBe(formatEstimate(data.presets.find((preset) => preset.id === "ai")!.estimate));
  });

  it("shows a placeholder while loading and a dash when unavailable", () => {
    mocks.state = { status: "loading" };
    expect(render()).toBe("…");
    mocks.state = { status: "error", message: "x" };
    expect(render()).toBe("—");
  });

  it("marks low-confidence values with an asterisk", () => {
    const data = payloadFixture();
    mocks.state = { status: "ready", data: { ...data, sample: { ...data.sample, confidence: "low" } } };
    expect(render()).toMatch(/\*$/);
  });

  it("explains the estimate in a tooltip", () => {
    mocks.state = { status: "ready", data: payloadFixture() };
    render();
    const info = container.querySelector<HTMLButtonElement>("button[aria-label='About AI-pick est. APR']")!;
    act(() => { info.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const tip = document.querySelector("[role='tooltip']")!.textContent!;
    expect(tip).toMatch(/not a guarantee/i);
    expect(tip).toMatch(/fixed rule, not an AI model/);
  });
});
