"use client";

import type { ReactNode } from "react";
import { CARD_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
import { cn } from "@/lib/cn";
import { dexDescriptors, uiFor } from "@/lib/dex/client";
import { volumeDivergenceNote } from "@/lib/apr-labels/volume-divergence";
import { HIGHEST_RANGE_COLUMN_LABEL, HIGHEST_RANGE_HELP } from "@/lib/range-apr/copy";
import { unavailableReasonText } from "@/lib/range-apr/format";
import { pairIssuerLabel } from "@/lib/rwa-pair-names";
import type { TokenIconMap } from "@/lib/token-icons/map";
import { planShareSymbol, pairLabelSymbols } from "@/lib/lp-plan-shares";
import { isLowTvl, PROTOCOL_LABELS, type UnifiedPool } from "@/lib/unified-pools/model";
import { InfoTip } from "../info-tip";
import { PairTokenIcons } from "../pair-token-icons";
import { dataDaysLabel, MIN_DATA_DAYS } from "@/lib/min-data-days";
import { shortAddress } from "@/lib/format/address";
import { APR7D_SHORT, Apr7dValue, newPoolTitle, rangeApr7dLabel, ChainBadge, chip, iconPair, LowTvlTag, money, OpenButton, type OpenAction } from "./pool-list";
import type { Apr7dState } from "./use-pools-apr7d";
import { chainMeta } from "./use-pool-sources";

/**
 * The card APR's ⓘ: what the number is ("Standard-range APR · 7d", or the new-pool / missing wording) on its first line,
 * then how it is estimated. The card shows no label line under the APR any more (Sophie, 2026-11-10); this is where it went.
 */
function AprTip({ label, children }: { label: string; children?: ReactNode }) {
  return <InfoTip label="About Est. highest range APR" tone="light">
    <span data-testid="apr7d-label" className="block font-semibold">{label}</span>
    {children ? <span className="mt-1 block">{children}</span> : null}
  </InfoTip>;
}

const cardEyebrow = "font-data text-[10px] uppercase tracking-[0.12em] text-ink/60";

/**
 * One pool as a cream card (the `/app/rwa-pairs` card fields, now for both chains): token icons and issuer names, the
 * estimated highest range APR (7-day) with the range it comes from ("Highest range", the same range the Create position
 * modal calls Best), when the data was updated, confidence and volume notes in the tooltip, then TVL, volume, fee and
 * fee tier (no 24h APR: the 7-day estimate is the only APR shown). "Plan this pool" follows the DEX's `plan` capability (greyed with its reason when unsupported;
 * Raydium, not in the DEX registry yet, keeps its link); Raydium pools also link the pool on Raydium.
 */
/**
 * Card pair name: always one line ("INTCx/INTC", never "INTCx/" over "INTC"), cut with "…" if it is ever too wide (the
 * full name is the title). The narrowest cards (phones, and the three-column grid below 2xl) use a smaller name and icons.
 */

export function PoolCard({ pool, apr, action, icons, onCalculate }: {
  pool: UnifiedPool; apr: Apr7dState | undefined; action: OpenAction; icons: TokenIconMap | undefined;
  /** Opens the share calculator over the list (only offered where the DEX's `plan` capability is supported). */
  onCalculate: () => void;
}) {
  const ready = apr?.status === "ready" ? apr : null;
  const volumeNote = ready ? volumeDivergenceNote(pool.volume24hUsd, ready.avgDailyVolumeUsd) : null;
  const withVolumeNote = (text: string) => (volumeNote ? `${text} ${volumeNote}` : text);
  const freshness = apr && apr.status !== "loading" ? apr.freshness : undefined;
  const ui = uiFor(pool.protocol);
  const chain = chainMeta(pool.chain);
  const externalUrl = ui.externalPoolUrl?.(pool.poolAddress);
  // Registered DEXes say through their `plan` capability; Raydium (not in the DEX registry yet) keeps its link.
  const plan = dexDescriptors.descriptorFor(pool.protocol)?.capabilities.plan ?? (ui.planFallback ?? null);
  // Stock pools count shares; the stablecoin pool has no stock, so its button just says Calculate.
  const calcLabel = planShareSymbol(pairLabelSymbols(pool.pairLabel)) ? "Calculate shares" : "Calculate";
  return <li className="flex min-w-0 flex-col rounded-[28px] bg-cream p-6 text-ink" data-pool={pool.key}>
    <div className="flex flex-wrap items-center gap-1.5"><ChainBadge chain={pool.chain} /><span className={cn(chip, "border border-ink/25")}>{PROTOCOL_LABELS[pool.protocol]}</span>
      {isLowTvl(pool) && apr?.status !== "new" && <LowTvlTag tone="light" />}</div>
    <div className="mt-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3 max-sm:gap-2 xl:max-2xl:gap-2">
        <PairTokenIcons pair={iconPair(pool)} icons={icons} chain={pool.chain} iconClassName="h-10 w-10 max-sm:h-8 max-sm:w-8 xl:max-2xl:h-8 xl:max-2xl:w-8" />
        <div className="min-w-0">
          <h3 className="truncate whitespace-nowrap text-xl font-medium max-sm:text-lg xl:max-2xl:text-lg leading-tight tracking-[-0.02em]" title={pool.pairLabel} data-testid="pool-card-name">{pool.pairLabel}</h3>
          <p className="truncate text-xs text-ink/65" title={`${pool.nameA} / ${pool.nameB}`}>{pairIssuerLabel(pool.nameA, pool.nameB)}</p>
        </div>
      </div>
      {/* The APR pill with its ⓘ beside it on one row; what the number is lives in the ⓘ, not in a label line. */}
      <div className="flex shrink-0 items-center gap-1.5" data-testid="apr7d-row">
        <Apr7dValue state={apr} />
        {ready ? <AprTip label={rangeApr7dLabel(ready.rangeLabel)}>
          {withVolumeNote(CARD_RANGE_APR_7D_HELP)}{ready.lowConfidence ? " Low confidence for this pool: thin or patchy recent trading." : ""}
        </AprTip>
          : apr?.status === "new" ? <AprTip label={dataDaysLabel(apr.days)}>{newPoolTitle(apr.days)}</AprTip>
          : apr?.status === "missing" ? <AprTip label={APR7D_SHORT}>{apr.degraded ? `${unavailableReasonText("degraded-data")}.` : apr.reason}</AprTip>
          : <AprTip label={APR7D_SHORT} />}
      </div>
    </div>
    {apr?.status === "missing" && <p className="mt-2 text-xs text-ink/60">{apr.reason}</p>}
    {apr?.status === "new" && <p className="mt-2 text-xs text-ink/60" data-testid="apr7d-new-note">
      Too new for an APR: it shows once the pool has {MIN_DATA_DAYS} days of data.</p>}
    {/* No "Updated …" time on the card; only a late snapshot says so (its time in the title, like the table). */}
    {freshness?.delayed && <p className="mt-2 text-xs text-ink/60" data-testid="apr-delayed"
      title={`Snapshot from ${new Date(freshness.snapshotAt).toLocaleString()}`}>Data delayed</p>}
    {chain?.showHighestRange && <div className="mt-4">
      <p className={cn("flex items-center gap-1", cardEyebrow)}>
        {HIGHEST_RANGE_COLUMN_LABEL}
        {ready && <InfoTip label="About Highest range" placement="above" tone="light">{HIGHEST_RANGE_HELP}</InfoTip>}
      </p>
      <span data-testid="highest-range" className={cn("mt-1.5 inline-block max-w-full truncate rounded-full px-3 py-1 align-top text-sm font-medium", ready ? "bg-lilac" : "bg-ink/10")}>
        {ready ? ready.rangeLabel : apr?.status === "missing" || apr?.status === "new" ? "—" : "…"}
      </span>
    </div>}
    <dl className="mt-5 grid grid-cols-3 gap-x-4 gap-y-4 border-t border-ink/20 pt-4">
      <div><dt className={cardEyebrow}>TVL</dt><dd className="mt-1 font-semibold tabular-nums">{money(pool.tvlUsd)}</dd></div>
      <div><dt className={cardEyebrow}>24h vol</dt><dd className="mt-1 font-semibold tabular-nums">{money(pool.volume24hUsd)}</dd></div>
      <div><dt className={cardEyebrow}>Fee</dt><dd className="mt-1 font-semibold tabular-nums">{pool.feeTierBps === null ? (chain?.nullFeeLabel ?? "—") : `${pool.feeTierBps} bps`}</dd></div>
    </dl>
    <div className="mt-auto flex flex-wrap items-center gap-3 pt-5">
      <OpenButton action={action} label={pool.pairLabel} />
      {/* `border-beam` (globals.css): a quiet streak of light circling the border; still for reduced motion. */}
      {plan?.supported && <button type="button" onClick={onCalculate} aria-haspopup="dialog" aria-label={`${calcLabel} for ${pool.pairLabel}`}
        className="border-beam inline-flex h-11 items-center rounded-full border border-ink/25 px-4 text-sm font-semibold outline-none transition-colors hover:border-ink/60 focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]">
        {calcLabel}
      </button>}
      {plan && !plan.supported && <span aria-disabled="true" title={plan.reason} data-testid="plan-unavailable"
        className="inline-flex h-11 cursor-not-allowed items-center rounded-full border border-ink/15 px-4 text-sm font-semibold text-ink/40">
        {calcLabel}<span className="sr-only">: {plan.reason}</span>
      </span>}
      {externalUrl
        ? <a href={externalUrl} target="_blank" rel="noreferrer" title={`Open pool ${pool.poolAddress} on Raydium`}
          className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/60 underline underline-offset-2 outline-none hover:text-ink focus-visible:text-ink">
          {shortAddress(pool.poolAddress)}</a>
        : <span className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/55" title={pool.poolAddress}>{shortAddress(pool.poolAddress)}</span>}
    </div>
  </li>;
}
