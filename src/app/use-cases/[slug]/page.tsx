import { notFound } from "next/navigation";
import { GuideArticle } from "@/components/guides/guide-article";
import { guideBySlug, guidesOfKind } from "@/lib/guides";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return guidesOfKind("use-case").map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const page = guideBySlug("use-case", (await params).slug);
  if (!page) return {};
  return pageMetadata({ title: page.metaTitle, description: page.metaDescription, path: page.path });
}

export default async function UseCasePage({ params }: { params: Promise<{ slug: string }> }) {
  const page = guideBySlug("use-case", (await params).slug);
  if (!page) notFound();
  return <GuideArticle page={page} />;
}
