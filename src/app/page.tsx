import { LandingPage } from "@/components/landing-page";

export const metadata = {
  title: "SoFinance",
  description:
    "Hold the stock. Collect the fees. Your $TSLA, $MSTR or $SPCX tokens can collect trading fees from swaps in Raydium pools. We show the estimated APR and a 7-day backtest before you sign. Not guaranteed; risks apply.",
};

export default function Home() {
  return <LandingPage />;
}
