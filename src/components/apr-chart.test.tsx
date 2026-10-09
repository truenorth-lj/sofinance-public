import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AprLineChart, AprSparkline } from "./apr-chart";

const END = 1_791_504_000;

describe("AprLineChart", () => {
  it("renders range toggles, honest title, and a path for contiguous points", () => {
    const markup = renderToStaticMarkup(
      createElement(AprLineChart, {
        title: "Daily fee APR",
        subtitle: "Pool fee APR (daily, estimated). Days without TVL are gaps.",
        nowSeconds: END,
        series: [
          {
            id: "pool",
            label: "Pool fee APR (daily, estimated)",
            stroke: "#e5e5e5",
            points: [
              { time: END - 3 * 86_400, value: 4 },
              { time: END - 2 * 86_400, value: 5 },
              { time: END - 86_400, value: 6 },
            ],
          },
        ],
      }),
    );
    expect(markup).toContain("Daily fee APR");
    expect(markup).toContain("7D");
    expect(markup).toContain("30D");
    expect(markup).toContain("90D");
    expect(markup).toContain("Pool fee APR (daily, estimated)");
    expect(markup).toContain("<path");
    expect(markup).not.toContain("&quot;");
  });

  it("shows an empty label when every point is a gap", () => {
    const markup = renderToStaticMarkup(
      createElement(AprLineChart, {
        title: "Daily fee APR",
        subtitle: "none",
        nowSeconds: END,
        emptyLabel: "No daily points in this range.",
        series: [{ id: "pool", label: "Pool", stroke: "#fff", points: [] }],
      }),
    );
    expect(markup).toContain("No daily points in this range.");
  });
});

describe("AprSparkline", () => {
  it("shows the last complete UTC day's date in the visible label and tooltip", () => {
    const now = END + 14 * 3600; // 2026-10-09 14:00 UTC
    const markup = renderToStaticMarkup(
      createElement(AprSparkline, {
        nowSeconds: now,
        label: "Pool fee APR (daily, estimated)",
        points: [
          { time: END - 2 * 86_400, date: "2026-10-07", value: 4.1 },
          { time: END - 86_400, date: "2026-10-08", value: 3.5 },
          { time: END, date: "2026-10-09", value: 0.25 },
        ],
      }),
    );
    expect(markup).toContain("<path");
    expect(markup).toContain("3.50% · 2026-10-08");
    expect(markup).toContain("last complete UTC day 2026-10-08: 3.50%");
    expect(markup).not.toContain("0.25%");
    expect(markup).toContain("Pool fee APR (daily, estimated)");
  });
});
