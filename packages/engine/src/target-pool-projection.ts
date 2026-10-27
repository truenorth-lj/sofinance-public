/**
 * The swap legs of one open-position strategy would move the target pool's price
 * in a way the pre-add estimate cannot accept (out of the selected range, across
 * the active tick, or a route too complex to estimate). The sequential
 * strategies deliberately route the second hop through the target pool, so this
 * is strategy-specific: another strategy whose legs avoid the target pool can
 * still pass the same guard. Kept in its own module so callers can classify it
 * even where `open-quote` is mocked.
 */
export class TargetPoolProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetPoolProjectionError";
  }
}
