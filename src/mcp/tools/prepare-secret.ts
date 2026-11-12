import { getSigningSecret } from "@sofinance/engine/config/server-env";

// Preserve the original one-key lifetime across the async use-case boundary.
// Capture lazily after build success; never return key material in prepared data.
export function capturePrepareSigningSecret() {
  let secret: string | undefined;
  return () => secret ??= getSigningSecret();
}
