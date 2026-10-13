import { timingSafeEqual } from "node:crypto";
export function validRwaAuthorization(
  value: string | null | undefined,
  secret: string | undefined,
) {
  if (!secret || secret.length < 32 || !value) return false;
  const expected = Buffer.from(`Bearer ${secret}`),
    actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
