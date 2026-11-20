import { engineEnv, type EngineEnv } from "../host";

/** Jupiter portal API key, or undefined when the variable is not set. */
export function getJupiterApiKey(): string | undefined {
  return engineEnv().JUPITER_API_KEY;
}

function currentSigningSecret(env: EngineEnv): string {
  return env.SOFINANCE_SIGNING_SECRET || env.JUPITER_API_KEY || "";
}

/** Current HMAC secret for issuance, read on each call. */
export function getSigningSecret(): string {
  return currentSigningSecret(engineEnv());
}

/** Current and optional previous HMAC secrets for verification during a rotation. */
export function getSigningSecrets(): [current: string] | [current: string, previous: string] {
  const env = engineEnv();
  const current = currentSigningSecret(env);
  const previous = env.SOFINANCE_SIGNING_SECRET_PREVIOUS;
  return current && previous && previous !== current ? [current, previous] : [current];
}
