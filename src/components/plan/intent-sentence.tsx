"use client";

import { useState, type ReactNode } from "react";
import Decimal from "decimal.js";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { parseDays, parseUsdc, type ExitAsset, type Intent, type IntentGoal } from "@/lib/lp-intent";
import { formatAmount, formatCompact, formatPct, formatUtcDate } from "./format";
import { Ruler } from "./ruler";

export type IntentField = "days" | "amount" | "goal" | "target" | "lossAlert" | "exitAsset";

const DAY_MS = 86_400_000;
const DAY_STOPS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 150, 180, 240, 300, 365] as const;
const AMOUNT_STOPS = [
  50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000,
] as const;
const TARGET_PCT_STOPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50] as const;
const LOSS_PCT_STOPS = [0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 75, 100] as const;

const GOALS: Record<IntentGoal, { verb: string; title: string; detail: string; eyebrow: string }> = {
  "net-by-date": {
    verb: "net",
    title: "Earn by a date",
    detail: "Net a set amount by the day you cash out.",
    eyebrow: "Net gain you're aiming for",
  },
  "take-profit": {
    verb: "take profit at",
    title: "Take profit when it's hit",
    detail: "Get told to exit once the gain is reached, and re-check on the date at the latest.",
    eyebrow: "Gain that tells you to exit",
  },
  "beat-holding": {
    verb: "beat holding by",
    title: "Hold and collect fees",
    detail: "You're happy owning these tokens and want to end up ahead of simply holding them.",
    eyebrow: "Edge over simply holding",
  },
};

const EXITS: Record<ExitAsset, { label: string; title: string; detail: string }> = {
  usdc: {
    label: "USDC",
    title: "Back to USDC",
    detail: "Swap both tokens back. Today's exit preview returns USDC plus a small SOL rent refund.",
  },
  tokens: {
    label: "the original tokens",
    title: "Keep the tokens",
    detail: "Skip the swap. You stay exposed to the tokens' price after leaving the pool.",
  },
};

const TONES = {
  lilac: "bg-lilac",
  lemon: "bg-lemon",
  mint: "bg-mint",
  coral: "bg-coral",
  plain: "bg-ink/10",
  white: "bg-white",
} as const;

function percentOf(part: string, whole: string): number {
  return new Decimal(part).div(whole).mul(100).toNumber();
}

function shareOf(amount: string, pct: number): string {
  const share = new Decimal(amount).mul(pct).div(100);
  const rounded = share.toDecimalPlaces(share.lt("0.01") ? 6 : 2);
  return (rounded.isZero() ? new Decimal("0.000001") : rounded).toFixed();
}

function Pill({
  field,
  tone,
  active,
  onSelect,
  children,
}: {
  field: IntentField;
  tone: keyof typeof TONES;
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
        "mx-[0.06em] inline-flex items-center gap-[0.22em] whitespace-nowrap rounded-full px-[0.48em] py-[0.04em] align-baseline outline-none transition-[box-shadow,translate] duration-200",
        "focus-visible:shadow-[0_0_0_3px_var(--color-ink)]",
        TONES[tone],
        active ? "-translate-y-[0.04em] shadow-[0_0_0_2.5px_var(--color-ink)]" : "hover:shadow-[0_0_0_1.5px_rgb(13_13_12/0.4)]",
      )}
    >
      {children}
      <ChevronDown
        aria-hidden="true"
        strokeWidth={2.5}
        className={cn("h-[0.42em] w-[0.42em] shrink-0 opacity-55 transition-transform duration-200", active && "rotate-180")}
      />
    </button>
  );
}

function ValueField({
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
  return (
    <label className="mt-1 flex items-baseline text-[clamp(3rem,7vw,5.25rem)] font-semibold leading-none tracking-[-0.045em]">
      {prefix && <span aria-hidden="true">{prefix}</span>}
      {/* The hidden twin sizes the grid cell, so the input is exactly as wide as its text. */}
      <span className="inline-grid">
        <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre tabular-nums">
          {text || "0"}
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

function OptionCard({
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

function Editor({
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

export function IntentSentence({
  intent,
  now,
  active,
  onActiveChange,
  onChange,
}: {
  intent: Intent;
  now: number;
  active: IntentField;
  onActiveChange: (field: IntentField) => void;
  onChange: (patch: Partial<Intent>) => void;
}) {
  const goal = GOALS[intent.goal];
  const pill = (field: IntentField, tone: keyof typeof TONES, content: ReactNode) => (
    <Pill field={field} tone={tone} active={active === field} onSelect={onActiveChange}>
      {content}
    </Pill>
  );
  const targetPct = percentOf(intent.target, intent.amount);
  const lossPct = percentOf(intent.lossAlert, intent.amount);

  return (
    <div>
      <p className="text-[clamp(1.8rem,3.7vw,3.05rem)] font-medium leading-[1.36] tracking-[-0.035em]">
        {intent.goal === "take-profit" ? "Within " : "In "}
        {pill("days", "lilac", `${intent.days} ${intent.days === 1 ? "day" : "days"}`)}, I want{" "}
        {pill("amount", "lemon", `${formatAmount(intent.amount)} USDC`)} to {pill("goal", "plain", goal.verb)}{" "}
        {pill("target", "mint", `+${formatAmount(intent.target)} USDC`)} after costs.
      </p>
      <p className="mt-5 text-[clamp(1.05rem,1.7vw,1.4rem)] font-medium leading-[1.6] tracking-[-0.02em] text-ink/75">
        Warn me if I&apos;m down {pill("lossAlert", "coral", `${formatAmount(intent.lossAlert)} USDC`)}, and exit to{" "}
        {pill("exitAsset", "white", EXITS[intent.exitAsset].label)}.
      </p>

      <div id="plan-editor" key={active} className="mt-8 border-t border-ink/15 pt-6">
        {active === "days" && (
          <Editor
            eyebrow="When you'd cash out"
            note={
              <>
                Judged on <span suppressHydrationWarning>{formatUtcDate(now + intent.days * DAY_MS)}</span> (UTC). The
                day you plan to take stock, not a maturity date or a promise of profit.
              </>
            }
          >
            <ValueField
              label="Days until you cash out"
              unit={intent.days === 1 ? "day" : "days"}
              value={String(intent.days)}
              display={String(intent.days)}
              parse={(text) => {
                const days = parseDays(text);
                return days === null ? null : String(days);
              }}
              onCommit={(value) => onChange({ days: Number(value) })}
            />
            <Ruler
              label="Days until you cash out"
              stops={DAY_STOPS}
              majors={[7, 30, 90, 180, 365]}
              value={intent.days}
              valueText={`${intent.days} days`}
              onChange={(days) => onChange({ days })}
              formatStop={(days) => `${days}d`}
              knobClassName="bg-lilac"
            />
          </Editor>
        )}

        {active === "amount" && (
          <Editor
            eyebrow="What you'd put in"
            note="Sized in USDC for the analysis. Nothing is deposited or signed from this page."
          >
            <ValueField
              label="Amount to put in, in USDC"
              unit="USDC"
              value={intent.amount}
              display={formatAmount(intent.amount)}
              parse={(text) => parseUsdc(text)}
              onCommit={(amount) => onChange({ amount })}
            />
            <Ruler
              label="Amount to put in"
              stops={AMOUNT_STOPS}
              majors={[100, 1000, 10000, 100000]}
              value={Number(intent.amount)}
              valueText={`${formatAmount(intent.amount)} USDC`}
              onChange={(amount) => onChange({ amount: String(amount) })}
              formatStop={formatCompact}
              knobClassName="bg-lemon"
            />
          </Editor>
        )}

        {active === "goal" && (
          <Editor eyebrow="What matters most">
            <div role="radiogroup" aria-label="What matters most" className="mt-4 grid gap-3 sm:grid-cols-3">
              {(Object.keys(GOALS) as IntentGoal[]).map((key) => (
                <OptionCard
                  key={key}
                  selected={intent.goal === key}
                  title={GOALS[key].title}
                  detail={GOALS[key].detail}
                  onSelect={() => onChange({ goal: key })}
                />
              ))}
            </div>
          </Editor>
        )}

        {active === "target" && (
          <Editor
            eyebrow={goal.eyebrow}
            note={`${formatPct(targetPct)} on ${formatAmount(intent.amount)} USDC in ${intent.days} ${intent.days === 1 ? "day" : "days"}. That pace is ${formatPct((targetPct * 365) / intent.days)} a year, before compounding.`}
          >
            <ValueField
              label="Target gain after costs, in USDC"
              prefix="+"
              unit="USDC"
              value={intent.target}
              display={formatAmount(intent.target)}
              parse={(text) => parseUsdc(text)}
              onCommit={(target) => onChange({ target })}
            />
            <Ruler
              label="Target gain as a share of the amount"
              stops={TARGET_PCT_STOPS}
              majors={[1, 5, 10, 25, 50]}
              value={targetPct}
              valueText={`${formatAmount(intent.target)} USDC, ${formatPct(targetPct)} of the amount`}
              onChange={(pct) => onChange({ target: shareOf(intent.amount, pct) })}
              formatStop={(pct) => `${pct}%`}
              knobClassName="bg-mint"
            />
          </Editor>
        )}

        {active === "lossAlert" && (
          <Editor
            eyebrow="Loss that should get your attention"
            note={`${formatPct(lossPct)} of what you put in. A line to act on, not a guaranteed floor: gaps and thin liquidity can overshoot it.`}
          >
            <ValueField
              label="Loss alert, in USDC"
              prefix={"−"}
              unit="USDC"
              value={intent.lossAlert}
              display={formatAmount(intent.lossAlert)}
              parse={(text) => parseUsdc(text, intent.amount)}
              onCommit={(lossAlert) => onChange({ lossAlert })}
            />
            <Ruler
              label="Loss alert as a share of the amount"
              stops={LOSS_PCT_STOPS}
              majors={[1, 5, 10, 25, 50, 100]}
              value={lossPct}
              valueText={`${formatAmount(intent.lossAlert)} USDC, ${formatPct(lossPct)} of the amount`}
              onChange={(pct) => onChange({ lossAlert: shareOf(intent.amount, pct) })}
              formatStop={(pct) => `${pct}%`}
              knobClassName="bg-coral"
            />
          </Editor>
        )}

        {active === "exitAsset" && (
          <Editor eyebrow="What you'd take back">
            <div role="radiogroup" aria-label="What you'd take back" className="mt-4 grid gap-3 sm:grid-cols-2">
              {(Object.keys(EXITS) as ExitAsset[]).map((key) => (
                <OptionCard
                  key={key}
                  selected={intent.exitAsset === key}
                  title={EXITS[key].title}
                  detail={EXITS[key].detail}
                  onSelect={() => onChange({ exitAsset: key })}
                />
              ))}
            </div>
          </Editor>
        )}
      </div>
    </div>
  );
}
