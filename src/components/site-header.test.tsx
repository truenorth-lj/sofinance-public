import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs" }));

import { SiteHeader } from "./site-header";
import { BlogShell } from "./blog/blog-shell";
import { DocsShell } from "./docs/docs-shell";
import FaqPage from "@/app/faq/page";
import TermsPage from "@/app/terms/page";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("SiteHeader", () => {
  it("links Pools to the homepage list (in-page on the homepage) and AI agents to the app's agent page", () => {
    const home = hrefs(renderToStaticMarkup(createElement(SiteHeader, { onHomepage: true })));
    expect(home).toEqual(expect.arrayContaining(["/", "#pools", "/app/ai", "/blog", "/app"]));
    const other = hrefs(renderToStaticMarkup(createElement(SiteHeader)));
    expect(other).toEqual(expect.arrayContaining(["/", "/#pools", "/app/ai", "/blog", "/app"]));
    expect(other).not.toContain("#pools");
    // The homepage has no agents section any more.
    expect([...home, ...other].some((href) => href?.endsWith("#agents"))).toBe(false);
  });

  it("is the header on the blog, docs, FAQ and terms pages, not the app bar", () => {
    const pages = {
      blog: createElement(BlogShell, null, "x"),
      docs: createElement(DocsShell, null, "x"),
      faq: createElement(FaqPage),
      terms: createElement(TermsPage),
    };
    for (const [name, el] of Object.entries(pages)) {
      const html = renderToStaticMarkup(el);
      expect(html, name).toContain('data-testid="site-header"');
      expect(html, name).not.toContain('aria-label="App"');
    }
  });

  it("the homepage renders SiteHeader and the app bar has no Blog tab", () => {
    expect(readFileSync(resolve("src/components/landing-page.tsx"), "utf8")).toContain("<SiteHeader onHomepage />");
    const nav = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(nav).not.toMatch(/label: "Blog"/);
  });
});
