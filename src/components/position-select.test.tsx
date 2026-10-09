import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatPositionLabel } from "../lib/position-label";
import { PositionSelect } from "./position-select";

const POSITION_MINT = "33333333333333333333333333333333";
const OTHER_MINT = "44444444444444444444444444444444";
const MINT_A = "11111111111111111111111111111111";
const MINT_B = "22222222222222222222222222222222";

const wrapPosition = {
  positionMint: POSITION_MINT,
  mintA: MINT_A,
  mintB: MINT_B,
  tickLower: 12,
  tickUpper: 16,
  rangeSide: "inside",
  decimalsA: 6,
  decimalsB: 6,
  feeTierBps: 1,
};

const outOfRangePosition = {
  positionMint: OTHER_MINT,
  mintA: MINT_A,
  mintB: MINT_B,
  tickLower: -20,
  tickUpper: -10,
  rangeSide: "above",
  decimalsA: 6,
  decimalsB: 6,
};

const metadata = { [MINT_A]: { symbol: "SPCXx" }, [MINT_B]: { symbol: "SPCX" } };

describe("PositionSelect", () => {
  it("renders shared readable labels for each option", () => {
    const markup = renderToStaticMarkup(
      createElement(PositionSelect, {
        id: "position",
        label: "Select Raydium position",
        labelSrOnly: true,
        value: POSITION_MINT,
        onChange: () => undefined,
        positions: [wrapPosition, outOfRangePosition],
        metadata,
      }),
    );
    expect(markup).toContain('id="position"');
    expect(markup).toContain("sr-only");
    expect(markup).toContain(formatPositionLabel(wrapPosition, metadata));
    expect(markup).toContain(formatPositionLabel(outOfRangePosition, metadata));
    expect(markup).not.toContain("ticks ");
    expect(markup).not.toContain("-20–-10");
  });

  it("keeps a placeholder option for the performance picker empty state", () => {
    const markup = renderToStaticMarkup(
      createElement(PositionSelect, {
        id: "perf-position",
        label: "Connected wallet positions",
        value: "",
        onChange: () => undefined,
        disabled: true,
        positions: [],
        placeholder: "Select a position NFT",
      }),
    );
    expect(markup).toContain("Connected wallet positions");
    expect(markup).toContain("Select a position NFT");
    expect(markup).toContain("disabled");
  });
});
