import { RecoveryPage } from "@/components/portfolio/recovery-page";

export const metadata = {
  title: "Recover leftover compound balances",
  description: "Find balances older compounds left in harvest accounts your wallet controls, and move them back into your wallet.",
};

export default async function PortfolioRecovery({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { position } = await searchParams;
  return <RecoveryPage positionKey={Array.isArray(position) ? position[0] ?? "" : position ?? ""} />;
}
