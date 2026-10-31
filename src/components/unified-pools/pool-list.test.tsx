// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SORT } from "@/lib/unified-pools/model";
import { solanaPool, type SolanaPoolRow } from "@/lib/unified-pools/rows";
import { PoolTable } from "./pool-list";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never) }));

const pool = solanaPool({
  poolAddress: "spcx-pool", mintA: "mint-w", mintB: "mint-p", symbolA: "SPCXx", symbolB: "SPCX", wrappedSymbol: "SPCXx", plainSymbol: "SPCX",
  feeTierBps: 1, tvlUsd: 256_900, volume24hUsd: 10_000, estimatedFeeAprPct: 12, freezeRisk: true, token2022A: true, token2022B: false,
  nameA: "SPCX xStock", nameB: "SPCX", wrapKind: "suffix-x",
} as unknown as SolanaPoolRow);

const render = () => {
  const html = renderToString(createElement(PoolTable, {
    pools: [pool], apr: { [pool.key]: { status: "ready", aprPct: 31.85 } } as never, sort: DEFAULT_SORT,
    actionFor: () => ({ kind: "link" as const, href: "/app/rwa-pairs?pool=spcx-pool&open=1" }),
  }));
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return doc;
};
const cls = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("PoolTable responsive layout (shared by the homepage and /app/rwa-pairs)", () => {
  it("below 768px keeps only Pool (with TVL under the name), Chain, Est. APR · 7d and Open, with no forced width", () => {
    const doc = render();
    const table = doc.querySelector("table")!;
    expect(cls(table)).toEqual(expect.arrayContaining(["min-w-[980px]", "max-md:min-w-0"]));
    const headers = [...doc.querySelectorAll("thead th")];
    const hiddenBelowMd = headers.filter((th) => cls(th).includes("max-md:hidden")).map((th) => th.textContent);
    expect(hiddenBelowMd).toEqual(["Protocol", "Est. fee APR 24h", "TVL", "24h vol", "Risk"]);
    const cells = [...doc.querySelectorAll("tbody tr td")];
    expect(cells.filter((td) => !cls(td).includes("max-md:hidden"))).toHaveLength(4);
    expect(cells.filter((td) => cls(td).includes("max-md:hidden"))).toHaveLength(5);
    // Not pinned below 768px (nothing scrolls sideways there); pinned from 768px up as before.
    expect(cls(cells[0]!)).toEqual(expect.arrayContaining(["sticky", "max-md:static"]));
    const tvl = doc.querySelector("[data-testid=tvl-narrow]")!;
    expect(tvl.textContent).toBe("TVL $256.9k");
    expect(cls(tvl)).toContain("md:hidden");
    expect(cells[3]!.querySelector("[data-testid=apr7d]")!.textContent).toBe("31.85%");
    // Icon-only Open below 768px; the label stays for screen readers and from 768px up.
    const open = cells[cells.length - 1]!.querySelector("a")!;
    expect(open.getAttribute("aria-label")).toBe("Open position in SPCXx/SPCX");
    expect(cls(open.querySelector("span"))).toContain("max-md:sr-only");
    expect(open.textContent).toBe("Open");
  });

  it("keeps every column and the sticky pool column from 768px up", () => {
    const doc = render();
    expect([...doc.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(
      ["Pool", "Chain", "Protocol", "Est. APR 7d", "Est. fee APR 24h", "TVL", "24h vol", "Risk", "Open"]);
    const row = doc.querySelector("tbody tr")!;
    expect(row.textContent).toContain("Raydium");
    expect(row.textContent).toContain("$10.0k");
    expect(row.textContent).toContain("Freeze risk");
  });
});
