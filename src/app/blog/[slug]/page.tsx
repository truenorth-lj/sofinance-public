import { notFound } from "next/navigation";
import { BlogArticleView } from "@/components/blog/blog-article-view";
import {
  blogArticleJsonLd,
  blogArticleMetadata,
  getBlogArticle,
  listBlogArticles,
  serializeJsonLd,
} from "@/lib/blog";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return listBlogArticles().map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getBlogArticle(slug);
  if (!article) return {};
  return blogArticleMetadata(article);
}

export default async function BlogArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getBlogArticle(slug);
  if (!article) notFound();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(blogArticleJsonLd(article)) }}
      />
      <BlogArticleView article={article} />
    </>
  );
}
