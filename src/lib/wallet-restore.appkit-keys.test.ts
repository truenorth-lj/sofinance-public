// The stuck-restore retry (abandonStalledRestore) and hasRememberedHomepageWallet read AppKit's own localStorage keys.
// AppKit does not export them to us, so this fails on an AppKit upgrade or a key change instead of the retry silently
// no longer clearing the stuck wallet.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { APPKIT_CONNECTIONS, APPKIT_SOLANA_CONNECTOR, APPKIT_STORAGE_KEYS_VERIFIED_VERSION } from "./wallet-restore";

// pnpm keeps @reown/appkit-common (where the keys live) next to the installed @reown/appkit.
const appkitDir = realpathSync(resolve("node_modules/@reown/appkit"));
const commonDir = resolve(dirname(appkitDir), "appkit-common");
const version = (dir: string) => (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { version: string }).version;

describe("AppKit storage keys used by the stuck-restore retry", () => {
  it("were verified against the installed AppKit version (re-check the keys, then bump the constant)", () => {
    expect(version(appkitDir)).toBe(APPKIT_STORAGE_KEYS_VERIFIED_VERSION);
    expect(version(commonDir)).toBe(APPKIT_STORAGE_KEYS_VERIFIED_VERSION);
  });

  it("are the keys the installed AppKit actually reads and writes", async () => {
    const storage = await import(/* @vite-ignore */ pathToFileURL(resolve(commonDir, "dist/esm/src/utils/SafeLocalStorage.js")).href) as {
      getSafeConnectorIdKey: (namespace: string) => string;
      SafeLocalStorageKeys: { CONNECTIONS: string };
    };
    expect(storage.getSafeConnectorIdKey("solana")).toBe(APPKIT_SOLANA_CONNECTOR);
    expect(storage.SafeLocalStorageKeys.CONNECTIONS).toBe(APPKIT_CONNECTIONS);
  });
});
