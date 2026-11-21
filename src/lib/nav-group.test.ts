import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { navGroup, type NavGroup } from "./nav-group";

const APP_DIR = resolveAppDir();

function resolveAppDir(): string {
  return join(process.cwd(), "src/app");
}

/** Every App Router `page.tsx` / `page.ts` under `src/app`, excluding route handlers. */
function listPageRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "api") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name !== "page.tsx" && name !== "page.ts") continue;
      const rel = relative(APP_DIR, dir).replaceAll("\\", "/");
      routes.push(rel === "" ? "/" : `/${rel}`);
    }
  };
  walk(APP_DIR);
  return routes.sort();
}

function expectedGroup(route: string): NavGroup {
  return navGroup(route);
}

describe("navGroup", () => {
  const routes = listPageRoutes();

  it("enumerates every App Router page and assigns each a group", () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain("/");
    expect(routes).toContain("/pools/[slug]");
    expect(routes).toContain("/app/portfolio");
    expect(routes).toContain("/app/ai");
    expect(routes).toContain("/app/sign/[token]");
    expect(routes).toContain("/blog/[slug]");
    expect(routes).toContain("/docs");
    expect(routes).toContain("/faq");
    for (const route of routes) {
      const group = navGroup(route);
      expect(["marketing", "app"], route).toContain(group);
      expect(group).toBe(expectedGroup(route));
    }
  });

  it("puts /pools, pool pages, and /app/* in the app group", () => {
    expect(navGroup("/pools")).toBe("app");
    expect(navGroup("/pools/")).toBe("app");
    expect(navGroup("/pools/tsla-tslax")).toBe("app");
    expect(navGroup("/pools/[slug]")).toBe("app");
    expect(navGroup("/app")).toBe("app");
    expect(navGroup("/app/portfolio")).toBe("app");
    expect(navGroup("/app/portfolio/recovery")).toBe("app");
    expect(navGroup("/app/ai")).toBe("app");
    expect(navGroup("/app/sign/abc")).toBe("app");
    expect(navGroup("/app/sign/[token]")).toBe("app");
    expect(navGroup("/app/plan")).toBe("app");
    expect(navGroup("/app/rhc")).toBe("app");
    expect(navGroup("/app/rwa-pairs")).toBe("app");
    expect(navGroup("/app/position-performance")).toBe("app");
  });

  it("defaults unlisted routes, marketing pages, and the root 404 to marketing", () => {
    for (const route of [
      "/",
      "/learn",
      "/learn/how-to-open-an-lp-position",
      "/fees",
      "/use-cases/tsla-same-stock-lp",
      "/blog",
      "/blog/xstocks-xpoints",
      "/terms",
      "/faq",
      "/docs",
      "/docs/fees",
      "/docs/fee-apr",
      "/docs/risks",
      "/docs/withdraw",
      "/docs/security",
      "/this-page-does-not-exist",
      "/privacy",
    ]) {
      expect(navGroup(route), route).toBe("marketing");
    }
    // Prefix must not swallow similarly named paths.
    expect(navGroup("/pools-old")).toBe("marketing");
    expect(navGroup("/application")).toBe("marketing");
    expect(navGroup("/apple")).toBe("marketing");
  });

  it("prints a complete route → group table so a new page is reviewed", () => {
    const table = Object.fromEntries(routes.map((route) => [route, navGroup(route)]));
    expect(table).toMatchInlineSnapshot(`
      {
        "/": "marketing",
        "/app": "app",
        "/app/ai": "app",
        "/app/plan": "app",
        "/app/portfolio": "app",
        "/app/portfolio/recovery": "app",
        "/app/position-performance": "app",
        "/app/rhc": "app",
        "/app/rwa-pairs": "app",
        "/app/sign/[token]": "app",
        "/blog": "marketing",
        "/blog/[slug]": "marketing",
        "/docs": "marketing",
        "/docs/fee-apr": "marketing",
        "/docs/fees": "marketing",
        "/docs/risks": "marketing",
        "/docs/security": "marketing",
        "/docs/withdraw": "marketing",
        "/faq": "marketing",
        "/fees": "marketing",
        "/learn": "marketing",
        "/learn/[slug]": "marketing",
        "/pools/[slug]": "app",
        "/terms": "marketing",
        "/use-cases/[slug]": "marketing",
      }
    `);
  });
});
