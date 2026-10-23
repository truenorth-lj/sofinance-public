import Image from "next/image";
import Link from "next/link";
import { BlogMarkdown } from "@/components/blog/blog-markdown";
import { BlogAppCta } from "@/components/blog/blog-shell";
import {
  BLOG_ORGANIZATION,
  type BlogArticle,
  blogTimeProps,
  formatBlogDate,
  getPublicPngSize,
} from "@/lib/blog";
import { BLOG_ROUTES } from "@/lib/public-urls";

export function BlogArticleView({ article }: { article: BlogArticle }) {
  const heroSize = getPublicPngSize(article.hero.src);

  return (
    <>
      <article>
        <header className="mt-3 rounded-[28px] bg-cream p-6 text-ink sm:p-9">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
            <Link href={BLOG_ROUTES.home} className="hover:text-ink">
              Blog
            </Link>
            <span aria-hidden="true">·</span>
            <time {...blogTimeProps(article.datePublished)}>{formatBlogDate(article.datePublished)}</time>
            <span aria-hidden="true">·</span>
            <span>{BLOG_ORGANIZATION}</span>
          </p>
          <h1 className="mt-5 max-w-4xl text-[clamp(1.65rem,3.4vw,2.7rem)] font-medium leading-[1.12] tracking-[-0.035em]">
            {article.title}
          </h1>
          <p className="mt-5 max-w-3xl border-t border-ink/20 pt-5 text-base leading-7 text-ink/70">
            {article.description}
          </p>
        </header>

        <figure className="mt-3 overflow-hidden rounded-[28px] bg-char">
          <Image
            src={article.hero.src}
            alt={article.hero.alt}
            width={heroSize.width}
            height={heroSize.height}
            priority
            sizes="(max-width: 1280px) 100vw, 1280px"
            className="h-auto w-full"
          />
          <figcaption className="px-5 py-3 text-center font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
            {article.hero.alt}
          </figcaption>
        </figure>

        <div className="mx-auto mt-3 max-w-3xl rounded-[28px] border border-white/12 bg-char p-6 text-sm leading-7 text-cream/90 sm:p-10 [&_a]:text-lemon [&_a]:underline [&_a]:underline-offset-2 [&_a]:hover:text-[#fff27f]">
          <BlogMarkdown body={article.body} />
        </div>
      </article>
      <BlogAppCta />
    </>
  );
}
