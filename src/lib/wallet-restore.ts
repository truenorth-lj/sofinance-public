/** Shown when restoring the remembered Solana wallet fails or never finishes (a locked extension, a closed popup). */
export const WALLET_RESTORE_FAILED = "Wallet restoration failed, please reconnect.";

const OPEN_PICKER_AFTER_RELOAD = "sofi:open-wallet-picker";
// AppKit's own storage keys for the remembered Solana connector (also read by hasRememberedHomepageWallet).
// Verified against @reown/appkit 1.8.24; wallet-restore.appkit-keys.test.ts fails when AppKit is upgraded or the keys
// change, so re-check them (and update APPKIT_STORAGE_KEYS_VERIFIED_VERSION) on every AppKit bump.
export const APPKIT_STORAGE_KEYS_VERIFIED_VERSION = "1.8.24";
export const APPKIT_SOLANA_CONNECTOR = "@appkit/solana:connected_connector_id";
export const APPKIT_CONNECTIONS = "@appkit/connections";

/**
 * AppKit cannot cancel a restore whose wallet never answers, and if that wallet answers later it replaces whatever the
 * visitor picked by hand. So a retry while the restore is still pending forgets the remembered Solana wallet and reloads
 * (which drops the pending call); the page then opens the picker once by itself. Returns false when storage is blocked.
 */
export function abandonStalledRestore(): boolean {
  try {
    const storage = window.localStorage;
    storage.removeItem(APPKIT_SOLANA_CONNECTOR);
    const connections = JSON.parse(storage.getItem(APPKIT_CONNECTIONS) || "null");
    if (connections && typeof connections === "object" && "solana" in connections) {
      storage.setItem(APPKIT_CONNECTIONS, JSON.stringify({ ...connections, solana: [] }));
    }
    window.sessionStorage.setItem(OPEN_PICKER_AFTER_RELOAD, "1");
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Peek (does not consume): the wallet providers must load after the reload even though no wallet is remembered now. */
export function hasPickerRequestAfterReload(): boolean {
  try {
    return window.sessionStorage.getItem(OPEN_PICKER_AFTER_RELOAD) === "1";
  } catch {
    return false;
  }
}

/** True once after abandonStalledRestore's reload: the visitor already asked for the picker. */
export function takePickerRequestAfterReload(): boolean {
  try {
    if (window.sessionStorage.getItem(OPEN_PICKER_AFTER_RELOAD) !== "1") return false;
    window.sessionStorage.removeItem(OPEN_PICKER_AFTER_RELOAD);
    return true;
  } catch {
    return false;
  }
}
