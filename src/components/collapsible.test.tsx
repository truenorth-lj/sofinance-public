import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Collapsible } from "./collapsible";

describe("Collapsible", () => {
  it("is open with full-height rows and reachable content", () => {
    const html = renderToStaticMarkup(<Collapsible open testId="c"><p>rows</p></Collapsible>);
    expect(html).toContain('data-open="true"');
    expect(html).toContain("grid-rows-[1fr]");
    expect(html).not.toContain("inert");
    expect(html).toContain("motion-reduce:transition-none");
  });
  it("folds to zero height and takes its content out of reach when closed", () => {
    const html = renderToStaticMarkup(<Collapsible open={false} testId="c"><p>rows</p></Collapsible>);
    expect(html).toContain('data-open="false"');
    expect(html).toContain("grid-rows-[0fr]");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/inert(=""|\b)/);
  });
});
