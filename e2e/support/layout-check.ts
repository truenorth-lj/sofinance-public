import { expect, type Page } from "@playwright/test";

export type LayoutReport = {
  /** document.documentElement.scrollWidth minus the viewport width: > 0 means the page scrolls sideways. */
  pageOverflow: number;
  /** An open dialog that does not fit inside the screen, or scrolls sideways inside itself. */
  dialogs: string[];
  /** Elements that stick out past the right or left edge (first few, for the failure message). */
  offenders: string[];
  /** Visible text fields and selects under 16 px: iOS zooms the page in when one is focused (wallet in-app browsers too). */
  smallFields: string[];
};

/** Measures one screen state. Read-only: nothing is clicked or typed. */
export async function measureLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element) => {
      const h = el as HTMLElement;
      const id = h.id ? `#${h.id}` : "";
      const cls = typeof h.className === "string" && h.className ? `.${h.className.trim().split(/\s+/).slice(0, 6).join(".")}` : "";
      const r = h.getBoundingClientRect();
      return `${h.tagName.toLowerCase()}${id}${cls} [${Math.round(r.left)}..${Math.round(r.right)}] "${(h.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    // An element clipped by a scrolling/clipping ancestor (a table that scrolls inside its card) is fine.
    const clippedInside = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(o.overflowX)) {
          const r = p.getBoundingClientRect();
          return r.left >= -0.5 && r.right <= vw + 0.5;
        }
      }
      return false;
    };
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (offenders.length >= 8) break;
      if (el instanceof SVGElement && el.ownerSVGElement) continue;   // report the <svg>, not each path
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > vw + 0.5 || r.left < -0.5) && !clippedInside(el)) offenders.push(describe(el));
    }
    const dialogs: string[] = [];
    for (const el of Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog]"))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const h = el as HTMLElement;
      if (r.left < -0.5 || r.right > vw + 0.5 || h.scrollWidth > h.clientWidth + 1) dialogs.push(`${describe(el)} scrollWidth ${h.scrollWidth} > ${h.clientWidth}`);
    }
    const smallFields: string[] = [];
    const fields = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=button]):not([type=submit]), select, textarea";
    for (const el of Array.from(document.querySelectorAll(fields))) {
      if (!visible(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) smallFields.push(`${describe(el)} ${size}px`);
    }
    return { pageOverflow: document.documentElement.scrollWidth - vw, dialogs, offenders, smallFields };
  });
}

/** Fails (softly, so one run lists every bad screen) when the state scrolls sideways or a field would make iOS zoom. */
export async function expectFitsScreen(page: Page, name: string, { phone = true }: { phone?: boolean } = {}) {
  const report = await measureLayout(page);
  expect.soft(report.pageOverflow, `${name}: page is wider than the screen. Sticking out: ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(0);
  expect.soft(report.dialogs, `${name}: dialog does not fit the screen`).toEqual([]);
  if (phone) expect.soft(report.smallFields, `${name}: fields under 16 px make iOS zoom in on focus`).toEqual([]);
  return report;
}
