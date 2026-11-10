// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { summarizeApr7d } from "@/lib/unified-pools/apr7d";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { payloadForCapital } from "@/lib/range-apr/size-aware";
import { buildPresetList } from "@/lib/range-apr/preset-list";
import { formatEstimate } from "@/lib/range-apr/format";
import { RangePresetPicker } from "./range-preset-picker";
import { tslaPayload } from "@/lib/range-apr/tsla-payload.fixture";
import { rangeAprPayload } from "@/lib/range-apr/display-policy";
import { cardPayloadWithAprs } from "@/lib/range-apr/payload.fixture";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";

function withPicker(check: (render: (data: PoolRangeAprPayload, capitalUsd?: number | null) => HTMLDivElement) => void) {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    check((data, capitalUsd) => {
      const selected = buildPresetList(OPEN_RANGE_UI_PRESETS, rangeAprPayload(data, capitalUsd)).best?.id ?? "standard";
      act(() => root.render(createElement(RangePresetPicker, {
        presets: OPEN_RANGE_UI_PRESETS, selected, onSelect: () => {}, minPrice: "", maxPrice: "",
        onMinPrice: () => {}, onMaxPrice: () => {}, apr: { status: "ready", data }, quotedRange: null, capitalUsd,
      })));
      return container;
    });
  } finally { act(() => root.unmount()); }
}

it("updates the rendered Best and headline for typed amounts and restores the explicit preview when unvalued", () => {
  withPicker((render) => {
    const small = render(tslaPayload, 100);
    const smallHeadline = small.querySelector('[data-testid="range-apr-headline"]')?.textContent;
    expect(small.querySelector('[data-testid="best-resolved"]')?.textContent).toBe("Tight");
    expect(small.textContent).toContain("For a ~$100 deposit");
    const larger = render(tslaPayload, 300);
    expect(larger.querySelector('[data-testid="best-resolved"]')?.textContent).toBe("Standard");
    expect(larger.querySelector('[data-testid="range-apr-headline"]')?.textContent).not.toBe(smallHeadline);
    expect(larger.textContent).toContain("For a ~$300 deposit");
    const preview = render(tslaPayload, null);
    expect(preview.querySelector('[data-testid="preset-best"]')).toBeNull();
    expect(preview.querySelector('[data-testid="lower-amount"]')).not.toBeNull();
    expect(preview.textContent).toContain("Preview assumes a ~$1,000 deposit");
    const unvalued = render(payloadFixture(), Number.NaN);
    expect(unvalued.textContent).toContain("Preview assumes a ~$1,000 deposit");
  });
});

it("renders the card's capped APR for Best rather than the uncapped server estimate", () => {
  const data = cardPayloadWithAprs({ micro: 100, tight: 80, standard: 60, wide: 40 });
  data.model.avgDailyVolumeUsd = 1000;
  const card = summarizeApr7d(data, "raydium-clmm", Date.parse(data.fetchedAt));
  expect(card.status).toBe("ready");
  if (card.status !== "ready") throw new Error("Expected ready card");
  expect(card.aprPct).toBeCloseTo(15.33, 9);
  withPicker((render) => {
    const view = render(data);
    expect(view.querySelector('[data-testid="range-apr-headline"]')?.textContent)
      .toBe(formatEstimate({ status: "ok", aprPct: card.aprPct, feesPerDayUsd: 0, inRangeVolumePct: 0 }));
    expect(view.querySelector('[data-testid="best-resolved"]')?.textContent).toBe("Wide");
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("uses the card's $1,000 preview for the initial Best and headline instead of the server's $100 basis", () => {
  const base = payloadFixture();
  const data = payloadForCapital({ ...base, model: { ...base.model, bins: base.model.bins.map((bin) => ({ ...bin, liquidity: 1e7 })), avgDailyVolumeUsd: 100_000 } }, 100);
  const card = summarizeApr7d(data, "raydium-clmm", Date.parse(data.fetchedAt));
  expect(card.status).toBe("ready");
  if (card.status !== "ready") throw new Error("Expected card APR");
  const selected = buildPresetList(OPEN_RANGE_UI_PRESETS, payloadForCapital(data, 1000)).best!.id;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(RangePresetPicker, {
      presets: OPEN_RANGE_UI_PRESETS, selected, onSelect: () => {}, minPrice: "", maxPrice: "",
      onMinPrice: () => {}, onMaxPrice: () => {}, apr: { status: "ready", data }, quotedRange: null,
    })));
    expect(container.querySelector('[data-testid="best-resolved"]')?.textContent).toBe(card.rangeLabel.split(" ")[0]);
    expect(container.querySelector('[data-testid="range-apr-headline"]')?.textContent)
      .toBe(formatEstimate({ status: "ok", aprPct: card.aprPct, feesPerDayUsd: 0, inRangeVolumePct: 0 }));
    expect(container.textContent).toContain("Preview assumes a ~$1,000 deposit");
  } finally { act(() => root.unmount()); }
});
