import { LandingPage } from "@/components/landing-page";

export const metadata = {
  title: "SoFinance",
  description:
    "A self-custodial tool to manage your Raydium CLMM positions: one-signature opening, one-click compounding and one-click exit. You sign every transaction, from the web app or through an AI agent via MCP.",
};

export default function Home() {
  return <LandingPage />;
}
