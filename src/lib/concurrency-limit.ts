/** Runs async tasks with at most `limit` in flight; the rest wait in FIFO order. */
export function createConcurrencyLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
  };
}
