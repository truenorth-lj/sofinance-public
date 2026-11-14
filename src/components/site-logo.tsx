import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Shared header mark: the cream H1 squircle at 36×36 beside a 20px bold Host Grotesk
 * "SoFinance" wordmark in cream. Used by the marketing header and the in-app nav.
 * `href` defaults to the marketing homepage; the app bar passes the app home route.
 */
export function SiteLogo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex shrink-0 items-center gap-2.5 whitespace-nowrap font-display text-[20px] font-bold leading-none text-cream outline-none focus-visible:shadow-[0_0_0_2px_var(--color-cream)]",
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
