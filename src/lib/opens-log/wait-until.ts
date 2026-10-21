/** Keep a Vercel isolate alive after the response, without delaying it. Off-platform: fire-and-forget. */
export function runBestEffort(work: Promise<unknown>) {
  const ignored = work.catch(() => undefined);
  try {
    const holder = (globalThis as unknown as {
      [key: symbol]: { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } } | undefined;
    });
    holder[Symbol.for("@next/request-context")]?.get?.()?.waitUntil?.(ignored);
  } catch {
    // ignore missing request context
  }
}
