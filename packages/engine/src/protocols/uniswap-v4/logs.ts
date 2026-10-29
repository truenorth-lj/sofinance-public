/**
 * Chunked `eth_getLogs`. Providers cap the block span of one query (the official 4663 RPC allows wide
 * ranges for single-value topic filters, 100k blocks for OR-lists; dRPC's free plan far less), so a
 * range is split on demand: the cap from the provider's error message is used when it states one,
 * otherwise the span is halved, down to `minSpan`.
 */
export type ChunkedLogsOptions = { maxSpan?: bigint; minSpan?: bigint; maxRequests?: number };

const RANGE_LIMIT_PATTERNS = [/only (\d+) are allowed/i, /ranges? over (\d+) blocks/i, /block range (?:is )?(?:too large|limit)[^\d]*(\d+)/i, /maximum (?:block )?range[^\d]*(\d+)/i];

export function rangeLimitFromError(error: unknown): bigint | null | "range" {
  const text = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error);
  for (const pattern of RANGE_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return BigInt(match[1]);
  }
  return /range|too many (?:results|logs)|query returned more than|limit exceeded|spans/i.test(text) ? "range" : null;
}

export async function getLogsChunked<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  options: ChunkedLogsOptions = {},
): Promise<T[]> {
  if (toBlock < fromBlock) return [];
  const minSpan = options.minSpan ?? 1_000n;
  const maxRequests = options.maxRequests ?? 40;
  let span = options.maxSpan ?? toBlock - fromBlock + 1n;
  let cursor = fromBlock;
  let requests = 0;
  const out: T[] = [];
  while (cursor <= toBlock) {
    if (++requests > maxRequests) throw new Error(`eth_getLogs needed more than ${maxRequests} requests`);
    const end = cursor + span - 1n < toBlock ? cursor + span - 1n : toBlock;
    try {
      out.push(...await fetchRange(cursor, end));
      cursor = end + 1n;
    } catch (error) {
      const limit = rangeLimitFromError(error);
      if (limit === null) throw error;
      const next = typeof limit === "bigint" && limit < span ? limit : span / 2n;
      if (next < minSpan || next >= span) throw error;
      span = next;
    }
  }
  return out;
}
