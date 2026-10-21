import "server-only";

/** Postgres URL for north-star open logs. Unset = persist is a complete no-op. */
export function getOpensDatabaseUrl() {
  const url = process.env.SOFINANCE_OPENS_DATABASE_URL?.trim();
  return url || undefined;
}

/** Bearer token for GET /api/internal/opens-daily. Must be at least 32 characters. */
export function getOpensReadToken() {
  const token = process.env.SOFINANCE_OPENS_READ_TOKEN?.trim();
  return token && token.length >= 32 ? token : undefined;
}
