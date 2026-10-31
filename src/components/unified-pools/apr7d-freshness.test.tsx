// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { summarizeApr7d } from "@/lib/unified-pools/apr7d";
import { DEFAULT_SORT } from "@/lib/unified-pools/model";
import { solanaPool, type SolanaPoolRow } from "@/lib/unified-pools/rows";
import { Apr7dValue, PoolTable } from "./pool-list";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never) }));

const H = 3_600_000;
const SNAPSHOT = "2026-10-30T11:03:00.000Z";
const at = (hours: number) => Date.parse(SNAPSHOT) + hours * H;
const payload = (overrides: { priceHistoryStale?: boolean; volumeObservedAt?: string } = {}) => {
  const value = payloadFixture({ freshness: { snapshotAt: SNAPSHOT, chainObservedAt: SNAPSHOT, volumeObservedAt: overrides.volumeObservedAt ?? SNAPSHOT, stale: false } });
  if (overrides.priceHistoryStale) value.sample.priceHistoryStale = true;
  return value;
};
const pool = solanaPool({
  poolAddress: "spcx-pool", mintA: "mint-w", mintB: "mint-p", symbolA: "SPCXx", symbolB: "SPCX", wrappedSymbol: "SPCXx", plainSymbol: "SPCX",
  feeTierBps: 1, tvlUsd: 256_900, volume24hUsd: 10_000, estimatedFeeAprPct: 12, freezeRisk: true, token2022A: true, token2022B: false,
  nameA: "SPCX xStock", nameB: "SPCX", wrapKind: "suffix-x",
} as unknown as SolanaPoolRow);
const cell = (nowMs: number, value = payload()) => {
  const html = renderToString(createElement(PoolTable, {
    pools: [pool], apr: { [pool.key]: summarizeApr7d(value, "raydium-clmm", nowMs) }, sort: DEFAULT_SORT,
    actionFor: () => ({ kind: "none" as const, reason: "" }),
  }));
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const apr = doc.querySelector("[data-testid=apr7d]")!;
  return { text: apr.textContent, status: apr.getAttribute("data-apr-status"), delayed: doc.querySelector("[data-testid=apr7d-delayed]")?.textContent ?? null };
};

describe("7d APR column freshness (homepage top 5 and /app/rwa-pairs share PoolTable)", () => {
  it("fresh (under 26h): the number, no label", () => {
    const shown = cell(at(2));
    expect(shown.status).toBe("ready");
    expect(shown.text).toMatch(/%$/);
    expect(shown.delayed).toBeNull();
  });
  it("26h to 48h: the number plus 'Data delayed'", () => {
    for (const hours of [26.5, 36, 47.5]) {
      const shown = cell(at(hours));
      expect(shown.status).toBe("ready");
      expect(shown.text).toMatch(/%$/);
      expect(shown.delayed).toBe("Data delayed");
    }
  });
  it("over 48h: '—'", () => {
    const shown = cell(at(48.5));
    expect(shown).toMatchObject({ status: "missing", text: "—", delayed: null });
  });
  it("a fresh run that fell back to saved price history (a 429) shows the number plus 'Data delayed'", () => {
    const snapshot = payloadFixture({ freshness: { snapshotAt: "2026-10-31T14:36:00.000Z", chainObservedAt: "2026-10-31T14:36:00.000Z", volumeObservedAt: SNAPSHOT, stale: true } });
    snapshot.sample.priceHistoryStale = true;
    expect(cell(Date.parse("2026-10-31T14:40:00Z"), snapshot)).toMatchObject({ status: "ready", delayed: "Data delayed" });
    // ...and expires 48h after the saved candles, not after the new chain read.
    expect(cell(at(48.5), snapshot)).toMatchObject({ status: "missing", text: "—" });
  });
  it("the cards (lg) keep their own 'Updated … · Data delayed' line and add no second label", () => {
    const html = renderToString(createElement(Apr7dValue, { state: summarizeApr7d(payload(), "raydium-clmm", at(30)) }));
    expect(html).not.toContain("apr7d-delayed");
  });
});
