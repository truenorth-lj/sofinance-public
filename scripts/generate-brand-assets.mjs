import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANVAS = "#0a0a0a";

function innerMark(svg) {
  return svg
    .replace(/<\?xml[^>]*>/i, "")
    .replace(/<svg[^>]*>/i, "")
    .replace(/<\/svg>/i, "")
    .trim();
}

function withCanvas(markInner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${CANVAS}"/>
  ${markInner}
</svg>
`;
}

function pngToIco(images) {
  const count = images.length;
  const headerSize = 6 + 16 * count;
  let offset = headerSize;
  const entries = images.map(({ buf, size }) => {
    const entry = { buf, size, offset, byteLength: buf.length };
    offset += buf.length;
    return entry;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(count, 4);
  let cursor = 6;
  for (const entry of entries) {
    const icoDim = entry.size >= 256 ? 0 : entry.size;
    out.writeUInt8(icoDim, cursor);
    out.writeUInt8(icoDim, cursor + 1);
    out.writeUInt8(0, cursor + 2);
    out.writeUInt8(0, cursor + 3);
    out.writeUInt16LE(1, cursor + 4);
    out.writeUInt16LE(32, cursor + 6);
    out.writeUInt32LE(entry.byteLength, cursor + 8);
    out.writeUInt32LE(entry.offset, cursor + 12);
    cursor += 16;
  }
  for (const entry of entries) {
    entry.buf.copy(out, entry.offset);
  }
  return out;
}

async function raster(svg, size) {
  return sharp(Buffer.from(svg))
    .resize(size, size, { fit: "fill" })
    .png()
    .toBuffer();
}

async function main() {
  const markPath = path.join(root, "src/brand/sofinance-mark.svg");
  const mark = fs.readFileSync(markPath, "utf8");
  const faviconSvg = withCanvas(innerMark(mark));

  const appDir = path.join(root, "src/app");
  const publicDir = path.join(root, "public");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  fs.writeFileSync(path.join(appDir, "icon.svg"), faviconSvg);
  fs.writeFileSync(path.join(publicDir, "favicon.svg"), faviconSvg);

  const pngSizes = {
    "public/favicon-16.png": 16,
    "public/favicon-32.png": 32,
    "src/app/apple-icon.png": 180,
    "public/apple-touch-icon.png": 180,
    "public/icon-192.png": 192,
    "public/icon-512.png": 512,
  };

  for (const [rel, size] of Object.entries(pngSizes)) {
    const buf = await raster(faviconSvg, size);
    fs.writeFileSync(path.join(root, rel), buf);
  }

  const ico = pngToIco([
    { size: 16, buf: await raster(faviconSvg, 16) },
    { size: 32, buf: await raster(faviconSvg, 32) },
    { size: 48, buf: await raster(faviconSvg, 48) },
  ]);
  fs.writeFileSync(path.join(appDir, "favicon.ico"), ico);
  fs.writeFileSync(path.join(publicDir, "favicon.ico"), ico);

  console.log("Generated C3 brand assets (white mark on #0a0a0a).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
