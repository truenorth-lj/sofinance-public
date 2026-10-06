import { PublicKey } from "@solana/web3.js";
import { getTokenMetadata } from "@/lib/token-metadata";

export async function POST(request: Request) {
  let mints: string[];
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    const values = (body as Record<string, unknown>).mints;
    if (!Array.isArray(values) || values.length > 100 ||
      values.some((value) => typeof value !== "string" || new PublicKey(value).toBase58() !== value)) throw new Error();
    mints = [...new Set(values as string[])];
  } catch {
    return Response.json({ error: "Invalid token mint list" }, { status: 400 });
  }
  const tokens = await getTokenMetadata(mints);
  return Response.json({ tokens }, { headers: { "Cache-Control": "no-store" } });
}
