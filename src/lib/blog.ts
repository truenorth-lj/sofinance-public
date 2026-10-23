import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Metadata } from "next";
import { BLOG_ROUTES, blogArticlePath, CANONICAL_SITE_URL, getCanonicalSiteUrl } from "@/lib/public-urls";

/** Publisher / author for every article. Never a person's name. */
export const BLOG_ORGANIZATION = "SoFinance";

const CONTENT_DIR = join(process.cwd(), "content/blog");
const PUBLIC_DIR = join(process.cwd(), "public");
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export type BlogHero = {
  src: string;
  alt: string;
};

export type BlogImageSize = {
  width: number;
  height: number;
};

export type BlogArticle = {
  slug: string;
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  hero: BlogHero;
  body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, file: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${file}: ${label} is required`);
  }
  return value.trim();
}

function requireDate(value: unknown, label: string, file: string): string {
  const date = requireString(value, label, file);
  if (!ISO_DATE.test(date)) {
    throw new Error(`${file}: ${label} must be YYYY-MM-DD`);
  }
  return date;
}

function parseHero(value: unknown, file: string): BlogHero {
  if (!isRecord(value)) throw new Error(`${file}: hero is required`);
  const src = requireString(value.src, "hero.src", file);
  const alt = requireString(value.alt, "hero.alt", file);
  if (!src.startsWith("/blog/")) {
    throw new Error(`${file}: hero.src must be a /blog/ public path`);
  }
  return { src, alt };
}

function parseArticleFile(filename: string): BlogArticle {
  const slug = filename.replace(/\.(md|mdx)$/, "");
  if (!SLUG.test(slug)) {
    throw new Error(`${filename}: slug must be lowercase kebab-case`);
  }

  const raw = readFileSync(join(CONTENT_DIR, filename), "utf8");
  const { data, content } = matter(raw);

  if (!isRecord(data)) throw new Error(`${filename}: frontmatter is required`);
  if ("author" in data) {
    throw new Error(`${filename}: do not set author; articles are published by ${BLOG_ORGANIZATION}`);
  }

  const title = requireString(data.title, "title", filename);
  const description = requireString(data.description, "description", filename);
  const datePublished = requireDate(data.datePublished, "datePublished", filename);
  const dateModified = requireDate(data.dateModified ?? data.datePublished, "dateModified", filename);
  const hero = parseHero(data.hero, filename);

  return {
    slug,
    title,
    description,
    datePublished,
    dateModified,
    hero,
    body: content.trim(),
  };
}

export function listBlogFilenames(): string[] {
  return readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith(".md") || name.endsWith(".mdx"))
    .sort();
}

export function listBlogArticles(): BlogArticle[] {
  return listBlogFilenames()
    .map(parseArticleFile)
    .sort((a, b) => {
      const byDate = b.datePublished.localeCompare(a.datePublished);
      return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug);
    });
}

export function getBlogArticle(slug: string): BlogArticle | null {
  return listBlogArticles().find((article) => article.slug === slug) ?? null;
}

/** HTML time attributes are lowercase; React's dateTime prop can leak through RSC. */
export function blogTimeProps(isoDate: string): { datetime: string } {
  return { datetime: isoDate };
}

export function formatBlogDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const monthName = MONTHS[(month ?? 0) - 1];
  if (!year || !monthName || !day) {
    throw new Error(`Invalid blog date: ${isoDate}`);
  }
  return `${monthName} ${day}, ${year}`;
}

export function absoluteUrl(path: string, base = getCanonicalSiteUrl()): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return path === "/" ? base : `${base}${path}`;
}

/** Sync PNG size from the on-disk file so next/image can reserve layout. */
export function getPublicPngSize(src: string): BlogImageSize {
  if (!src.startsWith("/")) {
    throw new Error(`Image src must be a root-relative public path: ${src}`);
  }
  const file = join(PUBLIC_DIR, src.slice(1));
  const buf = readFileSync(file);
  if (buf.length < 24 || buf.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`Not a PNG: ${src}`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function blogIndexPath(): string {
  return BLOG_ROUTES.home;
}

export function articleCanonicalPath(slug: string): string {
  return blogArticlePath(slug);
}

export function blogArticleMetadata(article: BlogArticle): Metadata {
  const canonical = absoluteUrl(articleCanonicalPath(article.slug));
  const image = absoluteUrl(article.hero.src);
  const size = getPublicPngSize(article.hero.src);

  return {
    title: `${article.title} · SoFinance`,
    description: article.description,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: article.title,
      description: article.description,
      url: canonical,
      siteName: BLOG_ORGANIZATION,
      locale: "en_US",
      images: [
        {
          url: image,
          alt: article.hero.alt,
          width: size.width,
          height: size.height,
        },
      ],
      publishedTime: article.datePublished,
      modifiedTime: article.dateModified,
      authors: [BLOG_ORGANIZATION],
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
      images: [image],
    },
  };
}

export function blogIndexMetadata(): Metadata {
  const canonical = absoluteUrl(BLOG_ROUTES.home);
  return {
    title: "Blog · SoFinance",
    description:
      "Long-form notes from SoFinance on on-chain market making, concentrated liquidity, and tokenized-stock pools.",
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: "Blog · SoFinance",
      description:
        "Long-form notes from SoFinance on on-chain market making, concentrated liquidity, and tokenized-stock pools.",
      url: canonical,
      siteName: BLOG_ORGANIZATION,
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: "Blog · SoFinance",
      description:
        "Long-form notes from SoFinance on on-chain market making, concentrated liquidity, and tokenized-stock pools.",
    },
  };
}

type JsonLd = Record<string, unknown>;

export function blogArticleJsonLd(article: BlogArticle): JsonLd {
  const canonical = absoluteUrl(articleCanonicalPath(article.slug));
  const image = absoluteUrl(article.hero.src);
  const organization = {
    "@type": "Organization",
    name: BLOG_ORGANIZATION,
    url: CANONICAL_SITE_URL,
  };

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        headline: article.title,
        description: article.description,
        image,
        datePublished: article.datePublished,
        dateModified: article.dateModified,
        author: organization,
        publisher: organization,
        mainEntityOfPage: {
          "@type": "WebPage",
          "@id": canonical,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: CANONICAL_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Blog", item: absoluteUrl(BLOG_ROUTES.home) },
          { "@type": "ListItem", position: 3, name: article.title, item: canonical },
        ],
      },
    ],
  };
}

export function blogIndexJsonLd(articles: BlogArticle[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "SoFinance Blog",
    url: absoluteUrl(BLOG_ROUTES.home),
    publisher: {
      "@type": "Organization",
      name: BLOG_ORGANIZATION,
      url: CANONICAL_SITE_URL,
    },
    blogPost: articles.map((article) => ({
      "@type": "BlogPosting",
      headline: article.title,
      description: article.description,
      datePublished: article.datePublished,
      url: absoluteUrl(articleCanonicalPath(article.slug)),
    })),
  };
}

export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
