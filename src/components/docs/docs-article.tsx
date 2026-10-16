import type { ReactNode } from "react";
import Link from "next/link";
import { InkHero } from "@/components/ink";
import { DOCS_PAGES, type DocsPage } from "@/lib/docs-nav";

export function DocsArticle({
  page,
  children,
}: {
  page: DocsPage;
  children: ReactNode;
}) {
  const index = DOCS_PAGES.findIndex((entry) => entry.href === page.href);
  const prev = index > 0 ? DOCS_PAGES[index - 1] : null;
  const next = index >= 0 && index < DOCS_PAGES.length - 1 ? DOCS_PAGES[index + 1] : null;

  return (
    <article>
      <InkHero label="Docs" title={page.title} stacked>
        <p>{page.description}</p>
      </InkHero>

      <div className="mt-3 space-y-3 rounded-[28px] border border-white/12 bg-char p-6 text-sm leading-7 text-cream/90 sm:p-8 [&_a]:text-lemon [&_a]:underline [&_a]:underline-offset-2 [&_a]:hover:text-[#fff27f] [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-[-0.02em] [&_h2]:text-cream [&_h2:first-child]:mt-0 [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_p+p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        {children}
      </div>

      <nav
        aria-label="Docs pagination"
        className="mt-3 flex flex-wrap items-stretch gap-3"
      >
        {prev ? (
          <Link
            href={prev.href}
            className="flex min-w-[12rem] flex-1 flex-col rounded-[28px] border border-white/12 bg-char px-5 py-4 outline-none transition-colors hover:border-white/30 focus-visible:border-lemon"
          >
            <span className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">Previous</span>
            <span className="mt-2 text-sm font-medium text-cream">{prev.label}</span>
          </Link>
        ) : (
          <span className="flex-1" />
        )}
        {next ? (
          <Link
            href={next.href}
            className="flex min-w-[12rem] flex-1 flex-col items-end rounded-[28px] border border-white/12 bg-char px-5 py-4 text-right outline-none transition-colors hover:border-white/30 focus-visible:border-lemon"
          >
            <span className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">Next</span>
            <span className="mt-2 text-sm font-medium text-cream">{next.label}</span>
          </Link>
        ) : null}
      </nav>
    </article>
  );
}
