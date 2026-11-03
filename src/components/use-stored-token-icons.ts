"use client";

import { useEffect, useState } from "react";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import type { TokenIconMap } from "@/lib/token-icons/map";

/**
 * The token icon links the daily refresh stores in the DB (`rwa_token_icon`), served with `/api/rwa-pairs` as
 * `tokenIcons`: the same source the pool rows use (PairTokenIcons). Read once, only while `enabled` (today: a registry
 * position is listed), so a page without one makes no extra request. A failed read leaves the map undefined (rows fall
 * back to Jupiter metadata, then the first-letter avatar).
 */
export function useStoredTokenIcons(enabled: boolean): TokenIconMap | undefined {
  const [icons, setIcons] = useState<TokenIconMap | undefined>(undefined);
  const want = enabled && !icons;
  useEffect(() => {
    if (!want) return;
    const aborter = new AbortController();
    fetchRwaPairsList<{ tokenIcons?: TokenIconMap }>(aborter.signal)
      .then((body) => { if (!aborter.signal.aborted && body.tokenIcons) setIcons(body.tokenIcons); })
      .catch(() => undefined);
    return () => aborter.abort();
  }, [want]);
  return icons;
}
