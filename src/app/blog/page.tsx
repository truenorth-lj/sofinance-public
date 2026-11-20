import Link from "next/link";
import { BlogAppCta } from "@/components/blog/blog-shell";
import { PageHeader } from "@/components/page-header";
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
      <PageHeader
        title="Notes on on-chain market making"
        subline="Long-form writing from SoFinance. How AMMs evolved, what negative gamma costs an LP, and how same-stock pools fit on that map."
      />

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
