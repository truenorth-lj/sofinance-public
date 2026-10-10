import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

interface NavLink {
  href: string;
  label: string;
}

interface InkHeaderProps {
  subtitle: string;
  navLinks?: NavLink[];
}

export function InkHeader({ subtitle, navLinks = [] }: InkHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <Link
        href="/"
        className="flex h-10 items-center gap-2 rounded-full bg-lemon pl-1.5 pr-4 text-[13px] font-semibold text-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--color-cream)]"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink">
          <BrandMark className="h-5 w-5 text-lemon" />
        </span>
        SoFinance
        <span className="font-normal text-ink/60">{subtitle}</span>
      </Link>
      {navLinks.length > 0 && (
        <div className="flex gap-2">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex h-10 items-center justify-center rounded-full border border-white/25 px-4 text-[13px] font-medium text-cream/85 outline-none transition-colors hover:border-white/70 focus-visible:border-lemon"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}
