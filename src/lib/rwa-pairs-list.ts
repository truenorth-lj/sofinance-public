/**
 * Client fetch for the public RWA pairs list. Homepage, /app/rwa-pairs, and the plan
 * picker share this path so they hit the same cached `/api/rwa-pairs` response.
 */
export const RWA_PAIRS_LIST_QUERY = { minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr" } as const;

export const RWA_PAIRS_LIST_PATH =
  `/api/rwa-pairs?minTvl=${RWA_PAIRS_LIST_QUERY.minTvl}&maxPages=${RWA_PAIRS_LIST_QUERY.maxPages}&sortBy=${RWA_PAIRS_LIST_QUERY.sortBy}`;

export async function fetchRwaPairsList<T>(signal?: AbortSignal): Promise<T> {
  const response = await fetch(RWA_PAIRS_LIST_PATH, {
    signal,
    headers: { Accept: "application/json" },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Failed to load RWA pairs");
  return body;
}
