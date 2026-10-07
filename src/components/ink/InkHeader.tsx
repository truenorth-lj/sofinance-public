import Link from "next/link";
import Image from "next/image";
import { INK_COLORS } from "./ink-tokens";

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
    <header className="flex items-center justify-between gap-4">
      <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-70">
        <Image 
          src="/logo.svg" 
          alt="SoFinance" 
          width={40} 
          height={40}
          className="flex-shrink-0"
        />
        <div>
          <div className={`text-sm font-bold tracking-wide text-${INK_COLORS.textPrimary}`}>
            SoFinance
          </div>
          <div className={`text-xs text-${INK_COLORS.textTertiary}`}>
            {subtitle}
          </div>
        </div>
      </Link>
      {navLinks.length > 0 && (
        <div className="flex gap-2">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-xl border border-${INK_COLORS.cardBorder} bg-transparent px-3 py-2 text-xs font-semibold text-${INK_COLORS.textSecondary} transition-colors hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}
