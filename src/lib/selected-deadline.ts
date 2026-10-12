// The read-only quote/prepare budget never applies to broadcasting a signed transaction.
export const SELECTED_DEADLINE_MS = 8_000;

export async function withSelectedDeadline(request: Request, run: (signal: AbortSignal) => Promise<Response>) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Preparation took too long; please retry", "TimeoutError")), SELECTED_DEADLINE_MS);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const response = await Promise.race([run(signal), cancelled]);
    signal.throwIfAborted();
    response.headers.set("Server-Timing", `total;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  } catch (error) {
    if (!signal.aborted) throw error;
    return Response.json({ error: controller.signal.aborted
      ? "Preparation took too long; please retry" : "Request cancelled" }, {
      status: controller.signal.aborted ? 504 : 499,
      headers: { "Cache-Control": "no-store", "Server-Timing": `total;dur=${(performance.now() - started).toFixed(1)}` },
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
