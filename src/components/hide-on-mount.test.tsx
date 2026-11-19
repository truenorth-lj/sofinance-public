import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HideOnMount } from "./hide-on-mount";

describe("HideOnMount", () => {
  it("server-renders its children so crawlers still see the markup", () => {
    const html = renderToStaticMarkup(
      createElement(
        HideOnMount,
        null,
        createElement("section", { id: "public-pools-ssr" }, createElement("h1", null, "Same-stock liquidity pools"), createElement("table", null)),
      ),
    );
    expect(html).toContain("id=\"public-pools-ssr\"");
    expect(html).toContain("Same-stock liquidity pools");
    expect(html).toContain("<table");
  });
});
