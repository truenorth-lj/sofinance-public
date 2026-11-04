import Link from "next/link";
import { DOCS_ROUTES, FAQ_ROUTE, LEGAL_ROUTES } from "@/lib/public-urls";

const footerLink = "transition-colors hover:text-cream";

/** App-page footer: Docs (out of the top nav since 11/4), FAQ, Risks, Terms. Same type as the landing-page footer. */
export function InkFooter() {
  return (
    <footer className="mt-6 flex flex-wrap items-center gap-5 px-2 py-6 font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
      <Link href={DOCS_ROUTES.home} className={footerLink}>Docs</Link>
      <Link href={FAQ_ROUTE} className={footerLink}>FAQ</Link>
      <Link href={DOCS_ROUTES.risks} className={footerLink}>Risks</Link>
      <Link href={LEGAL_ROUTES.terms} className={footerLink}>Terms</Link>
    </footer>
  );
}
