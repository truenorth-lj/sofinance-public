import { notFound } from "next/navigation";
import { PublicPoolPage } from "@/components/public-pool-page";
import { aprLookupFrom, snapshotFailedToLoadAprs } from "@/lib/homepage-pools";
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
  // If the build-time APR fetch failed entirely, do not prerender every slug with "—".
  // dynamicParams + ISR will fill each page on first request once the snapshot cache is warm.
  // (Calling noStore() here would mark the whole route per-request dynamic.)
  if (snapshotFailedToLoadAprs(snapshot)) return [];
  // A partial APR map must not prerender the missing slugs with "—"; those pages would stay
  // stale until the next ISR refresh. Only slugs with a ready 7d APR are prerendered;
  // the rest (including genuine misses like ant-antx-meteora) fill on first request.
  const lookup = snapshot ? aprLookupFrom(snapshot.apr7d) : () => null;
  return listPublicPoolPageModels(snapshot)
    .filter((page) => lookup(page.pool) !== null)
    .map((page) => ({ slug: page.slug }));
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
