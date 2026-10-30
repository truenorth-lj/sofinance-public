// Generates public/og.png (1200x630), the default Open Graph / Twitter card image. Run: pnpm og:image
// Copy rule: no APR or other numbers that can go stale or read as a promise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1200;
const H = 630;
const C = { canvas: "#0b0b0b", char: "#151514", cream: "#f4f0e6", smoke: "#9a968c", lemon: "#f3e76b", mint: "#84e9c5", lilac: "#cdc6ff" };
const SANS = "'Host Grotesk', 'Inter', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'Geist Mono', 'IBM Plex Mono', monospace";

const chip = (x, label, color) => {
  const w = 34 + label.length * 13.2;
  return {
    w,
    svg: `<g transform="translate(${x} 0)"><rect width="${w}" height="48" rx="24" fill="none" stroke="${color}" stroke-opacity="0.7" stroke-width="2"/>
    <text x="${w / 2}" y="31" text-anchor="middle" font-family="${MONO}" font-size="20" letter-spacing="1" fill="${color}">${label}</text></g>`,
  };
};

let x = 0;
const chips = [
  ["SAME-STOCK POOLS", C.lemon],
  ["SOLANA", C.mint],
  ["ROBINHOOD CHAIN", C.lilac],
  ["SELF-CUSTODIAL", C.cream],
].map(([label, color]) => {
  const c = chip(x, label, color);
  x += c.w + 14;
  return c.svg;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.canvas}"/>
  <rect x="32" y="32" width="${W - 64}" height="${H - 64}" rx="40" fill="${C.char}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2"/>
  <g transform="translate(88 92) scale(1.25)">
    <circle cx="32" cy="32" r="8" fill="${C.cream}"/>
    <path d="M54 25.28A23 23 0 1 1 38.72 10" stroke="${C.cream}" stroke-width="3.5" stroke-linecap="round" fill="none"/>
    <circle cx="48.26" cy="15.74" r="6" fill="${C.lemon}"/>
  </g>
  <text x="186" y="146" font-family="${SANS}" font-size="40" font-weight="600" fill="${C.cream}" letter-spacing="-0.5">SoFinance</text>
  <text x="88" y="300" font-family="${SANS}" font-size="76" font-weight="600" fill="${C.cream}" letter-spacing="-2.5">Collect trading fees</text>
  <text x="88" y="384" font-family="${SANS}" font-size="76" font-weight="600" fill="${C.lemon}" letter-spacing="-2.5">on tokenized stocks</text>
  <text x="88" y="446" font-family="${SANS}" font-size="28" fill="${C.smoke}">Pair two tokens of the same stock in one pool. Your wallet, your keys.</text>
  <g transform="translate(88 494)">${chips.join("")}</g>
  <text x="${W - 88}" y="146" text-anchor="end" font-family="${MONO}" font-size="22" letter-spacing="1" fill="${C.smoke}">sofinancelab.xyz</text>
</svg>`;

const out = path.join(root, "public/og.png");
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
const meta = await sharp(out).metadata();
console.log(`wrote ${path.relative(root, out)} ${meta.width}x${meta.height}`);
