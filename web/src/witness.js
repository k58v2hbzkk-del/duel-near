// Group-chat witnesses. A witness never needs a wallet, NEAR or gas:
// their browser makes a key, a player adds it to the duel, the OTHER player
// approves it, and the DUEL contract gives that key permission to call one
// method on itself: `witness_vote`. The vote is signed here with that key.
import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { KeyPair, KeyPairEd25519 } from "@near-js/crypto";
import { CONTRACT, RPC } from "./near.js";

const slot = (id) => `duel-witness:${CONTRACT}:${id}`;

export function myWitnessKey(id) {
  try {
    const s = localStorage.getItem(slot(id));
    return s ? KeyPair.fromString(s) : null;
  } catch {
    return null;
  }
}

export function newWitnessKey(id, name) {
  const kp = KeyPairEd25519.fromRandom();
  try {
    localStorage.setItem(slot(id), kp.toString());
    localStorage.setItem(`${slot(id)}:name`, name);
  } catch {}
  return kp;
}

export function myWitnessName(id) {
  try {
    return localStorage.getItem(`${slot(id)}:name`) || "";
  } catch {
    return "";
  }
}

/** Short code friends compare in the group chat, e.g. "HAz8-tUMQ". */
export function witnessCode(pk) {
  const b = String(pk).replace(/^ed25519:/, "");
  return `${b.slice(0, 4)}-${b.slice(4, 8)}`;
}

export async function castVote(id, kp, winner) {
  const account = new Account(CONTRACT, new JsonRpcProvider({ url: RPC }), new KeyPairSigner(kp));
  const out = await account.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "witness_vote",
    args: { duel_id: Number(id), winner },
    gas: 100_000_000_000_000n,
  });
  const failure = out?.status?.Failure;
  if (failure) {
    const m = JSON.stringify(failure).match(/Smart contract panicked: ([^"\\]+)/);
    throw new Error(m ? m[1] : "Vote failed");
  }
  return out;
}
