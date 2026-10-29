import { isRhcUniv4WalletSigningEnabled } from "@/lib/protocol-flags";

/**
 * Minimal injected EVM wallet access for Robinhood Chain (design §6 PR5). MetaMask first via EIP-6963, then
 * `window.ethereum`. Connect and add/switch chain are allowed; every request that signs or sends goes through
 * `guardedWalletRequest`, which refuses while `RHC_UNIV4_WALLET_SIGNING_ENABLED` is off (all targets until PR6).
 */

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export type EvmWalletInfo = { uuid: string; name: string; rdns: string; icon?: string };
export type DiscoveredWallet = { info: EvmWalletInfo; provider: Eip1193Provider };

export const RHC_CHAIN_ID = 4663;
export const RHC_CHAIN_ID_HEX = "0x1237";

/** `wallet_addEthereumChain` params (docs.robinhood.com/chain/connecting). Public RPC only; no keys. */
export const RHC_ADD_CHAIN_PARAMS = Object.freeze({
  chainId: RHC_CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
});

const METAMASK_RDNS = "io.metamask";

/** EIP-6963 discovery; MetaMask sorted first. Falls back to `window.ethereum` when nothing announces. */
export async function discoverEvmWallets(win: Window = window, waitMs = 200): Promise<DiscoveredWallet[]> {
  const found = new Map<string, DiscoveredWallet>();
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<DiscoveredWallet>).detail;
    if (detail?.info?.uuid && detail.provider) found.set(detail.info.uuid, detail);
  };
  win.addEventListener("eip6963:announceProvider", onAnnounce);
  win.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise(resolve => setTimeout(resolve, waitMs));
  win.removeEventListener("eip6963:announceProvider", onAnnounce);
  const list = [...found.values()];
  const injected = (win as unknown as { ethereum?: { request?: unknown } }).ethereum;
  if (!list.length && typeof injected?.request === "function") list.push({ info: { uuid: "injected", name: "Browser wallet", rdns: "injected" }, provider: injected as Eip1193Provider });
  return list.sort((a, b) => Number(b.info.rdns === METAMASK_RDNS) - Number(a.info.rdns === METAMASK_RDNS));
}

export class WalletRequestError extends Error {
  constructor(readonly code: "rejected" | "no-account" | "chain" | "signing-disabled" | "unknown", message: string) {
    super(message);
    this.name = "WalletRequestError";
  }
}

const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined);

export async function connectEvmWallet(provider: Eip1193Provider): Promise<`0x${string}`> {
  let accounts: unknown;
  try { accounts = await provider.request({ method: "eth_requestAccounts" }); } catch (error) {
    if (errorCode(error) === 4001) throw new WalletRequestError("rejected", "Connection request was rejected in the wallet");
    throw new WalletRequestError("unknown", "Wallet connection failed");
  }
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new WalletRequestError("no-account", "Wallet returned no account");
  return first as `0x${string}`;
}

export async function currentChainId(provider: Eip1193Provider): Promise<number | null> {
  const id = await provider.request({ method: "eth_chainId" }).catch(() => null);
  return typeof id === "string" ? Number.parseInt(id, 16) : null;
}

/** Switch to 4663; add it first when the wallet does not know it (4902, or -32603 on some mobile wallets). */
export async function ensureRobinhoodChain(provider: Eip1193Provider): Promise<void> {
  if (await currentChainId(provider) === RHC_CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RHC_CHAIN_ID_HEX }] });
  } catch (error) {
    const code = errorCode(error);
    if (code === 4001) throw new WalletRequestError("rejected", "Network switch was rejected in the wallet");
    if (code !== 4902 && code !== -32603) throw new WalletRequestError("chain", "Could not switch to Robinhood Chain");
    try {
      await provider.request({ method: "wallet_addEthereumChain", params: [RHC_ADD_CHAIN_PARAMS] });
    } catch (addError) {
      if (errorCode(addError) === 4001) throw new WalletRequestError("rejected", "Adding Robinhood Chain was rejected in the wallet");
      throw new WalletRequestError("chain", "Could not add Robinhood Chain");
    }
  }
  if (await currentChainId(provider) !== RHC_CHAIN_ID) throw new WalletRequestError("chain", "Wallet is not on Robinhood Chain");
}

/** Wallet methods that sign or send. Only reachable through `guardedWalletRequest`. */
export const SIGNING_METHODS: ReadonlySet<string> = new Set(["eth_sendTransaction", "eth_signTypedData_v4", "personal_sign", "eth_sign", "wallet_sendCalls"]);

export const SIGNING_DISABLED_MESSAGE = "Wallet signing is off until real signing is approved (PR6). Nothing was sent to your wallet.";

/**
 * The only path to a signing/sending wallet request. Refuses (without touching the wallet) while
 * `RHC_UNIV4_WALLET_SIGNING_ENABLED` is off; it is off on every target in this PR.
 */
export async function guardedWalletRequest(provider: Eip1193Provider, method: string, params: unknown[]): Promise<unknown> {
  if (!SIGNING_METHODS.has(method)) throw new WalletRequestError("unknown", `Not a signing method: ${method}`);
  if (!isRhcUniv4WalletSigningEnabled()) throw new WalletRequestError("signing-disabled", SIGNING_DISABLED_MESSAGE);
  try { return await provider.request({ method, params }); } catch (error) {
    if (errorCode(error) === 4001) throw new WalletRequestError("rejected", "You rejected the request in your wallet. Nothing was sent.");
    throw new WalletRequestError("unknown", plainWalletError(error));
  }
}

export const NOT_ENOUGH_GAS_MESSAGE = "Not enough ETH on Robinhood Chain to pay for gas. Add some ETH to this wallet, then try again.";

/** Plain-language cause for a failed wallet request (wallets put the node's reason in `message` / `data.message`). */
export function plainWalletError(error: unknown): string {
  const parts: string[] = [];
  let e: unknown = error;
  for (let i = 0; i < 6 && e && typeof e === "object"; i++) {
    const o = e as { message?: unknown; data?: unknown; cause?: unknown };
    if (typeof o.message === "string") parts.push(o.message);
    if (o.data && typeof o.data === "object" && typeof (o.data as { message?: unknown }).message === "string") parts.push((o.data as { message: string }).message);
    e = o.cause ?? (o.data && typeof o.data === "object" ? o.data : undefined);
  }
  const text = parts.join(" ");
  if (/insufficient funds|exceeds balance|not enough (eth|funds)/i.test(text)) return NOT_ENOUGH_GAS_MESSAGE;
  if (/nonce too low|replacement transaction/i.test(text)) return "Your wallet has another pending transaction. Wait for it to confirm, then try again.";
  if (/execution reverted|revert/i.test(text)) return "The wallet says this transaction would fail on chain. Nothing was sent. Preview again.";
  if (/disconnected|not connected|locked/i.test(text)) return "Your wallet is locked or disconnected. Unlock it and try again.";
  return "Your wallet could not complete the request. Nothing was sent. Please try again.";
}
