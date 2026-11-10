// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegionNotice } from "./region-notice";
import { RegionNoticeDismissButton } from "./region-notice-banner";
import {
  hasRegionNoticeDismissCookie,
  REGION_NOTICE_DISMISS_COOKIE,
  REGION_NOTICE_LINK_TEXT,
  REGION_NOTICE_REQUEST_HEADER,
  REGION_NOTICE_TEXT,
  XSTOCKS_ELIGIBILITY_TERMS_URL,
} from "@/lib/region-notice";

const headerStore = vi.hoisted(() => ({ notice: null as string | null, dismiss: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => name === REGION_NOTICE_REQUEST_HEADER ? headerStore.notice : null }),
  cookies: async () => ({ get: (name: string) => name === REGION_NOTICE_DISMISS_COOKIE && headerStore.dismiss ? { value: headerStore.dismiss } : undefined }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => createRoot(host).render(node));
  return host;
}

beforeEach(() => {
  headerStore.notice = null;
  headerStore.dismiss = undefined;
  document.cookie = `${REGION_NOTICE_DISMISS_COOKIE}=; max-age=0; path=/`;
});
afterEach(() => { document.body.innerHTML = ""; });

describe("RegionNotice (server)", () => {
  it("renders nothing without the Proxy request header", async () => {
    expect(await RegionNotice()).toBe(null);
  });

  it("renders nothing when the dismiss cookie is set", async () => {
    headerStore.notice = "1";
    headerStore.dismiss = "1";
    expect(await RegionNotice()).toBe(null);
  });

  it("renders the notice markup when the Proxy header is set", async () => {
    headerStore.notice = "1";
    const host = render(await RegionNotice());
    const note = host.querySelector("[role=note]")!;
    expect(note.textContent).toContain(REGION_NOTICE_TEXT);
    expect(host.querySelector("[role=dialog], [aria-modal]")).toBe(null);
    expect(note.className).not.toMatch(/\bfixed\b|\binset-0\b/);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(XSTOCKS_ELIGIBILITY_TERMS_URL);
    expect(link.textContent).toBe(REGION_NOTICE_LINK_TEXT);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

describe("RegionNoticeDismissButton", () => {
  it("sets the dismiss cookie and removes the banner", () => {
    const host = render(
      createElement("div", { role: "note" }, createElement(RegionNoticeDismissButton)),
    );
    act(() => { (host.querySelector("button[aria-label='Dismiss notice']") as HTMLButtonElement).click(); });
    expect(host.querySelector("[role=note]")).toBe(null);
    expect(hasRegionNoticeDismissCookie(document.cookie)).toBe(true);
  });
});
