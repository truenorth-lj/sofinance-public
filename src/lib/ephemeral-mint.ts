import { PublicKey, type Signer } from "@solana/web3.js";
import nacl from "tweetnacl";

export type EphemeralMint = Signer & { dispose: () => void };

/** Own the exact mutable secret used for signing; web3 Keypair.secretKey is a copy.
 * Disposal clears this buffer only, not transient copies inside JS/crypto libraries.
 * Call immediately after signing, and in the operation's finally on every exit.
 */
export function createEphemeralMint(): EphemeralMint {
  const { publicKey, secretKey } = nacl.sign.keyPair();
  try {
    return { publicKey: new PublicKey(publicKey), secretKey, dispose: () => { secretKey.fill(0); } };
  } catch (error) {
    // Public-key conversion must not strand a secret allocated by the generator.
    secretKey.fill(0);
    throw error;
  }
}
