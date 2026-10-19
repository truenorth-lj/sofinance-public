import { SelectedApp } from "@/components/selected-app";

export const metadata = {
  title: "Withdraw · SoFinance",
  description: "Withdraw an existing Raydium CLMM position. Always available, including from restricted regions.",
};

/** Exit-only view: lists the wallet's positions and the withdraw panel, nothing that adds exposure. */
export default function ExitPage() {
  return <SelectedApp exitOnly initialView="withdraw" />;
}
