/**
 * Public IPFS gateway used to show token icons in the browser. ipfs.io rate-limits shared traffic (HTTP 429) and its
 * error responses get blocked as cross-site images, so icons stored as `https://ipfs.io/ipfs/<cid>` showed only the
 * letter fallback. Filebase's public gateway serves the same content-addressed files with `Access-Control-Allow-Origin: *`
 * and no `Cross-Origin-Resource-Policy`, so a cross-site `<img>` loads (checked on the INTCx icon CIDs). The browser loads
 * it directly; there is no server-side proxy.
 */
export const ICON_IPFS_GATEWAY = "https://ipfs.filebase.io";

/** The icon link to put in `<img src>`: ipfs.io `/ipfs/…` links move to `ICON_IPFS_GATEWAY`; anything else is unchanged. */
export function displayIconUrl(icon: string): string {
  try {
    const url = new URL(icon);
    if (url.protocol !== "https:" || url.hostname !== "ipfs.io" || !url.pathname.startsWith("/ipfs/")) return icon;
    return `${ICON_IPFS_GATEWAY}${url.pathname}${url.search}`;
  } catch { return icon; }
}
