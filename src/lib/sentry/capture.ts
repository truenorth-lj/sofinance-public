import * as Sentry from "@sentry/nextjs";
import { JupiterHttpError, JupiterUnavailableError } from "@sofinance/engine/jupiter/errors";
import { RpcHttpError, RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { CompoundSendError, sanitizePublicError } from "../public-error";
import { isSentryEnabled } from "./runtime";

const ROUTE_FROM_STACK = /(?:^|[\\/])app([\\/]api[\\/][A-Za-z0-9._[\]/-]+?)[\\/]route\.(?:ts|js|tsx)/;

export function sentryErrorClass(error: unknown): string {
  if (error instanceof CompoundSendError && error.cause !== undefined) {
    return sentryErrorClass(error.cause);
  }
  if (error instanceof JupiterUnavailableError) return "JupiterUnavailableError";
  if (error instanceof JupiterHttpError) return "JupiterHttpError";
  if (error instanceof RpcUnavailableError) return "RpcUnavailableError";
  if (error instanceof RpcHttpError) return "RpcHttpError";
  if (error instanceof Error && error.name) return error.name;
  return "unknown";
}

export function routeFromCallerStack(stack = new Error().stack ?? ""): string | undefined {
  const match = stack.replaceAll("\\", "/").match(ROUTE_FROM_STACK);
  return match?.[1]?.replaceAll("\\", "/");
}

export function captureApiRouteError(
  error: unknown,
  options: { route?: string; fallback?: string } = {},
): void {
  try {
    if (!isSentryEnabled()) return;
    const route = options.route ?? routeFromCallerStack() ?? "unknown";
    Sentry.withScope((scope) => {
      scope.setTag("route", route);
      scope.setTag("error_class", sentryErrorClass(error));
      scope.setExtra("public_message", sanitizePublicError(error, options.fallback ?? "API route error"));
      Sentry.captureException(error);
    });
  } catch {
    // Monitoring must never fail the request.
  }
}
