import type { BrowserContext, ConsoleMessage, Page } from "@playwright/test";

/** Third-party hosts the app talks to from the browser; the hermetic lane aborts them (no network dependency, no 403 noise). */
export const BLOCKED_THIRD_PARTY = [
  /(^|\.)web3modal\.org$/, /(^|\.)walletconnect\.(org|com)$/, /(^|\.)reown\.com$/,
  /(^|\.)googleapis\.com$/, /(^|\.)gstatic\.com$/,
];

export type Guards = {
  blockedHosts: Set<string>;
  unexpectedHosts: Set<string>;
  pageErrors: string[];
  consoleErrors: string[];
  /** Tests that provoke a known console error declare it here (regexp on the message text). */
  allowConsole: (pattern: RegExp) => void;
  failures: () => string[];
};

/**
 * Network allowlist + error collector.
 * - same-origin requests pass; blocked third-party hosts are aborted; any other host aborts AND fails the test;
 * - a `pageerror` or a `console.error` that is not caused by an aborted third-party request fails the test.
 */
export async function attachGuards(context: BrowserContext, page: Page, baseOrigin: string): Promise<Guards> {
  const blockedHosts = new Set<string>();
  const unexpectedHosts = new Set<string>();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const allowed: RegExp[] = [];

  await context.route((url) => url.origin !== baseOrigin && url.protocol.startsWith("http"), async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (BLOCKED_THIRD_PARTY.some((pattern) => pattern.test(host))) blockedHosts.add(host);
    else unexpectedHosts.add(host);
    await route.abort("blockedbyclient");
  });

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    let host = "";
    try { host = new URL(message.location().url).hostname; } catch { /* no location */ }
    if (host && (blockedHosts.has(host) || unexpectedHosts.has(host))) return;      // the aborted request itself
    const text = message.text();
    // The browser logs every 4xx/5xx fetch response as a console error. The negative journeys provoke those on purpose
    // for the verify/broadcast routes (real 401 for bad tokens, mocked 4xx/5xx for broadcast); anything else still fails.
    if (/^Failed to load resource: the server responded with a status of [45]\d\d/.test(text) &&
      /\/api\/(verify-sign-token|(selected|open|compound)-broadcast)$/.test(new URL(message.location().url || "http://x/").pathname)) return;
    if (allowed.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text.slice(0, 300));
  });

  return {
    blockedHosts, unexpectedHosts, pageErrors, consoleErrors,
    allowConsole: (pattern) => { allowed.push(pattern); },
    failures: () => [
      ...[...unexpectedHosts].map((host) => `unexpected network host: ${host}`),
      ...pageErrors.map((error) => `pageerror: ${error}`),
      ...consoleErrors.map((error) => `console.error: ${error}`),
    ],
  };
}

/** The wallet scan and token-metadata calls the app makes after connecting hit live RPC on the server: stub them. */
export async function stubWalletApis(context: BrowserContext, address?: string) {
  await context.route("**/api/wallet?**", (route) => {
    const wallet = new URL(route.request().url()).searchParams.get("wallet") ?? address ?? "";
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ wallet, slot: 1, fetchedAt: Date.now(), positions: [], assets: [] }) });
  });
  await context.route("**/api/token-metadata", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
}
