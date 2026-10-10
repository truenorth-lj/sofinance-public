import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface InkHeroProps {
  label: string;
  title: string;
  children?: ReactNode;
  /** Optional element pinned to the top-right of the card, e.g. a status chip. */
  aside?: ReactNode;
  /** Keep the copy under the headline even on wide screens, for heroes that share a row. */
  stacked?: boolean;
  className?: string;
}

/** Cream page header: small pill label, oversized headline, hairline, supporting copy. */
export function InkHero({ label, title, children, aside, stacked = false, className }: InkHeroProps) {
  const split = !stacked && Boolean(children);
  return (
    <section
      className={cn(
        "mt-3 animate-rise rounded-[28px] bg-cream p-6 text-ink motion-reduce:animate-none sm:p-9",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex h-6 items-center whitespace-nowrap rounded-full border border-ink/70 px-2.5 font-data text-[10px] uppercase tracking-[0.14em]">
          {label}
        </span>
        {aside}
      </div>
      <div className={cn("mt-6", split && "lg:grid lg:grid-cols-12 lg:items-end lg:gap-10")}>
        <h1
          className={cn(
            "max-w-[20ch] text-[clamp(2.1rem,5vw,4rem)] font-medium leading-[1.02] tracking-[-0.04em]",
            split && "lg:col-span-7",
          )}
        >
          {title}
        </h1>
        {children && (
          <div
            className={cn(
              "mt-6 border-t border-ink/20 pt-5 text-sm leading-relaxed text-ink/70",
              split ? "lg:col-span-5 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" : "max-w-3xl",
            )}
          >
            {children}
          </div>
        )}
      </div>
    </section>
  );
}
