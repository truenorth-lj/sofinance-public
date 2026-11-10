// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegionNotice } from "./region-notice";
import {
  REGION_NOTICE_COOKIE, REGION_NOTICE_DISMISS_KEY, REGION_NOTICE_LINK_TEXT, REGION_NOTICE_TEXT,
  XSTOCKS_ELIGIBILITY_TERMS_URL,
} from "@/lib/region-notice";

const nav = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => createRoot(host).render(createElement(RegionNotice)));
  return host;
}

beforeEach(() => {
  nav.pathname = "/app";
  window.localStorage.clear();
  document.cookie = `${REGION_NOTICE_COOKIE}=; max-age=0; path=/`;
});
afterEach(() => { document.body.innerHTML = ""; });

describe("RegionNotice", () => {
  it("renders nothing without the Proxy flag", () => {
    expect(render().textContent).toBe("");
  });

  it("shows the exact notice as a non-modal note when flagged on /app", () => {
    document.cookie = `${REGION_NOTICE_COOKIE}=1; path=/`;
    const host = render();
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

  it("shows on /app/rwa-pairs and not on other paths", () => {
    document.cookie = `${REGION_NOTICE_COOKIE}=1; path=/`;
    nav.pathname = "/app/rwa-pairs";
    expect(render().querySelector("[role=note]")).not.toBe(null);
    nav.pathname = "/";
    expect(render().querySelector("[role=note]")).toBe(null);
    nav.pathname = "/app/ai";
    expect(render().querySelector("[role=note]")).toBe(null);
  });

  it("dismisses and stays dismissed in this browser", () => {
    document.cookie = `${REGION_NOTICE_COOKIE}=1; path=/`;
    const host = render();
    act(() => { (host.querySelector("button[aria-label='Dismiss notice']") as HTMLButtonElement).click(); });
    expect(host.querySelector("[role=note]")).toBe(null);
    expect(window.localStorage.getItem(REGION_NOTICE_DISMISS_KEY)).toBe("1");
    expect(render().querySelector("[role=note]")).toBe(null);
  });
});
