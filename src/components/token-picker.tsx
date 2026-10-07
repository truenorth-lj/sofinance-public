"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, ShieldCheck, X } from "lucide-react";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { formatAmount } from "@/lib/amount";
import type { TokenMetadata } from "@/lib/token-metadata";
import type { WalletAsset } from "@/lib/wallet-discovery";

const token2022Program = TOKEN_2022_PROGRAM_ID.toBase58();
const short = (mint: string) => `${mint.slice(0, 5)}…${mint.slice(-5)}`;
const displayBalance = (asset: WalletAsset) => {
  const balance = formatAmount(asset.balance, asset.decimals);
  return balance === "0" && BigInt(asset.balance) > 0n ? "<0.000001" : balance;
};

export function assetMetadata(asset: WalletAsset, metadata: Record<string, TokenMetadata>) {
  const item = metadata[asset.mint];
  return item && item.decimals === asset.decimals &&
    (asset.kind === "native" || !item.tokenProgram || item.tokenProgram === asset.tokenProgram) ? item : null;
}

export function assetSymbol(asset: WalletAsset, item: TokenMetadata | null) {
  return asset.kind === "native" ? "SOL" : item?.symbol || short(asset.mint);
}

function assetName(asset: WalletAsset, item: TokenMetadata | null) {
  return asset.kind === "native" ? "Solana" : item?.name || "Name not indexed";
}

function TokenIcon({ symbol, icon }: { symbol: string; icon: string | null }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  return <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-neutral-800 bg-neutral-900 text-sm font-bold text-neutral-100">
    {icon && failedIcon !== icon ? <>
      {/* Icons come from a bounded list of HTTPS hosts validated by the server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedIcon(icon)} className="h-full w-full object-cover" />
    </> : symbol.slice(0, 2).toUpperCase()}
  </span>;
}

function AssetRow({ asset, item, selected, onSelect }: {
  asset: WalletAsset; item: TokenMetadata | null; selected: boolean; onSelect: () => void;
}) {
  const symbol = assetSymbol(asset, item);
  const content = <>
    <TokenIcon symbol={symbol} icon={item?.icon || null} />
    <span className="min-w-0 flex-1 text-left">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate text-sm font-semibold text-neutral-100 sm:text-base">{symbol}</span>
        {item?.isVerified && <ShieldCheck className="h-4 w-4 shrink-0 text-neutral-400" aria-label="Jupiter verified" />}
        {asset.tokenProgram === token2022Program && <span className="rounded-full border border-neutral-700 bg-neutral-800/50 px-1.5 py-0.5 text-[10px] text-neutral-400">Token-2022</span>}
      </span>
      <span className="mt-0.5 block truncate text-xs text-neutral-500">{assetName(asset, item)} · {short(asset.mint)}</span>
      {!asset.eligible && <span className="mt-1 block text-xs leading-4 text-neutral-500">{asset.reason || "Not available for deposit"}</span>}
    </span>
    <span className="shrink-0 text-right" title={formatAmount(asset.balance, asset.decimals, asset.decimals)}><span className="block text-sm font-medium tabular-nums text-neutral-200">{displayBalance(asset)}</span>{selected && <Check className="ml-auto mt-1 h-4 w-4 text-neutral-100" />}</span>
  </>;
  return asset.eligible
    ? <button type="button" onClick={onSelect} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-neutral-900/50 focus-visible:outline-2 focus-visible:outline-neutral-700 ${selected ? "bg-neutral-900" : ""}`}>{content}</button>
    : <div aria-disabled="true" className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 opacity-60">{content}</div>;
}

export function TokenPicker({ assets, selectedAsset, metadata, disabled, onSelect }: {
  assets: WalletAsset[]; selectedAsset: WalletAsset | undefined; metadata: Record<string, TokenMetadata>;
  disabled: boolean; onSelect: (kind: WalletAsset["kind"], mint: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); searchRef.current?.focus(); }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const search = query.trim().toLowerCase();
  const matching = assets.filter((asset) => {
    const item = assetMetadata(asset, metadata);
    return !search || [asset.mint, assetSymbol(asset, item), assetName(asset, item), asset.reason || ""]
      .some((value) => value.toLowerCase().includes(search));
  });
  const usable = matching.filter((asset) => asset.eligible);
  const unavailable = matching.filter((asset) => !asset.eligible);
  const selectedItem = selectedAsset ? assetMetadata(selectedAsset, metadata) : null;
  return <>
    <button ref={triggerRef} type="button" aria-labelledby="asset-label" aria-haspopup="dialog" aria-expanded={open}
      disabled={disabled} onClick={() => setOpen(true)}
      className="mt-2 flex min-h-20 w-full items-center gap-3 rounded-2xl border border-neutral-800 bg-[#0a0a0a] px-4 py-3 text-left transition-colors hover:border-neutral-700 focus-visible:outline-2 focus-visible:outline-neutral-700 disabled:cursor-not-allowed disabled:opacity-50">
      {selectedAsset ? <><TokenIcon symbol={assetSymbol(selectedAsset, selectedItem)} icon={selectedItem?.icon || null} />
        <span className="min-w-0 flex-1"><span className="block truncate text-base font-semibold text-neutral-100">{assetSymbol(selectedAsset, selectedItem)}</span><span className="block truncate text-xs text-neutral-500">{assetName(selectedAsset, selectedItem)} · {short(selectedAsset.mint)}</span></span>
        <span className="hidden shrink-0 text-right text-xs text-neutral-500 sm:block" title={formatAmount(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals)}>Balance<span className="mt-1 block text-sm font-semibold tabular-nums text-neutral-200">{displayBalance(selectedAsset)}</span></span>
      </> : <span className="flex-1 text-sm text-neutral-500">{assets.length ? "Select wallet asset" : "No wallet assets found"}</span>}
      <ChevronDown className="h-4 w-4 shrink-0 text-neutral-500" />
    </button>
    <dialog ref={dialogRef} aria-labelledby="asset-dialog-title" onClose={() => { setOpen(false); setQuery(""); triggerRef.current?.focus(); }}
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[85dvh] w-full max-w-none overflow-hidden rounded-t-[20px] border border-neutral-800 bg-[#050505] p-0 text-neutral-100 shadow-2xl shadow-black/60 backdrop:bg-black/80 backdrop:backdrop-blur-sm sm:inset-0 sm:m-auto sm:max-h-[78vh] sm:max-w-xl sm:rounded-[20px]">
      <div className="flex max-h-[85dvh] flex-col sm:max-h-[78vh]">
        <div className="border-b border-neutral-800 px-5 pb-4 pt-5 sm:px-6">
          <div className="flex items-start justify-between gap-4"><div><h2 id="asset-dialog-title" className="text-lg font-semibold text-neutral-100">Select input asset</h2><p className="mt-1 text-xs text-neutral-500">Only listing assets discovered in this wallet; verify name and mint.</p></div><button type="button" aria-label="Close asset selection" onClick={() => setOpen(false)} className="rounded-full p-2 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-100"><X className="h-5 w-5" /></button></div>
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-neutral-800 bg-[#0a0a0a] px-3.5 py-2.5 focus-within:border-neutral-700"><Search className="h-4 w-4 shrink-0 text-neutral-500" /><input ref={searchRef} type="search" aria-label="Search assets" placeholder="Search name、symbol or mint" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600" /></div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-5 pt-3 sm:px-3">
          {usable.length > 0 && <><p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-600">Available for input · {usable.length}</p>{usable.map((asset) => <AssetRow key={`${asset.kind}:${asset.mint}`} asset={asset} item={assetMetadata(asset, metadata)} selected={selectedAsset?.mint === asset.mint && selectedAsset.kind === asset.kind} onSelect={() => { onSelect(asset.kind, asset.mint); setOpen(false); }} />)}</>}
          {unavailable.length > 0 && <><p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-600">Not available for deposit · {unavailable.length}</p>{unavailable.map((asset) => <AssetRow key={`${asset.kind}:${asset.mint}`} asset={asset} item={assetMetadata(asset, metadata)} selected={false} onSelect={() => undefined} />)}</>}
          {!matching.length && <p className="px-3 py-12 text-center text-sm text-neutral-500">No wallet assets matching search criteria</p>}
        </div>
      </div>
    </dialog>
  </>;
}
