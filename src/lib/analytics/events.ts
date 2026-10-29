import { walletEventProperties } from "./internal-wallets";

export const GROWTH_EVENTS = {
  rwaPairsView: "rwa_pairs_view",
  walletConnectClicked: "wallet_connect_clicked",
  walletConnected: "wallet_connected",
  performanceView: "performance_view",
  openStarted: "open_position_started",
  openSuccess: "open_position_success",
  openFailed: "open_position_failed",
} as const;

export type GrowthEventName = (typeof GROWTH_EVENTS)[keyof typeof GROWTH_EVENTS];

export type OpenEventProperties = {
  pool?: string;
  pair?: string;
  wallet_address?: string;
  is_internal?: boolean;
  input_kind?: "native" | "token";
  /** Two-step SOL open only: which step failed (1 = SOL -> pool-token swap, 2 = token-input open). */
  open_step?: 1 | 2;
  /** Two-step SOL open only: true when step 2/2 resumed from a stored step-1 receipt ("Continue open (2/2)"). */
  open_resumed?: boolean;
};

export type OpenEventContext = {
  /** Connected wallet's public address (tagged with `is_internal`). */
  wallet?: string | null;
  inputKind?: "native" | "token" | null;
};

export function openEventProperties(pair: {
  poolAddress: string;
  symbolA: string;
  symbolB: string;
} | null | undefined, context: OpenEventContext = {}): OpenEventProperties {
  const properties: OpenEventProperties = context.wallet ? walletEventProperties(context.wallet) : {};
  if (context.inputKind) properties.input_kind = context.inputKind;
  if (!pair) return properties;
  if (pair.poolAddress) properties.pool = pair.poolAddress;
  if (pair.symbolA && pair.symbolB) properties.pair = `${pair.symbolA}/${pair.symbolB}`;
  return properties;
}
