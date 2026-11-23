import {
  getStoredAttribution,
  isEmptyAttribution,
  readAndStoreFirstTouch,
  type Attribution,
} from "./attribution";
import { GROWTH_EVENTS } from "./events";
import { POSTHOG_RELAY_PATH, posthogUpstream } from "./relay";
import { hashedWalletId } from "./wallet-id";

export type GrowthClient = {
  init?: (key: string, options: Record<string, unknown>) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  register: (properties: Record<string, unknown>) => void;
  identify: (id: string) => void;
  setPersonProperties?: (properties: Record<string, unknown>) => void;
  unregister?: (property: string) => void;
  reset?: () => void;
  get_distinct_id?: () => string;
};

type Status = "unset" | "off" | "on";

let status: Status = "unset";
/** One shared init: concurrent callers (instrumentation-client, AnalyticsRoot, first events) await the same promise. */
let inflight: Promise<boolean> | null = null;
let client: GrowthClient | null = null;
const queue: Array<{ event: string; properties?: Record<string, unknown> }> = [];
const once = new Set<string>();
let identifiedWallet: string | null = null;

export function posthogProjectKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  return key || undefined;
}

/** Browser-facing ingest host: always the first-party relay, so ad blockers don't drop events. */
export function posthogApiHost(): string {
  return POSTHOG_RELAY_PATH;
}

/** PostHog app host, for links the SDK builds (toolbar). The relay is not a UI host. */
function posthogUiHost(): string {
  return posthogUpstream(process.env.NEXT_PUBLIC_POSTHOG_HOST).ui;
}

export function resetGrowthAnalyticsForTests() {
  status = "unset";
  inflight = null;
  client = null;
  queue.length = 0;
  once.clear();
  identifiedWallet = null;
}

export function installGrowthClientForTests(next: GrowthClient | null) {
  client = next;
  status = next ? "on" : "off";
  queue.length = 0;
}

function doNotTrack(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { msDoNotTrack?: string };
  return nav.doNotTrack === "1" || nav.doNotTrack === "yes" || nav.msDoNotTrack === "1";
}

// The wallet address never goes to PostHog: the hashed distinct id (wallet-id.ts) is the only wallet link.
// These keys are stripped as a guard, including `wallet_address`, which older builds sent.
function dropSecrets(properties: Record<string, unknown> | undefined) {
  if (!properties) return properties;
  const next = { ...properties };
  delete next.wallet;
  delete next.address;
  delete next.wallet_address;
  delete next.signedTransaction;
  delete next.permit;
  return next;
}

function applyAttribution(attribution: Attribution) {
  if (!client || isEmptyAttribution(attribution)) return;
  const properties = { ...attribution };
  client.register(properties);
  client.setPersonProperties?.(properties);
}

function flushQueue() {
  if (!client) {
    queue.length = 0;
    return;
  }
  for (const item of queue) client.capture(item.event, dropSecrets(item.properties));
  queue.length = 0;
}

export async function initGrowthAnalytics(search?: string): Promise<boolean> {
  if (status === "on") {
    if (search && typeof window !== "undefined") {
      applyAttribution(readAndStoreFirstTouch(search, window.localStorage));
    }
    return true;
  }
  if (status === "off") return false;
  if (inflight) {
    const enabled = await inflight;
    if (enabled && search && typeof window !== "undefined") applyAttribution(readAndStoreFirstTouch(search, window.localStorage));
    return enabled;
  }
  inflight = startGrowthAnalytics(search);
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function startGrowthAnalytics(search?: string): Promise<boolean> {
  const key = posthogProjectKey();
  if (!key || typeof window === "undefined" || doNotTrack()) {
    status = "off";
    client = null;
    queue.length = 0;
    return false;
  }
  try {
    const { default: posthog } = await import("posthog-js");
    posthog.init(key, {
      api_host: posthogApiHost(),
      ui_host: posthogUiHost(),
      autocapture: false,
      // $pageview is sent manually by AnalyticsRoot on every App Router path/query change.
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      // Project settings turn these on remotely; keep the client to the explicit event list.
      capture_heatmaps: false,
      capture_performance: false,
      disable_surveys: true,
      disable_session_recording: true,
      respect_dnt: true,
      persistence: "localStorage+cookie",
    });
    client = posthog;
    status = "on";
    // Builds before the hashed id registered the raw address as a persisted super property; drop it.
    posthog.unregister("wallet_address");
    const query = search ?? window.location.search;
    applyAttribution(readAndStoreFirstTouch(query, window.localStorage));
    flushQueue();
    return true;
  } catch {
    status = "off";
    client = null;
    queue.length = 0;
    return false;
  }
}

export function captureGrowthEvent(event: string, properties?: Record<string, unknown>) {
  if (status === "off") return;
  if (status === "on" && client) {
    client.capture(event, dropSecrets(properties));
    return;
  }
  queue.push({ event, properties });
  void initGrowthAnalytics();
}

export function captureGrowthEventOnce(key: string, event: string, properties?: Record<string, unknown>) {
  if (once.has(key)) return;
  once.add(key);
  captureGrowthEvent(event, properties);
}

// A distinct id from an earlier wallet: a raw base58 address (older builds) or a `wallet:<sha256>` id.
const WALLET_DISTINCT_ID = /^(?:wallet:[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

function resetIdentity(nextClient: GrowthClient) {
  nextClient.unregister?.("wallet_address");
  nextClient.reset?.();
  identifiedWallet = null;
  // reset() drops super properties; keep first-touch attribution on the new anonymous id.
  const stored = typeof window === "undefined" ? null : getStoredAttribution(window.localStorage);
  if (stored) applyAttribution(stored);
}

/**
 * Identify by the hashed wallet id (`wallet:<sha256>`, same as the MCP server), never the raw address.
 * A different earlier wallet id, raw or hashed, is reset first, so a raw-address person is not merged into the new id.
 * Extra connect context is event-only.
 */
export async function captureWalletConnected(wallet: string, extras?: Record<string, unknown>) {
  if (!wallet) return;
  const enabled = await initGrowthAnalytics();
  if (!enabled || !client) return;
  const id = await hashedWalletId(wallet);
  if (!client) return;
  const current = client.get_distinct_id?.();
  if (current && current !== id && WALLET_DISTINCT_ID.test(current)) resetIdentity(client);
  client.identify(id);
  identifiedWallet = id;
  captureGrowthEvent(GROWTH_EVENTS.walletConnected, extras && Object.keys(extras).length > 0 ? extras : undefined);
}

/** Wallet disconnected: start a fresh anonymous id. */
export function captureWalletDisconnected() {
  if (status !== "on" || !client || !identifiedWallet) return;
  resetIdentity(client);
}

export function capturePageview(pathname: string, href: string) {
  captureGrowthEvent("$pageview", { $pathname: pathname, $current_url: href });
}
