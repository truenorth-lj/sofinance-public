// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PLAN_SETUP } from "@/lib/lp-plan-intent";
import { formatUtcDate } from "./format";
import { IntentSentence } from "./intent-sentence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-25T14:22:17.000Z");
const setup = { ...DEFAULT_PLAN_SETUP, days: 90 };

describe("IntentSentence planning end date", () => {
  let node: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });

  afterEach(() => {
    act(() => root.unmount());
    node.remove();
  });

  function render(now: number | null) {
    act(() => {
      root.render(createElement(IntentSentence, {
        setup,
        now,
        active: "days",
        onActiveChange: () => {},
        onChange: () => {},
      }));
    });
  }

  it("omits the end date until now is provided after mount, then prints it in UTC", () => {
    render(null);
    expect(node.textContent).toContain("Type any whole number of days from 1 to 365, or slide.");
    expect(node.textContent).toContain("A planning horizon, not a lock-up or a promise of profit.");
    expect(node.textContent).not.toContain("Ends ");
    expect(node.innerHTML).not.toContain("suppressHydrationWarning");

    render(NOW);
    expect(node.textContent).toContain(`Ends ${formatUtcDate(NOW + 90 * 86_400_000)} (UTC).`);
    expect(node.textContent).toContain("Ends Feb 23, 2027 (UTC).");
  });
});
