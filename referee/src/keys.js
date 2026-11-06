// Deterministic NEAR keys from one secret seed (the DUEL_SEED repo secret).
// Lets GitHub Actions re-create the same contract / referee keys on every
// run without storing private keys anywhere.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { encodeBase58 } from "ethers";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function deriveKey(seed, label) {
  if (!seed || seed.length < 16) throw new Error("DUEL_SEED must be at least 16 characters");
  const priv = createHash("sha256").update(`duel:${label}:${seed}`).digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, priv]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    secretKey: `ed25519:${encodeBase58(Buffer.concat([priv, pub]))}`,
    publicKey: `ed25519:${encodeBase58(pub)}`,
  };
}

/** Account names derived from the seed, e.g. duel-3fa9c1d2.testnet */
export function accountsFor(seed, network = "testnet") {
  const tag = createHash("sha256").update(`duel:name:${seed}`).digest("hex").slice(0, 8);
  const contract = `duel-${tag}.${network}`;
  return {
    contract,
    referee: `referee.${contract}`,
    alice: `taj.${contract}`,
    bob: `truth.${contract}`,
  };
}
