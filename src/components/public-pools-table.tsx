import { GUIDE_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import {
  PUBLIC_POOLS_APR_COLUMN,
  PUBLIC_POOLS_H1,
  PUBLIC_POOLS_INTRO,
  publicPoolRows,
} from "@/lib/public-pools-table";

export const PUBLIC_POOLS_SSR_ID = "public-pools-ssr";

/**
 * Server-rendered pool table for crawlers and no-JS clients. Hidden after hydrate so the interactive list stays the
 * UI; the markup stays in the HTML for curl and AEO.
 */
export function PublicPoolsTable({ snapshot }: { snapshot: HomepagePoolsSnapshot | null }) {
  const rows = publicPoolRows(snapshot);
  return (
    <section
      id={PUBLIC_POOLS_SSR_ID}
      data-testid={PUBLIC_POOLS_SSR_ID}
      aria-labelledby="public-pools-heading"
      className="mx-auto max-w-[1280px] px-4 py-6 text-cream"
    >
      <h1 id="public-pools-heading" className="font-display text-2xl font-medium tracking-tight">
        {PUBLIC_POOLS_H1}
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-cream/80">{PUBLIC_POOLS_INTRO}</p>
      <p className="mt-2 text-sm">
        <a href={GUIDE_ROUTES.learn} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
          Learn
        </a>
        {" · "}
        <a href={DOCS_ROUTES.feeApr} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
          {HOMEPAGE_APR_DOCS_LINK_LABEL}
        </a>
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-cream/80">
          The live list is temporarily unavailable. The interactive list below loads when JavaScript is on.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-white/20">
                <th scope="col" className="py-2 pr-3 font-medium">Pool</th>
                <th scope="col" className="py-2 pr-3 font-medium">Chain</th>
                <th scope="col" className="py-2 pr-3 font-medium">DEX</th>
                <th scope="col" className="py-2 pr-3 font-medium">Fee tier</th>
                <th scope="col" className="py-2 pr-3 font-medium">TVL</th>
                <th scope="col" className="py-2 pr-3 font-medium">24h volume</th>
                <th scope="col" className="py-2 pr-3 font-medium">{PUBLIC_POOLS_APR_COLUMN}</th>
                <th scope="col" className="py-2 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-white/10">
                  <td className="py-2 pr-3">{row.pairLabel}</td>
                  <td className="py-2 pr-3">{row.chain}</td>
                  <td className="py-2 pr-3">{row.dex}</td>
                  <td className="py-2 pr-3">{row.feeTier}</td>
                  <td className="py-2 pr-3">{row.tvl}</td>
                  <td className="py-2 pr-3">{row.volume24h}</td>
                  <td className="py-2 pr-3">{row.apr7d}</td>
                  <td className="py-2">
                    <a href={row.href} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
                      Open pool
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
