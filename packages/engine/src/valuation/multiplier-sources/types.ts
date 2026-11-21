import type { AssetRef, MultiplierHint, MultiplierReading, MultiplierSourceId } from "../types";

/** One way to know an asset's multiplier. Returns null when the asset is not this source's to answer. Never does I/O. */
export type MultiplierSource = {
  readonly id: MultiplierSourceId;
  read(ref: AssetRef, hints: readonly MultiplierHint[]): MultiplierReading | null;
};
