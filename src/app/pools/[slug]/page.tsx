import { notFound } from "next/navigation";
import { PublicPoolPage } from "@/components/public-pool-page";
import { loadHomepagePoolsSnapshot } from "@/lib/homepage-pools-snapshot";
import { serializeJsonLd } from "@/lib/json-ld";
import {
  findPublicPoolPageModel,
  listPublicPoolPageModels,
  publicPoolJsonLd,
  publicPoolMetadata,
} from "@/lib/public-pool-pages";

/** Same window as the cached homepage / /app/rwa-pairs snapshot. No per-request RPC. */
export const revalidate = 900;
export const dynamicParams = true;

type PageProps = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const snapshot = await loadHomepagePoolsSnapshot();
  return listPublicPoolPageModels(snapshot).map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const model = findPublicPoolPageModel(await loadHomepagePoolsSnapshot(), slug);
  if (!model) return { title: "Pool not found" };
  return publicPoolMetadata(model);
}

export default async function PublicPoolSlugPage({ params }: PageProps) {
  const { slug } = await params;
  const model = findPublicPoolPageModel(await loadHomepagePoolsSnapshot(), slug);
  if (!model) notFound();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(publicPoolJsonLd(model)) }} />
      <PublicPoolPage model={model} />
    </>
  );
}
