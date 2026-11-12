/** Shared missing glyph and signed-number helpers for display formatters. */

export const MISSING = "—";
export const MINUS = "−";

export const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

/** Round half away from zero (Math.round sends −27.125 to −27.12). */
export const round = (value: number, precision: number) =>
  Math.sign(value) * Math.round(Math.abs(value) * precision) / precision;
