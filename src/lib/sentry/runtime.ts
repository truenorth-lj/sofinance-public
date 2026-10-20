export type SentryEnv = {
  NEXT_PUBLIC_SENTRY_DSN?: string;
  SENTRY_DSN?: string;
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
};

const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

function readEnv(): SentryEnv {
  return {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    SENTRY_DSN: process.env.SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
  };
}

/** Client uses NEXT_PUBLIC_SENTRY_DSN; server/edge also accept SENTRY_DSN. */
export function resolveSentryDsn(env: SentryEnv = readEnv()): string | undefined {
  const dsn = env.NEXT_PUBLIC_SENTRY_DSN || env.SENTRY_DSN;
  const trimmed = dsn?.trim();
  return trimmed || undefined;
}

export function isSentryEnabled(env: SentryEnv = readEnv()): boolean {
  return Boolean(resolveSentryDsn(env));
}

/** Default 0.1. Clamped to [0, 1]. Invalid values fall back to 0.1. */
export function sentryTracesSampleRate(env: SentryEnv = readEnv()): number {
  const raw = env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || env.SENTRY_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRACES_SAMPLE_RATE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TRACES_SAMPLE_RATE;
  return Math.min(parsed, 1);
}
