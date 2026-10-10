export function SolamiCredit({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[10px] uppercase tracking-wide text-smoke/70 ${className}`}>
      Powered by{" "}
      <a
        href="https://solami.dev"
        target="_blank"
        rel="noreferrer"
        className="text-smoke underline decoration-white/30 underline-offset-2 hover:text-cream/90"
      >
        Solami
      </a>
    </p>
  );
}
