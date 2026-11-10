"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { OpenRangePreset, OpenRangeUiPreset } from "@sofinance/engine/open-range-presets";
import type { TickRange } from "@/lib/range-apr/selection";
import { RangePresetPicker } from "../range-apr/range-preset-picker";
import type { PoolRangeAprState } from "../range-apr/use-pool-range-apr";
import { OpenPositionChrome, OPEN_POSITION_SUBMIT } from "./open-position-chrome";

/** Shared subtitle: pair first, then the venue name. */
export function venueSubtitle(pairLabel: string, venueName: string): string {
  return `${pairLabel} · ${venueName}`;
}

export type OpenFormAsset = {
  id: string;
  label: string;
  disabled?: boolean;
};

export type OpenFormRange = {
  presets: readonly OpenRangeUiPreset[];
  selected: OpenRangePreset;
  onSelect: (preset: OpenRangePreset) => void;
  minPrice: string;
  maxPrice: string;
  onMinPrice: (value: string) => void;
  onMaxPrice: (value: string) => void;
  apr: PoolRangeAprState;
  quotedRange: TickRange | null;
  capitalUsd: number | null;
  showCustom: boolean;
  unavailable?: Partial<Record<OpenRangeUiPreset["id"], string>>;
};

/**
 * Venue-agnostic Create-position body (Raydium's look): input asset, amount + Max, range picker,
 * notes slot, and the Connect / submit CTA. Adapters supply the data; this file does not branch
 * on a protocol id.
 */
export function OpenPositionFormFields({
  assets,
  assetId,
  onAssetChange,
  assetSelectId = "open-input-asset",
  assetPlaceholder = "Select a token",
  assetDisabled = false,
  assetNote,
  amount,
  onAmountChange,
  amountInputId = "open-amount",
  amountDisabled = false,
  amountProblem,
  onFillMax,
  maxDisabled = false,
  range,
  rangeSlot,
  rangeHint,
  notes,
  connected,
  onConnect,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  submitTitle,
  submitBusy = false,
  submitBusyLabel,
  submitTestId,
  hideSubmit = false,
}: {
  assets: readonly OpenFormAsset[];
  assetId: string;
  onAssetChange: (id: string) => void;
  assetSelectId?: string;
  assetPlaceholder?: string;
  assetDisabled?: boolean;
  assetNote?: ReactNode;
  amount: string;
  onAmountChange: (value: string) => void;
  amountInputId?: string;
  amountDisabled?: boolean;
  amountProblem?: ReactNode;
  onFillMax: () => void;
  maxDisabled?: boolean;
  range?: OpenFormRange | null;
  rangeSlot?: ReactNode;
  rangeHint?: ReactNode;
  notes?: ReactNode;
  connected: boolean;
  onConnect: () => void;
  submitLabel: string;
  onSubmit: () => void;
  submitDisabled?: boolean;
  submitTitle?: string;
  submitBusy?: boolean;
  submitBusyLabel?: string;
  submitTestId?: string;
  hideSubmit?: boolean;
}) {
  return (
    <>
      <label className="block text-xs text-smoke" htmlFor={assetSelectId}>Input asset</label>
      <div className="relative mt-1">
        <select
          id={assetSelectId}
          className="w-full min-w-0 max-w-full appearance-none truncate rounded-2xl border border-white/20 bg-white/[0.06] py-2 pl-3 pr-12 text-base sm:text-sm text-cream disabled:opacity-60"
          value={assetId}
          disabled={assetDisabled}
          onChange={(event) => onAssetChange(event.target.value)}
        >
          {!assetId ? <option value="">{assetPlaceholder}</option> : null}
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id} disabled={asset.disabled}>{asset.label}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cream" aria-hidden="true" />
      </div>
      {assetNote}

      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs text-smoke" htmlFor={amountInputId}>Amount</label>
          <input
            id={amountInputId}
            className="mt-1 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-base sm:text-sm text-cream disabled:opacity-60"
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            disabled={amountDisabled}
          />
        </div>
        <button
          className="rounded-full border border-white/20 px-3 py-2 text-xs font-semibold text-cream/80 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onFillMax}
          type="button"
          disabled={maxDisabled}
        >
          Max
        </button>
      </div>
      {amountProblem}

      {range ? (
        <RangePresetPicker
          presets={range.presets}
          selected={range.selected}
          onSelect={range.onSelect}
          minPrice={range.minPrice}
          maxPrice={range.maxPrice}
          onMinPrice={range.onMinPrice}
          onMaxPrice={range.onMaxPrice}
          apr={range.apr}
          quotedRange={range.quotedRange}
          capitalUsd={range.capitalUsd}
          showCustom={range.showCustom}
          unavailable={range.unavailable}
        />
      ) : rangeSlot}

      {rangeHint}
      {notes}

      {hideSubmit ? null : !connected ? (
        <button type="button" onClick={onConnect} className={OPEN_POSITION_SUBMIT}>
          Connect wallet
        </button>
      ) : (
        <button
          type="button"
          disabled={submitDisabled}
          title={submitTitle}
          onClick={onSubmit}
          data-testid={submitTestId}
          className={OPEN_POSITION_SUBMIT}
        >
          {submitBusy ? (
            <span className="inline-flex items-center gap-2">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {submitBusyLabel ?? submitLabel}
            </span>
          ) : submitLabel}
        </button>
      )}
    </>
  );
}

/** Shared Create-position sheet: Raydium chrome plus the venue-agnostic form body. */
export function OpenPositionForm({
  labelledBy,
  pairLabel,
  venueName,
  explainer,
  closeLocked = false,
  onClose,
  wide = false,
  closeAriaLabel,
  children,
  ...fields
}: {
  labelledBy: string;
  pairLabel: string;
  venueName: string;
  explainer?: ReactNode;
  closeLocked?: boolean;
  onClose: () => void;
  wide?: boolean;
  closeAriaLabel?: string;
  children?: ReactNode;
} & Parameters<typeof OpenPositionFormFields>[0]) {
  return (
    <OpenPositionChrome
      labelledBy={labelledBy}
      subtitle={venueSubtitle(pairLabel, venueName)}
      explainer={explainer}
      closeLocked={closeLocked}
      onClose={onClose}
      wide={wide}
      closeAriaLabel={closeAriaLabel}
    >
      <OpenPositionFormFields {...fields} />
      {children}
    </OpenPositionChrome>
  );
}

const RANGE_CELL = "flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl border px-0.5 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream/70";
const RANGE_BAND = "text-[10px] tabular-nums text-smoke leading-3";

/** Robinhood Chain's on-chain range choices (±10 / ±30 / ±100 ticks). Same button grid as Raydium. */
export const RHC_TICK_PRESETS = [10, 30, 100] as const;

export function RhcRangeButtons({
  halfWidth, onChange, disabled = false,
}: {
  halfWidth: number;
  onChange: (ticks: number) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className="mt-4 flex items-center gap-1.5 text-xs text-smoke">
        <span>Price range (minimum ±10 ticks)</span>
      </div>
      <div className="mt-2 grid auto-cols-fr grid-flow-col gap-1.5 sm:gap-2" role="group" aria-label="Price range presets">
        {RHC_TICK_PRESETS.map((ticks) => {
          const active = halfWidth === ticks;
          return (
            <button
              key={ticks}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(ticks)}
              className={`${RANGE_CELL} ${active
                ? "border-cream bg-white/[0.08] text-cream"
                : "border-white/20 text-smoke hover:border-white/40 hover:text-cream/90"} disabled:cursor-not-allowed disabled:opacity-50`}
              data-testid={`rhc-preset-${ticks}`}
            >
              <span className="max-w-full truncate text-xs font-semibold leading-4">±{ticks} ticks</span>
              <span className={RANGE_BAND}>≈±{((1.0001 ** ticks - 1) * 100).toFixed(2)}%</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs" aria-live="polite">
        <p className="text-smoke">Est. fee APR · not a prediction</p>
        <p className="mt-2 flex h-7 items-center text-[1.75rem] font-medium leading-none tracking-[-0.035em] text-smoke" data-testid="range-apr-headline">—</p>
        <p className="mt-2 text-[11px] leading-5 text-smoke">Estimate unavailable right now. Creating a position is not affected.</p>
      </div>
    </>
  );
}
