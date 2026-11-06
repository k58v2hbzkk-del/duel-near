// NEAR AI Cloud client with verifiable receipts.
//
// Inference runs inside a TEE (GPU + CPU confidential computing). For every
// verdict we keep:
//   - sha256 of the exact request body and the exact response body
//   - the TEE's signature over "request_hash:response_hash"
//   - the signer address, checked against the attestation report
// Anyone can re-check the signature from the onchain verdict.
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function collectSigningAddresses(obj, out = new Set()) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "signing_address" && typeof v === "string") out.add(v.toLowerCase());
    else if (typeof v === "object") collectSigningAddresses(v, out);
  }
  return out;
}

export function verifyChatSignature({ text, signature, signing_address }, requestHash, responseHash) {
  const expected = `${requestHash}:${responseHash}`;
  const textMatches = text === expected;
  let recovered = null;
  try {
    recovered = verifyMessage(text, signature).toLowerCase();
  } catch {
    recovered = null;
  }
  return {
    text_matches_hashes: textMatches,
    recovered_signer: recovered,
    signature_valid: !!recovered && recovered === String(signing_address).toLowerCase(),
  };
}

export class NearAI {
  constructor({ apiKey, baseUrl, fetchFn = fetch }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchFn;
  }

  headers() {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  /** Chat completion that returns the parsed JSON answer plus a receipt. */
  async judge(model, messages) {
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${raw.slice(0, 200)}`);
    const json = JSON.parse(raw);
    const content = json.choices?.[0]?.message?.content || "";
    const receipt = {
      provider: "near-ai-cloud",
      model,
      chat_id: json.id,
      request_sha256: sha256(body),
      response_sha256: sha256(raw),
    };
    try {
      Object.assign(receipt, await this.proof(model, json.id, receipt));
    } catch (e) {
      receipt.proof_error = String(e.message || e).slice(0, 120);
    }
    return { answer: parseJsonLoose(content), receipt };
  }

  async proof(model, chatId, receipt) {
    const q = `model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    const sigRes = await this.fetch(`${this.baseUrl}/signature/${encodeURIComponent(chatId)}?${q}`, {
      headers: this.headers(),
    });
    if (!sigRes.ok) throw new Error(`signature ${sigRes.status}`);
    const sig = await sigRes.json();
    const check = verifyChatSignature(sig, receipt.request_sha256, receipt.response_sha256);

    const nonce = randomBytes(32).toString("hex");
    const attRes = await this.fetch(`${this.baseUrl}/attestation/report?${q}&nonce=${nonce}`, {
      headers: this.headers(),
    });
    let attested = null, reportHash = null;
    if (attRes.ok) {
      const rawReport = await attRes.text();
      reportHash = sha256(rawReport);
      const addrs = collectSigningAddresses(JSON.parse(rawReport));
      attested = addrs.has(String(sig.signing_address).toLowerCase());
    }
    return {
      signature: sig.signature,
      signing_address: sig.signing_address,
      signing_algo: sig.signing_algo || "ecdsa",
      signature_kind: sig.signature_kind,
      sig_valid: check.signature_valid,
      sig_covers_hashes: check.text_matches_hashes,
      signer_in_attestation: attested,
      attestation_nonce: nonce,
      attestation_report_sha256: reportHash,
    };
  }
}

export function parseJsonLoose(s) {
  try {
    return JSON.parse(s);
  } catch {
    const m = String(s).match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}
