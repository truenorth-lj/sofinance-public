import { GuideArticle } from "@/components/guides/guide-article";
import { guideBySlug } from "@/lib/guides";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-static";

const page = guideBySlug("pricing", "fees")!;

export const metadata = pageMetadata({ title: page.metaTitle, description: page.metaDescription, path: page.path });

export default function PricingPage() {
  return <GuideArticle page={page} />;
}
