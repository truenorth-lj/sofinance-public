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
};

export function openEventProperties(pair: {
  poolAddress: string;
  symbolA: string;
  symbolB: string;
} | null | undefined): OpenEventProperties {
  if (!pair) return {};
  const properties: OpenEventProperties = {};
  if (pair.poolAddress) properties.pool = pair.poolAddress;
  if (pair.symbolA && pair.symbolB) properties.pair = `${pair.symbolA}/${pair.symbolB}`;
  return properties;
}
