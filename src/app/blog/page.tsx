import Link from "next/link";
import { BlogAppCta } from "@/components/blog/blog-shell";
import {
  articleCanonicalPath,
  blogIndexJsonLd,
  blogIndexMetadata,
  blogTimeProps,
  formatBlogDate,
  listBlogArticles,
  serializeJsonLd,
} from "@/lib/blog";

export const dynamic = "force-static";
export const metadata = blogIndexMetadata();

export default function BlogIndexPage() {
  const articles = listBlogArticles();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(blogIndexJsonLd(articles)) }}
      />
      <header className="mt-3 rounded-[28px] bg-cream p-6 text-ink sm:p-9">
        <span className="inline-flex h-6 items-center rounded-full border border-ink/70 px-2.5 font-data text-[10px] uppercase tracking-[0.14em]">
          Blog
        </span>
        <h1 className="mt-6 max-w-[16ch] text-[clamp(2.1rem,5vw,3.6rem)] font-medium leading-[1.02] tracking-[-0.04em]">
          Notes on on-chain market making
        </h1>
        <p className="mt-6 max-w-2xl border-t border-ink/20 pt-5 text-base leading-7 text-ink/70">
          Long-form writing from SoFinance. How AMMs evolved, what negative gamma costs an LP, and
          how same-stock pools fit on that map.
        </p>
      </header>

      <ul className="mt-3 grid gap-3">
        {articles.map((article) => (
          <li key={article.slug}>
            <article className="rounded-[28px] border border-white/12 bg-char p-6 sm:p-8">
              <p className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">
                <time {...blogTimeProps(article.datePublished)}>{formatBlogDate(article.datePublished)}</time>
              </p>
              <h2 className="mt-3 max-w-3xl text-[clamp(1.35rem,2.4vw,1.85rem)] font-medium leading-[1.2] tracking-[-0.03em]">
                <Link
                  href={articleCanonicalPath(article.slug)}
                  className="outline-none hover:text-lemon focus-visible:text-lemon"
                >
                  {article.title}
                </Link>
              </h2>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-smoke">{article.description}</p>
              <p className="mt-5">
                <Link
                  href={articleCanonicalPath(article.slug)}
                  className="text-sm font-semibold text-lemon underline-offset-2 hover:underline"
                >
                  Read article
                </Link>
              </p>
            </article>
          </li>
        ))}
      </ul>

      <BlogAppCta />
    </>
  );
}
