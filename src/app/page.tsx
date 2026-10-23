import { LandingPage } from "@/components/landing-page";

export const metadata = {
  title: "SoFinance",
  description:
    "LP tokenized stocks on Raydium — in one signature. Pick an xStock pool. The app picks the best backtest range — you can override it.",
};

export default function Home() {
  return <LandingPage />;
}
