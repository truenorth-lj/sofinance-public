import { defineChain } from "viem";

/** Chain families the engine knows. Solana code paths are unchanged; EVM is read-only so far. */
export type ChainFamily = "solana" | "evm";

/** Robinhood Chain mainnet (Arbitrum Orbit L2, gas in ETH). docs.robinhood.com/chain/connecting */
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";
/** Multicall3 (canonical CREATE2 address; code verified on 4663 on 2026-10-29). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_EXPLORER_URL } },
  contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
});
