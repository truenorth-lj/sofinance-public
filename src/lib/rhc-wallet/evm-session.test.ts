// @vitest-environment happy-dom
// App-wide EVM session (nav "EVM wallet"): connect (MetaMask first → 4663), silent restore, wallet events, and a
// disconnect that clears only SoFinance's own state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredWallet, Eip1193Provider } from "./eip1193";
import { createEvmSession, EVM_SESSION_STORAGE_KEY } from "./evm-session";

const A = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04"; // the EVM test wallet
const B = "0x1111111111111111111111111111111111111111";

function mockWallet(name: string, rdns: string, { accounts = [A], chain = "0x1237", shared = [A] }: { accounts?: string[]; chain?: string; shared?: string[] } = {}) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const calls: string[] = [];
  const state = { chain };
  const provider: Eip1193Provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === "eth_requestAccounts") return accounts;
      if (method === "eth_accounts") return shared;
      if (method === "eth_chainId") return state.chain;
      if (method === "wallet_switchEthereumChain") { state.chain = "0x1237"; return null; }
      throw new Error(`unexpected ${method}`);
    }),
    on: (event, listener) => { (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(listener); },
    removeListener: (event, listener) => { handlers.get(event)?.delete(listener); },
  };
  const emit = (event: string, ...args: unknown[]) => handlers.get(event)?.forEach(l => l(...args));
  const listenerCount = () => [...handlers.values()].reduce((n, set) => n + set.size, 0);
  const wallet: DiscoveredWallet = { info: { uuid: rdns, name, rdns }, provider };
  return { wallet, provider, calls, emit, listenerCount, state };
}

const session = (wallets: DiscoveredWallet[]) => createEvmSession({ discover: async () => wallets, storage: () => localStorage });

beforeEach(() => localStorage.clear());

describe("connect", () => {
  it("uses the first discovered wallet (MetaMask first), switches to Robinhood Chain and remembers the wallet", async () => {
    const mm = mockWallet("MetaMask", "io.metamask", { chain: "0x1" });
    const s = session([mm.wallet]);
    const states: string[] = [];
    s.subscribe(() => states.push(s.getState().status));
    const wallet = await s.connect();
    expect(wallet).toMatchObject({ address: A, name: "MetaMask", provider: mm.provider });
    expect(mm.calls).toEqual(["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_chainId"]);
    expect(s.getState()).toMatchObject({ status: "connected", chainId: 4663, error: null });
    expect(states).toEqual(["connecting", "connected"]);
    expect(JSON.parse(localStorage.getItem(EVM_SESSION_STORAGE_KEY)!)).toEqual({ rdns: "io.metamask" });
  });

  it("shares one wallet prompt between concurrent callers (nav + dialog)", async () => {
    const mm = mockWallet("MetaMask", "io.metamask");
    const s = session([mm.wallet]);
    const [one, two] = await Promise.all([s.connect(), s.connect()]);
    expect(one).toBe(two);
    expect(mm.calls.filter(c => c === "eth_requestAccounts")).toHaveLength(1);
  });

  it("reports a missing wallet or a rejection without leaving a half-connected state", async () => {
    const none = session([]);
    await expect(none.connect()).rejects.toThrow("No EVM wallet found");
    expect(none.getState()).toMatchObject({ status: "idle", wallet: null, error: expect.stringContaining("No EVM wallet") });
    const mm = mockWallet("MetaMask", "io.metamask");
    (mm.provider.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("no"), { code: 4001 }));
    const s = session([mm.wallet]);
    await expect(s.connect()).rejects.toMatchObject({ code: "rejected" });
    expect(s.getState()).toMatchObject({ status: "idle", wallet: null });
    expect(mm.listenerCount()).toBe(0);
    s.dismissError();
    expect(s.getState().error).toBeNull();
  });

  it("a disconnect during the prompt wins: the late approval is not adopted", async () => {
    const mm = mockWallet("MetaMask", "io.metamask");
    let approve!: (v: unknown) => void;
    (mm.provider.request as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(r => { approve = r; }));
    const s = session([mm.wallet]);
    const pending = s.connect();
    await vi.waitFor(() => expect(approve).toBeTypeOf("function"));
    s.disconnect();
    approve([A]);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(s.getState()).toMatchObject({ status: "idle", wallet: null });
    expect(mm.listenerCount()).toBe(0);
  });
});

describe("restore on reload", () => {
  it("adopts the account the wallet already shares (eth_accounts) without a prompt or a chain switch", async () => {
    const mm = mockWallet("MetaMask", "io.metamask", { chain: "0x1" });
    const s = session([mm.wallet]);
    await s.restore();
    expect(s.getState()).toMatchObject({ status: "connected", wallet: { address: A }, chainId: 1 });
    expect(mm.calls).toEqual(["eth_accounts", "eth_chainId"]);
  });

  it("stays disconnected when nothing is shared, and prefers the wallet used last time", async () => {
    const none = mockWallet("MetaMask", "io.metamask", { shared: [] });
    const s = session([none.wallet]);
    await s.restore();
    expect(s.getState()).toMatchObject({ status: "idle", wallet: null });
    const mm = mockWallet("MetaMask", "io.metamask"), rabby = mockWallet("Rabby", "io.rabby", { shared: [B] });
    localStorage.setItem(EVM_SESSION_STORAGE_KEY, JSON.stringify({ rdns: "io.rabby" }));
    const s2 = session([mm.wallet, rabby.wallet]);
    await s2.restore();
    expect(s2.getState().wallet).toMatchObject({ name: "Rabby", address: B });
    expect(mm.calls).toEqual([]);
  });

  it("after Disconnect here, a reload does not silently reconnect; the next Connect clears that", async () => {
    const mm = mockWallet("MetaMask", "io.metamask");
    const s = session([mm.wallet]);
    await s.connect();
    s.disconnect();
    expect(s.getState()).toMatchObject({ status: "idle", wallet: null });
    expect(mm.listenerCount()).toBe(0);
    // Only our own state: no permission revoke or any other wallet request on disconnect.
    expect(mm.calls).not.toContain("wallet_revokePermissions");
    const reloaded = session([mm.wallet]);
    mm.calls.length = 0;
    await reloaded.restore();
    expect(reloaded.getState().wallet).toBeNull();
    expect(mm.calls).toEqual([]);
    await reloaded.connect();
    const again = session([mm.wallet]);
    await again.restore();
    expect(again.getState().wallet).toMatchObject({ address: A });
  });
});

describe("wallet events", () => {
  async function connected() {
    const mm = mockWallet("MetaMask", "io.metamask");
    const s = session([mm.wallet]);
    await s.connect();
    return { mm, s };
  }

  it("accountsChanged: a new account is a new wallet object; the same account is a no-op; [] clears", async () => {
    const { mm, s } = await connected();
    const before = s.getState().wallet;
    mm.emit("accountsChanged", [A.toUpperCase().replace("0X", "0x")]);
    expect(s.getState().wallet).toBe(before);
    mm.emit("accountsChanged", [B]);
    expect(s.getState().wallet).toMatchObject({ address: B, provider: mm.provider });
    expect(s.getState().wallet).not.toBe(before);
    mm.emit("accountsChanged", []);
    expect(s.getState()).toMatchObject({ status: "idle", wallet: null });
    expect(mm.listenerCount()).toBe(0);
  });

  it("chainChanged updates only the chain hint; disconnect clears", async () => {
    const { mm, s } = await connected();
    const before = s.getState().wallet;
    mm.emit("chainChanged", "0x1");
    expect(s.getState()).toMatchObject({ chainId: 1, status: "connected" });
    expect(s.getState().wallet).toBe(before);
    mm.emit("chainChanged", "0x1237");
    expect(s.getState().chainId).toBe(4663);
    mm.emit("disconnect", { code: 4900 });
    expect(s.getState()).toMatchObject({ status: "idle", wallet: null, chainId: null });
  });

  it("ignores events from a wallet that is no longer the session's", async () => {
    const { mm, s } = await connected();
    const rabby = mockWallet("Rabby", "io.rabby", { accounts: [B] });
    const s2 = createEvmSession({ discover: async () => [rabby.wallet], storage: () => localStorage });
    await s2.connect();
    s.disconnect();
    mm.emit("accountsChanged", [A]);
    expect(s.getState().wallet).toBeNull();
    expect(s2.getState().wallet).toMatchObject({ address: B });
  });
});
