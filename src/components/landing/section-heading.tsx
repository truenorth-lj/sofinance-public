import type { ReactNode } from "react";

export const landingLabelPill =
  "inline-flex min-h-6 max-w-full items-center rounded-full border px-2.5 py-0.5 font-data text-[10px] uppercase leading-4 tracking-[0.1em] sm:whitespace-nowrap sm:tracking-[0.14em]";

/** Pill label, section headline and lede for the landing's explainer sections. */
export function LandingSectionHeading({ label, title, children }: { label: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col px-2 pt-16 sm:pt-24">
      <span className={`${landingLabelPill} w-fit border-white/30 text-cream/80`}>{label}</span>
      <h2 className="mt-4 max-w-[24ch] text-[clamp(1.7rem,3.4vw,2.75rem)] font-medium leading-[1.08] tracking-[-0.035em]">{title}</h2>
      {children && <p className="mt-3.5 max-w-[62ch] text-base leading-[1.55] text-cream/70 sm:text-lg">{children}</p>}
    </div>
  );
}
