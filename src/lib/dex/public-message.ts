import { scrubCredentialText } from "@/lib/sentry/scrub";

/**
 * Defense in depth on top of each adapter's plain-English messages: never return a stack trace, an RPC / any URL or a
 * credential to the browser. Keeps the first line only, scrubs it, and caps the length.
 */
export function publicDexMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
  const scrubbed = scrubCredentialText(firstLine)
    .replace(/\b(?:https?|wss?):\/\/\S+/gi, "[redacted]")
    .replace(/\[redacted-(?:url|secret|signature|address)\]/g, "[redacted]")
    .replace(/\s+at\s+\S+\s+\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = scrubbed.length > 400 ? `${scrubbed.slice(0, 397)}...` : scrubbed;
  return capped || "The request could not be completed. Nothing was sent.";
}
