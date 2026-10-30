import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FAQ_ITEMS, FAQ_SECTIONS } from "@/lib/faq";

vi.mock("@/components/ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ink")>()),
  InkNav: () => null,
}));

import FaqPage from "./page";

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("/faq", () => {
  const html = renderToStaticMarkup(<FaqPage />);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"));

  it("ships FAQPage JSON-LD that matches the visible questions and answers exactly", () => {
    expect(jsonLd["@type"]).toBe("FAQPage");
    expect(jsonLd.url).toBe("https://sofinancelab.xyz/faq");
    expect(jsonLd.mainEntity).toHaveLength(FAQ_ITEMS.length);
    const visible = decode(html.replace(/<script[\s\S]*?<\/script>/, ""));
    for (const [index, item] of FAQ_ITEMS.entries()) {
      expect(jsonLd.mainEntity[index]).toEqual({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      });
      expect(visible).toContain(item.question);
      expect(visible).toContain(item.answer);
    }
    expect(FAQ_SECTIONS.length).toBe(3);
  });

  it("covers Robinhood Chain and keeps the public-copy rules", () => {
    const copy = FAQ_ITEMS.map((item) => `${item.question} ${item.answer}`).join("\n");
    expect(copy).toContain("Robinhood Chain");
    expect(copy).toContain("Uniswap v4");
    expect(copy).toContain("11 Uniswap v4 pools");
    expect(copy).not.toMatch(/\byield|\bearn/i);
    expect(copy).not.toMatch(/open[- ]source|github|Turnkey|0-SOL|zero[- ]SOL|fee wallet|Taiwan|prototype/i);
    expect(copy.replaceAll("0.10%", "")).not.toMatch(/\d\s*%/); // only the fixed 0.10% fee, never an APR figure
    expect(copy).not.toContain("yield-and-apr");
  });

  it("is a static page", () => {
    expect(readFileSync(resolve("src/app/faq/page.tsx"), "utf8")).toContain('export const dynamic = "force-static"');
  });
});
