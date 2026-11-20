import type { ReactNode } from "react";

/** One-line page title + optional subline. Same typography as /pools and /app/portfolio. */
export const PAGE_HEADER_TITLE_CLASS = "text-xl font-semibold text-cream sm:text-2xl";
export const PAGE_HEADER_SUBLINE_CLASS = "mt-1 text-sm text-smoke";

export function PageHeader({
  title,
  subline,
  eyebrow,
}: {
  title: string;
  /** Supporting line under the title. Wording is passed through unchanged. */
  subline?: ReactNode;
  /** Optional line above the title (e.g. blog date row). */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mt-5 px-1" data-testid="page-header">
      {eyebrow}
      <h1 className={eyebrow ? `mt-3 ${PAGE_HEADER_TITLE_CLASS}` : PAGE_HEADER_TITLE_CLASS}>{title}</h1>
      {subline !== undefined && subline !== null && subline !== "" ? (
        typeof subline === "string" || typeof subline === "number" ? (
          <p className={PAGE_HEADER_SUBLINE_CLASS}>{subline}</p>
        ) : (
          <div className={PAGE_HEADER_SUBLINE_CLASS}>{subline}</div>
        )
      ) : null}
    </div>
  );
}
