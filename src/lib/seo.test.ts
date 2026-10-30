import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { getCanonicalSiteUrl } from "@/lib/public-urls";
import { OG_IMAGE, SITE_TITLE_TEMPLATE } from "@/lib/seo";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn }));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: vi.fn() }));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font", className: "font" });
  return { Geist_Mono: font, Host_Grotesk: font };
});

type Page = { path: string; load: () => Promise<{ metadata: Metadata }> };

const PAGES: Page[] = [
  { path: "/", load: () => import("@/app/page") },
  { path: "/app/rwa-pairs", load: () => import("@/app/app/rwa-pairs/layout") },
  { path: "/faq", load: () => import("@/app/faq/page") },
  { path: "/docs", load: () => import("@/app/docs/page") },
  { path: "/docs/fee-apr", load: () => import("@/app/docs/fee-apr/page") },
  { path: "/docs/risks", load: () => import("@/app/docs/risks/page") },
  { path: "/docs/fees", load: () => import("@/app/docs/fees/page") },
  { path: "/docs/withdraw", load: () => import("@/app/docs/withdraw/page") },
  { path: "/docs/security", load: () => import("@/app/docs/security/page") },
];

const titleText = (title: Metadata["title"]) =>
  typeof title === "string" ? SITE_TITLE_TEMPLATE.replace("%s", title) : (title as { absolute: string }).absolute;

describe("public page metadata", () => {
  it("covers every docs page", () => {
    expect(PAGES.filter((page) => page.path.startsWith("/docs")).map((page) => page.path).sort()).toEqual(
      DOCS_PAGES.map((page) => page.href).sort(),
    );
  });

  it.each(PAGES)("$path has its own title, description, canonical, OG and Twitter card", async ({ path, load }) => {
    const { metadata } = await load();
    const title = titleText(metadata.title);
    expect(title.length).toBeGreaterThan(10);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.match(/SoFinance/g) ?? []).toHaveLength(1);
    expect(metadata.description?.length ?? 0).toBeGreaterThanOrEqual(70);
    expect(metadata.description?.length ?? 0).toBeLessThanOrEqual(170);
    expect(metadata.alternates?.canonical).toBe(path);
    expect(metadata.openGraph).toMatchObject({ url: path, siteName: "SoFinance", images: [OG_IMAGE] });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", site: "@SoFinancelab", images: [OG_IMAGE.url] });
    const copy = `${title} ${metadata.description}`;
    expect(copy).not.toMatch(/\byield\b|\bearn/i);
    expect(copy).not.toMatch(/\d+(\.\d+)?\s*%/); // no APR figure as a promise
  });

  it("gives every page a different title and description", async () => {
    const all = await Promise.all(PAGES.map((page) => page.load()));
    const titles = all.map(({ metadata }) => titleText(metadata.title));
    const descriptions = all.map(({ metadata }) => metadata.description);
    expect(new Set(titles).size).toBe(PAGES.length);
    expect(new Set(descriptions).size).toBe(PAGES.length);
  });

  it("keeps the title template for pages under /app", async () => {
    const { metadata } = await import("@/app/app/layout");
    expect(metadata.title).toEqual({ default: "App", template: SITE_TITLE_TEMPLATE });
  });

  it("sets metadataBase and the title template site-wide", async () => {
    const { metadata } = await import("@/app/layout");
    expect(metadata.metadataBase?.toString()).toBe(`${getCanonicalSiteUrl()}/`);
    expect(metadata.title).toMatchObject({ template: SITE_TITLE_TEMPLATE });
    expect(metadata.openGraph).toMatchObject({ images: [OG_IMAGE] });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });
});
