import {
  isEmptyAttribution,
  readAndStoreFirstTouch,
  type Attribution,
} from "./attribution";
import { GROWTH_EVENTS } from "./events";
import { hashWallet } from "./hash-wallet";
import { POSTHOG_RELAY_PATH, posthogUpstream } from "./relay";

export type GrowthClient = {
  init?: (key: string, options: Record<string, unknown>) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  register: (properties: Record<string, unknown>) => void;
  identify: (id: string) => void;
  setPersonProperties?: (properties: Record<string, unknown>) => void;
};

type Status = "unset" | "off" | "on";

let status: Status = "unset";
let client: GrowthClient | null = null;
const queue: Array<{ event: string; properties?: Record<string, unknown> }> = [];
const once = new Set<string>();

export function posthogProjectKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  return key || undefined;
}

/** Browser-facing ingest host: always the first-party relay, so ad blockers don't drop events. */
export function posthogApiHost(): string {
  return POSTHOG_RELAY_PATH;
}

/** PostHog app host, for links the SDK builds (toolbar). The relay is not a UI host. */
export function posthogUiHost(): string {
  return posthogUpstream(process.env.NEXT_PUBLIC_POSTHOG_HOST).ui;
}

export function resetGrowthAnalyticsForTests() {
  status = "unset";
  client = null;
  queue.length = 0;
  once.clear();
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

function dropSecrets(properties: Record<string, unknown> | undefined) {
  if (!properties) return properties;
  const next = { ...properties };
  delete next.wallet;
  delete next.address;
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

export async function captureWalletConnected(wallet: string) {
  if (!wallet) return;
  const enabled = await initGrowthAnalytics();
  if (!enabled || !client) return;
  const hashed = await hashWallet(wallet);
  client.identify(`wallet:${hashed}`);
  captureGrowthEvent(GROWTH_EVENTS.walletConnected);
}

export function capturePageview(pathname: string, href: string) {
  captureGrowthEvent("$pageview", { $pathname: pathname, $current_url: href });
}
