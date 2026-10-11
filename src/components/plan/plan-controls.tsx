"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export type IntentField = "days" | "amount" | "lossAlert" | "exitAsset";

const TONES = {
  lilac: "bg-lilac",
  lemon: "bg-lemon",
  mint: "bg-mint",
  coral: "bg-coral",
  plain: "bg-ink/10",
  white: "bg-white",
} as const;

export type PillTone = keyof typeof TONES;

export function Pill({
  field,
  tone,
  active,
  onSelect,
  children,
}: {
  field: IntentField;
  tone: PillTone;
  active: boolean;
  onSelect: (field: IntentField) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-controls="plan-editor"
      onClick={() => onSelect(field)}
      className={cn(
        "mx-[0.06em] inline-flex max-w-full items-center gap-[0.22em] whitespace-nowrap rounded-full py-[0.04em] pl-[0.48em] pr-4 align-baseline outline-none transition-[box-shadow,translate] duration-200",
        "focus-visible:shadow-[0_0_0_3px_var(--color-ink)]",
        TONES[tone],
        active ? "-translate-y-[0.04em] shadow-[0_0_0_2.5px_var(--color-ink)]" : "hover:shadow-[0_0_0_1.5px_rgb(13_13_12/0.4)]",
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={2.5}
        className={cn("h-[0.42em] w-[0.42em] shrink-0 opacity-55 transition-transform duration-200", active && "rotate-180")}
      />
    </button>
  );
}

export function ValueField({
  label,
  prefix,
  unit,
  value,
  display,
  parse,
  onCommit,
}: {
  label: string;
  prefix?: string;
  unit: string;
  value: string;
  display: string;
  parse: (text: string) => string | null;
  onCommit: (value: string) => void;
}) {
  // Keeps the text as typed while it still describes the committed value; a change
  // made elsewhere (the ruler) replaces it with the formatted value.
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const editing = draft !== null && draft.base === value;
  const text = editing ? draft.text : display;
  const invalid = editing && parse(draft.text) !== value;
  const sizeText = (display || "0").length >= (text || "0").length ? display || "0" : text || "0";
  return (
    <label className="mt-1 flex items-baseline text-[clamp(3rem,7vw,5.25rem)] font-semibold leading-none tracking-[-0.045em]">
      {prefix && <span aria-hidden="true">{prefix}</span>}
      {/* Size to the formatted value so focus/blur does not shift the layout. */}
      <span className="inline-grid">
        <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre tabular-nums">
          {sizeText}
        </span>
        <input
          aria-label={label}
          aria-invalid={invalid}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          size={1}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            const parsed = parse(next);
            if (parsed === null) {
              setDraft({ text: next, base: value });
            } else {
              setDraft({ text: next, base: parsed });
              onCommit(parsed);
            }
          }}
          onBlur={() => setDraft(null)}
          className={cn(
            "col-start-1 row-start-1 w-full min-w-0 bg-transparent tabular-nums outline-none decoration-ink/25 decoration-2 underline-offset-[0.14em] focus:underline",
            invalid && "text-ink/40",
          )}
        />
      </span>
      <span className="ml-[0.3em] text-[0.3em] font-medium tracking-normal text-ink/55">{unit}</span>
    </label>
  );
}

export function OptionCard({
  selected,
  title,
  detail,
  onSelect,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex h-full flex-col rounded-[20px] border p-4 text-left outline-none transition-colors duration-200 focus-visible:shadow-[0_0_0_3px_var(--color-ink)]",
        selected ? "border-ink bg-ink text-cream" : "border-ink/20 hover:border-ink/60",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="text-lg font-semibold leading-tight tracking-[-0.02em]">{title}</span>
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-lemon bg-lemon text-ink" : "border-ink/30",
          )}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      </span>
      <span className={cn("mt-2 text-sm leading-snug", selected ? "text-cream/70" : "text-ink/65")}>{detail}</span>
    </button>
  );
}

export function Editor({
  eyebrow,
  note,
  children,
}: {
  eyebrow: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="animate-settle motion-reduce:animate-none">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
        <p className="font-data text-[11px] uppercase tracking-[0.14em] text-ink/60">{eyebrow}</p>
        {note && <p className="max-w-md text-sm leading-relaxed text-ink/65 sm:text-right">{note}</p>}
      </div>
      {children}
    </div>
  );
}
