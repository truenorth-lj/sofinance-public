"use client";

import { useEffect, useState } from "react";
import type { TokenMetadata } from "@/lib/token-metadata";

/** Jupiter token metadata for the given mints; empty until the request finishes. */
export function useTokenMetadata(mints: readonly string[]): Record<string, TokenMetadata> {
  const query = [...new Set(mints.filter(Boolean))].sort().join(",");
  const [state, setState] = useState<{ query: string; tokens: Record<string, TokenMetadata> }>({
    query: "",
    tokens: {},
  });

  useEffect(() => {
    if (!query) return;
    const aborter = new AbortController();
    const load = async () => {
      const tokens: Record<string, TokenMetadata> = {};
      const list = query.split(",");
      for (let index = 0; index < list.length; index += 100) {
        const response = await fetch("/api/token-metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mints: list.slice(index, index + 100) }),
          signal: aborter.signal,
        });
        if (response.ok) {
          Object.assign(
            tokens,
            ((await response.json()) as { tokens: Record<string, TokenMetadata> }).tokens,
          );
        }
      }
      if (!aborter.signal.aborted) setState({ query, tokens });
    };
    void load().catch(() => undefined);
    return () => aborter.abort();
  }, [query]);

  return state.query === query ? state.tokens : {};
}
