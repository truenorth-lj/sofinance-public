/** Native wallet compatibility contracts; unrelated to generic trading admission. */
import type { Connection } from "@solana/web3.js";
import type { WalletDiscovery } from "@sofinance/engine/wallet-types";
import type { OrcaListedPosition, MeteoraListedPosition } from "@/lib/position-read-types";
export type NativeListedPosition = OrcaListedPosition | MeteoraListedPosition;
export type DiscoverNativeWallet = (wallet: string, connection?: Connection) => Promise<WalletDiscovery>;
export type NativeWalletListing = {
  read: (wallet: string) => Promise<NativeListedPosition[]>;
  unavailableMessage: string;
};
