"use client";

import { formatPositionLabel, type PositionLabelInput, type PositionLabelMetadata } from "../lib/position-label";

const DEFAULT_SELECT_CLASS =
  "w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream outline-none focus:border-white/40 disabled:opacity-50";

export function PositionSelect({
  id,
  label,
  labelSrOnly = false,
  value,
  onChange,
  disabled = false,
  positions,
  metadata,
  placeholder,
  className,
}: {
  id: string;
  label: string;
  labelSrOnly?: boolean;
  value: string;
  onChange: (positionMint: string) => void;
  disabled?: boolean;
  positions: PositionLabelInput[];
  metadata?: PositionLabelMetadata;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelSrOnly ? "sr-only" : "block text-xs text-smoke"}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={className ?? `${DEFAULT_SELECT_CLASS}${labelSrOnly ? "" : " mt-1"}`}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {positions.map((item) => (
          <option key={item.positionMint} value={item.positionMint}>
            {formatPositionLabel(item, metadata)}
          </option>
        ))}
      </select>
    </div>
  );
}
