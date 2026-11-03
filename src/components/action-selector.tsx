"use client";
import type { ComponentType } from "react";
import { SELECT_CHEVRON_STYLE } from "./position-select";

export type ActionOption<T extends string> = { value: T; label: string; icon: ComponentType<{ className?: string }>; controls: string; disabled?: boolean;
  /** Greyed but clickable: the tool is not available for the selected position (its panel says why). */
  unavailable?: boolean };

/** Position actions: a themed native dropdown on mobile (below `sm`), pills on larger screens. */
export function ActionSelector<T extends string>({ options, value, onChange, label = "Position operations" }: {
  options: ActionOption<T>[]; value: T; onChange: (value: T) => void; label?: string;
}) {
  return <>
    <div className="mt-3 sm:hidden">
      <label htmlFor="position-action" className="sr-only">{label}</label>
      <select id="position-action" value={value} onChange={event => onChange(event.target.value as T)} style={SELECT_CHEVRON_STYLE}
        className="w-full rounded-full border border-white/12 bg-char px-5 py-3.5 text-base sm:text-sm font-semibold text-cream outline-none focus:border-lemon">
        {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.unavailable ? `${option.label} (not available)` : option.label}</option>)}
      </select>
    </div>
    <nav aria-label={label} className="mt-3 hidden gap-1.5 rounded-full border border-white/12 bg-char p-1.5 sm:flex">
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon, controls, disabled, unavailable }) =>
        <button key={optionValue} type="button" aria-pressed={value === optionValue} aria-controls={controls} disabled={disabled} data-unavailable={unavailable ? "true" : undefined} onClick={() => onChange(optionValue)}
          className={`flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-3 text-sm font-semibold transition-colors disabled:opacity-40 ${value === optionValue ? unavailable ? "bg-white/[0.08] text-cream/70 ring-1 ring-inset ring-white/25" : "bg-lemon text-ink" : unavailable ? "text-smoke/50 hover:text-smoke" : "text-smoke hover:text-cream/80"}`}>
          <Icon className="h-4 w-4" />{optionLabel}
        </button>)}
    </nav>
  </>;
}
