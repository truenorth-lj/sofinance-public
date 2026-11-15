import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GUIDE_PAGES, guideAnswerText } from "@/lib/guides";

vi.mock("@/components/ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ink")>()),
  InkNav: () => null,
}));

import { GuideArticle } from "./guide-article";
import LearnIndexPage from "@/app/learn/page";

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const copyOf = (page: (typeof GUIDE_PAGES)[number]) =>
  [page.metaTitle, page.metaDescription, page.title, page.intro, ...page.qas.map((qa) => `${qa.question} ${guideAnswerText(qa)}`)].join("\n");

describe("guide pages", () => {
  for (const page of GUIDE_PAGES) {
    describe(page.path, () => {
      const html = renderToStaticMarkup(<GuideArticle page={page} />);
      const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"));
      const visible = decode(html.replace(/<script[\s\S]*?<\/script>/, ""));

      it("ships Article + FAQPage JSON-LD that matches the visible questions and answers", () => {
        const [article, faq] = jsonLd["@graph"];
        expect(article["@type"]).toBe("Article");
        expect(article.url).toBe(`https://sofinancelab.xyz${page.path}`);
        expect(faq["@type"]).toBe("FAQPage");
        expect(faq.mainEntity).toHaveLength(page.qas.length);
        for (const [index, qa] of page.qas.entries()) {
          expect(faq.mainEntity[index].name).toBe(qa.question);
          expect(faq.mainEntity[index].acceptedAnswer.text).toBe(guideAnswerText(qa));
          expect(visible).toContain(qa.question);
          for (const block of qa.blocks) {
            for (const text of block.kind === "p" ? [block.text] : block.items) expect(visible).toContain(text);
          }
        }
      });

      it("renders each question as an h2 that opens with a direct answer paragraph", () => {
        expect(html.match(/<h2 /g)?.length).toBe(page.qas.length);
        for (const qa of page.qas) {
          expect(qa.question.endsWith("?")).toBe(true);
          expect(qa.blocks[0]?.kind).toBe("p");
        }
      });

      it("keeps the public-copy rules", () => {
        const copy = copyOf(page);
        expect(copy).not.toMatch(/\byield|\bearn|passive income|backtest|收益|賺|零手續費|zero fees|free of fees/i);
        expect(copy.replaceAll("Fees not guaranteed", "")).not.toMatch(/guarantee/i);
        expect(copy).not.toMatch(/open[- ]source|github|fee wallet|airdrop|our token|Taiwan|[1-9A-HJ-NP-Za-km-z]{32,44}/i);
        expect(copy).not.toMatch(/SoFinance (auto-)?rebalances|automatically (moves|rebalances)/i);
        if (/APR|volume/.test(copy)) expect(copy).toContain("Fees not guaranteed");
        if (/compound/i.test(copy)) {
          expect(copy).toContain("Raydium and Meteora");
          expect(copy).toContain("Robinhood Chain positions have no compound");
        }
        if (/preset/i.test(copy)) expect(copy).toMatch(/7 days of fee data/);
      });
    });
  }

  it("lists every guide on /learn", () => {
    const html = renderToStaticMarkup(<LearnIndexPage />);
    for (const page of GUIDE_PAGES) expect(html).toContain(`href="${page.path}"`);
  });

  it("states pricing plainly on /fees", () => {
    const fees = GUIDE_PAGES.find((page) => page.path === "/fees")!;
    const copy = copyOf(fees);
    expect(copy).toContain("zero performance fee");
    expect(copy).toContain("0.10% only when a swap is made for you");
    expect(copy).toContain("Withdrawing as the two pool tokens costs 0");
    expect(copy).toContain("goes to the network, not to SoFinance");
  });
});
