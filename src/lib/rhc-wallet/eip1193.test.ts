// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectEvmWallet, discoverEvmWallets, type Eip1193Provider, ensureRobinhoodChain, guardedWalletRequest, RHC_ADD_CHAIN_PARAMS, SIGNING_METHODS, WalletRequestError,
} from "./eip1193";

const ADDR = "0x1111111111111111111111111111111111111111";
type Handler = (method: string, params?: unknown) => unknown;
const mockProvider = (handler: Handler) => {
  const calls: string[] = [];
  const provider: Eip1193Provider = { request: vi.fn(async ({ method, params }) => { calls.push(method); return handler(method, params); }) };
  return { provider, calls };
};
const rpcError = (code: number) => Object.assign(new Error(`code ${code}`), { code });

afterEach(() => { delete (window as unknown as { ethereum?: unknown }).ethereum; });

describe("discoverEvmWallets", () => {
  it("collects EIP-6963 announcements and puts MetaMask first", async () => {
    const other = mockProvider(() => null).provider, mm = mockProvider(() => null).provider;
    const announce = () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "a", name: "Other", rdns: "com.other" }, provider: other } }));
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "b", name: "MetaMask", rdns: "io.metamask" }, provider: mm } }));
    };
    window.addEventListener("eip6963:requestProvider", announce);
    const list = await discoverEvmWallets(window, 5);
    window.removeEventListener("eip6963:requestProvider", announce);
    expect(list.map(w => w.info.name)).toEqual(["MetaMask", "Other"]);
    expect(list[0]!.provider).toBe(mm);
  });
  it("falls back to window.ethereum, and returns nothing without a wallet", async () => {
    expect(await discoverEvmWallets(window, 5)).toEqual([]);
    const { provider } = mockProvider(() => null);
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    const list = await discoverEvmWallets(window, 5);
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe(provider);
  });
});

describe("connectEvmWallet", () => {
  it("returns the first account", async () => {
    expect(await connectEvmWallet(mockProvider(() => [ADDR]).provider)).toBe(ADDR);
  });
  it("maps a user rejection and an empty account list", async () => {
    await expect(connectEvmWallet(mockProvider(() => { throw rpcError(4001); }).provider)).rejects.toMatchObject({ code: "rejected" });
    await expect(connectEvmWallet(mockProvider(() => []).provider)).rejects.toMatchObject({ code: "no-account" });
  });
});

describe("ensureRobinhoodChain", () => {
  it("does nothing when already on 4663", async () => {
    const { provider, calls } = mockProvider(m => (m === "eth_chainId" ? "0x1237" : null));
    await ensureRobinhoodChain(provider);
    expect(calls).toEqual(["eth_chainId"]);
  });
  it("switches to 0x1237", async () => {
    let chain = "0x1";
    const { provider, calls } = mockProvider((m, p) => {
      if (m === "eth_chainId") return chain;
      if (m === "wallet_switchEthereumChain") { expect(p).toEqual([{ chainId: "0x1237" }]); chain = "0x1237"; return null; }
      throw new Error(`unexpected ${m}`);
    });
    await ensureRobinhoodChain(provider);
    expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
  });
  it("adds the chain on 4902 (unknown chain) with the public RPC and explorer", async () => {
    let chain = "0x1"; let added: unknown;
    const { provider, calls } = mockProvider((m, p) => {
      if (m === "eth_chainId") return chain;
      if (m === "wallet_switchEthereumChain") throw rpcError(4902);
      if (m === "wallet_addEthereumChain") { added = p; chain = "0x1237"; return null; }
      throw new Error(`unexpected ${m}`);
    });
    await ensureRobinhoodChain(provider);
    expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"]);
    expect(added).toEqual([RHC_ADD_CHAIN_PARAMS]);
    expect(RHC_ADD_CHAIN_PARAMS).toMatchObject({ chainId: "0x1237", rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] });
  });
  it("reports rejection and a wallet still on the wrong chain", async () => {
    await expect(ensureRobinhoodChain(mockProvider(m => { if (m === "eth_chainId") return "0x1"; throw rpcError(4001); }).provider)).rejects.toMatchObject({ code: "rejected" });
    await expect(ensureRobinhoodChain(mockProvider(m => (m === "eth_chainId" ? "0x1" : null)).provider)).rejects.toMatchObject({ code: "chain" });
  });
});

describe("guardedWalletRequest (signing off outside preview)", () => {
  it("refuses every signing/sending method without touching the wallet", async () => {
    const { provider, calls } = mockProvider(() => "0xsig");
    for (const method of SIGNING_METHODS) {
      const error = await guardedWalletRequest(provider, method, []).catch((e: unknown) => e) as WalletRequestError;
      expect(error).toBeInstanceOf(WalletRequestError);
      expect(error.code).toBe("signing-disabled");
    }
    expect(calls).toEqual([]);
  });
  it("only accepts signing methods", async () => {
    await expect(guardedWalletRequest(mockProvider(() => null).provider, "eth_chainId", [])).rejects.toMatchObject({ code: "unknown" });
  });
});
