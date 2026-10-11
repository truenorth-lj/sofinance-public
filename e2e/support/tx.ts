// Synthetic unsigned transactions for the sign page. Never broadcast: the broadcast route is mocked in this lane,
// and the blockhash is random so the network would reject them anyway.
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

export function randomAddress(): string {
  return bs58.encode(nacl.sign.keyPair().publicKey);
}

export type BuiltTx = { b64: string; tx: VersionedTransaction; payer: string; nftMint?: string };

/** 1-signer v0 transaction: wallet pays, 0-lamport self transfer. */
export function buildSingleSignerTx(payer: string): BuiltTx {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: bs58.encode(randomBytes(32)),
    instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(payer), toPubkey: new PublicKey(payer), lamports: 0 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { b64: Buffer.from(tx.serialize()).toString("base64"), tx, payer };
}

/**
 * 2-signer v0 transaction like open-position: wallet (payer) + a server-held NFT-mint keypair whose partial
 * signature is already present (slot 1). The wallet must fill slot 0 only and keep slot 1.
 */
export function buildOpenPositionTx(payer: string, options: { serverSigns?: boolean } = {}): BuiltTx & { nftMint: string } {
  const nft = nacl.sign.keyPair();
  const nftMint = bs58.encode(nft.publicKey);
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: bs58.encode(randomBytes(32)),
    instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(payer), toPubkey: new PublicKey(nftMint), lamports: 0 })],
  }).compileToV0Message();
  // make the NFT mint a required signer (slot 1): rebuild the header the way a 2-signer message looks
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  const nftIndex = keys.indexOf(nftMint);
  if (nftIndex !== 1) throw new Error(`unexpected account order: ${keys.join(",")}`);
  message.header.numRequiredSignatures = 2;
  message.header.numReadonlySignedAccounts = 0;
  const tx = new VersionedTransaction(message);
  if (options.serverSigns !== false) tx.signatures[1] = nacl.sign.detached(message.serialize(), nft.secretKey);
  return { b64: Buffer.from(tx.serialize()).toString("base64"), tx, payer, nftMint };
}
