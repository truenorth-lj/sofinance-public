import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Shared header mark: the cream H1 squircle at 36×36 beside a bold Host Grotesk "SoFinance"
 * wordmark in cream (16px below sm so the 360px header row still fits logo + wallets + Menu; 20px from sm).
 * Used by SiteHeader. The logo always goes to the marketing homepage.
 */
export function SiteLogo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex shrink-0 items-center gap-2 whitespace-nowrap font-display text-[16px] font-bold leading-none text-cream outline-none sm:gap-2.5 sm:text-[20px] focus-visible:shadow-[0_0_0_2px_var(--color-cream)]",
        className,
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-visible">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/navbar-mark-squircle-cream.svg"
          alt=""
          width={36}
          height={36}
          className="block h-9 w-9 max-w-none shrink-0 object-contain"
          aria-hidden
          data-testid="site-header-mark"
        />
      </span>
      SoFinance
    </Link>
  );
}
