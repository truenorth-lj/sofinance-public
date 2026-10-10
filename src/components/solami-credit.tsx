export function SolamiCredit({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[10px] uppercase tracking-wide text-neutral-600 ${className}`}>
      Powered by{" "}
      <a
        href="https://solami.dev"
        target="_blank"
        rel="noreferrer"
        className="text-neutral-400 underline decoration-neutral-700 underline-offset-2 hover:text-neutral-200"
      >
        Solami
      </a>
    </p>
  );
}
