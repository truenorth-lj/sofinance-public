/**
 * Blocked-region copy. Title and body match `region.blocked` in sofinance-app-prototype
 * (src/copy/main.ts) so both products say the same thing.
 */
export const REGION_BLOCKED_COPY = {
  title: "Not available in your region",
  body: "We can't offer SoFinance where you're connecting from right now.",
  whatYouCanDo: "What you can do",
  tips: [
    "If you use a VPN or are travelling, turn the VPN off or reconnect from home, then try again.",
    "Check back later. We may add more places over time.",
    "No deposit was made and nothing was charged.",
  ],
  exitHeading: "Already have a position? You can always exit.",
  exitBody: "Withdrawals are never blocked. Connect the wallet that holds the position and withdraw it here, or manage the position NFT directly on Raydium.",
  exitAction: "Withdraw a position",
  raydiumAction: "Open Raydium portfolio",
} as const;

export const RAYDIUM_PORTFOLIO_URL = "https://raydium.io/portfolio/";
