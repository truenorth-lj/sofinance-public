import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Plan · SoFinance",
  description:
    "Say when you want your money back, how much you would put in and what you are aiming for. Compare SoFinance with a flat hold using the pool's past average yield. Read-only.",
};

export default function PlanLayout({ children }: { children: React.ReactNode }) {
  return children;
}
