import { ZodError } from "zod";
import { sanitizePublicError } from "../lib/public-error";

/**
 * Client-safe message for a failed MCP tool call (HTTP route and stdio server share it).
 * Same redaction/mapping as the web API routes (sanitizePublicError: no URLs, api keys or
 * tokens, known chain errors mapped, 220 chars). Zod errors are first flattened to
 * "path: message" pairs ("required" for a missing field), otherwise the 220-char limit would cut the field details an agent needs.
 */
export function publicToolError(error: unknown, fallback = "Tool call failed"): string {
  try {
    return describe(error, fallback);
  } catch {
    // e.g. a thrown `undefined`/function: errorText() cannot stringify it. Never let the catch handler throw.
    return fallback;
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => {
      const message = /received undefined$/.test(issue.message) ? "required" : issue.message;
      return `${issue.path.length ? issue.path.join(".") : "(args)"}: ${message}`;
    });
    return sanitizePublicError(new Error(`Invalid arguments: ${issues.join("; ")}`), fallback);
  }
  return sanitizePublicError(error, fallback);
}
