import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PoolActivityPanel } from "./pool-activity-panel";

describe("PoolActivityPanel", () => {
  it("renders nothing until a pool id is provided", () => {
    const markup = renderToStaticMarkup(createElement(PoolActivityPanel, {}));
    expect(markup).toBe("");
  });
});
