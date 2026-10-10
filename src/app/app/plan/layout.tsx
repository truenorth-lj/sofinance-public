import type { Metadata } from "next";
import { Geist_Mono, Host_Grotesk } from "next/font/google";

const display = Host_Grotesk({ subsets: ["latin"], variable: "--font-plan-display" });
const data = Geist_Mono({ subsets: ["latin"], variable: "--font-plan-mono" });

export const metadata: Metadata = {
  title: "Plan · SoFinance",
  description:
    "Say when you want your money back, how much you would put in and what you are aiming for. See what it would take on sample market paths. Read-only.",
};

export default function PlanLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${display.variable} ${data.variable} font-display`}>{children}</div>;
}
