export const solscanTxUrl = (signature: string) => `https://solscan.io/tx/${signature}`;
export const solscanAccountUrl = (address: string) => `https://solscan.io/account/${address}`;

export const RHC_EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";
export const blockscoutTxUrl = (hash: string) => `${RHC_EXPLORER_TX}${hash}`;
