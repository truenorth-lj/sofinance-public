"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/** The fallback avatar text: the token's first letter (LJ's rule), e.g. "S" for SNDKx, "U" for USDC. */
export const tokenInitial = (symbol: string) => symbol.trim().slice(0, 1).toUpperCase() || "?";

/**
 * A token logo with a first-letter fallback. The letter shows until the image has loaded, and again if it fails, so a
 * missing, slow or broken logo is never a blank circle. A server-rendered `<img>` can finish (or fail) before React
 * hydrates and attaches `onLoad` / `onError`, so the mount effect also reads the element's own state.
 */
export function TokenIcon({ symbol, icon, className }: { symbol: string; icon: string | null; className?: string }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const [loadedIcon, setLoadedIcon] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const showImage = Boolean(icon) && failedIcon !== icon;
  const loaded = showImage && loadedIcon === icon;

  useEffect(() => {
    const img = imgRef.current;
    if (!icon || !img || !img.complete) return;
    // Settled before hydration. A decoded image has a width; an SVG without intrinsic size may not, so ask
    // `decode()`, which rejects for a broken image.
    if (img.naturalWidth > 0) { setLoadedIcon(icon); return; }
    if (typeof img.decode !== "function") return;
    let live = true;
    img.decode().then(() => { if (live) setLoadedIcon(icon); }, () => { if (live) setFailedIcon(icon); });
    return () => { live = false; };
  }, [icon]);

  return <span className={cn("relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white/[0.06] text-sm font-bold text-cream", className)}>
    {!loaded && <span data-testid="token-icon-fallback">{tokenInitial(symbol)}</span>}
    {showImage && <>
      {/* Icons come from a bounded list of HTTPS hosts validated by the server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} src={icon!} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        onLoad={() => setLoadedIcon(icon)} onError={() => setFailedIcon(icon)}
        className={cn("absolute inset-0 h-full w-full object-cover", loaded ? "opacity-100" : "opacity-0")} />
    </>}
  </span>;
}
