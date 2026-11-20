import { InkShell } from "@/components/ink";
import { PageHeader } from "@/components/page-header";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <InkShell>
      <SiteHeader />
      <PageHeader title="This page does not exist." subline="Try the homepage, or open the pool list." />
      <SiteFooter variant="marketing" />
    </InkShell>
  );
}
