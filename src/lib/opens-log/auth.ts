import { timingSafeEqual } from "node:crypto";
import { getOpensReadToken } from "@/lib/config/opens-env";

export function opensDailyUnauthorizedStatus(authorization: string | null | undefined) {
  const token = getOpensReadToken();
  if (!token) return 404;
  if (!authorization) return 401;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authorization);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 401;
  return null;
}
