import { InkHero, InkShell } from "@/components/ink";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <InkShell>
      <SiteHeader />
      <InkHero label="Missing page" title="This page does not exist.">Try the homepage, or open the pool list.</InkHero>
      <SiteFooter variant="marketing" />
    </InkShell>
  );
}
