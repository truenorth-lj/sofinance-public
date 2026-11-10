import { cookies, headers } from "next/headers";
import { RegionNoticeDismissButton } from "./region-notice-banner";
import {
  REGION_NOTICE_DISMISS_COOKIE,
  REGION_NOTICE_LINK_TEXT,
  REGION_NOTICE_REQUEST_HEADER,
  REGION_NOTICE_TEXT,
  XSTOCKS_ELIGIBILITY_TERMS_URL,
} from "@/lib/region-notice";
import { EXTERNAL_LINK_PROPS } from "@/lib/social-links";

const [beforeLink, afterLink] = REGION_NOTICE_TEXT.split(REGION_NOTICE_LINK_TEXT);

/**
 * Server-rendered notice: the Proxy sets `x-sofi-region-notice: 1` when this path should show it
 * (geo or non-production `?forceRegionNotice=1`). A dismiss cookie keeps it out of the HTML.
 * Markup is rendered here so the banner is in the initial HTML; only the dismiss button is a client component.
 */
export async function RegionNotice() {
  const headerStore = await headers();
  if (headerStore.get(REGION_NOTICE_REQUEST_HEADER) !== "1") return null;
  const cookieStore = await cookies();
  if (cookieStore.get(REGION_NOTICE_DISMISS_COOKIE)?.value === "1") return null;

  return (
    <div role="note" aria-label="Regional notice" className="border-b border-white/10 bg-char text-smoke">
      <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-2 text-xs leading-5 sm:items-center">
        <p className="flex-1">
          {beforeLink}
          <a
            href={XSTOCKS_ELIGIBILITY_TERMS_URL}
            className="text-cream underline underline-offset-2 hover:text-lemon"
            {...EXTERNAL_LINK_PROPS}
          >
            {REGION_NOTICE_LINK_TEXT}
          </a>
          {afterLink}
        </p>
        <RegionNoticeDismissButton />
      </div>
    </div>
  );
}
