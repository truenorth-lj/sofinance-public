"use client";

import { formatPositionLabel, type PositionLabelInput, type PositionLabelMetadata } from "../lib/position-label";

const DEFAULT_SELECT_CLASS =
  "w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600 disabled:opacity-50";

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
      <label htmlFor={id} className={labelSrOnly ? "sr-only" : "block text-xs text-neutral-400"}>
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
