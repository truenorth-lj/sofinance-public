import { describe, expect, it } from "vitest";
import { ICON_HOSTS, trustedIcon } from "@sofinance/engine/token-metadata";
import { displayIconUrl, ICON_IPFS_GATEWAY } from "./gateway";

describe("displayIconUrl", () => {
  it("moves ipfs.io /ipfs/ links (the INTCx icons) to the public Filebase gateway", () => {
    expect(displayIconUrl("https://ipfs.io/ipfs/QmQ7v81i32kLMTSrPRWTCih5AVFZzxkwuSr2u6bf484Q9o"))
      .toBe("https://ipfs.filebase.io/ipfs/QmQ7v81i32kLMTSrPRWTCih5AVFZzxkwuSr2u6bf484Q9o");
    expect(displayIconUrl("https://ipfs.io/ipfs/bafkreie4taccncoctrejjrym5i3o72pmfwfcnof3hms5vdldaqwzuij7cu/logo.png?x=1"))
      .toBe("https://ipfs.filebase.io/ipfs/bafkreie4taccncoctrejjrym5i3o72pmfwfcnof3hms5vdldaqwzuij7cu/logo.png?x=1");
  });

  it("leaves every other link alone", () => {
    for (const icon of ["https://static.jup.ag/x.png", "https://ipfs.io/ipns/foo", "http://ipfs.io/ipfs/Qm1", "not a url"]) {
      expect(displayIconUrl(icon)).toBe(icon);
    }
  });

  it("points at a host the icon allowlist accepts", () => {
    expect(ICON_HOSTS.has(new URL(ICON_IPFS_GATEWAY).hostname)).toBe(true);
    expect(trustedIcon(`${ICON_IPFS_GATEWAY}/ipfs/Qm1`)).toBe(`${ICON_IPFS_GATEWAY}/ipfs/Qm1`);
  });
});
