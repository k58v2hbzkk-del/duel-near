// Minimal NEAR access: views over plain JSON-RPC, writes via near-api-js.
import { Account } from "near-api-js";

export async function view(rpcUrl, contractId, method, args = {}, fetchFn = fetch) {
  const res = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "duel",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const json = await res.json();
  if (json.error || json.result?.error) {
    throw new Error(`view ${method} failed: ${JSON.stringify(json.error || json.result.error)}`);
  }
  return JSON.parse(Buffer.from(json.result.result).toString());
}

export function refereeAccount(cfg) {
  if (!cfg.refereeId || !cfg.refereeKey) throw new Error("REFEREE_ACCOUNT / REFEREE_PRIVATE_KEY not set");
  return new Account(cfg.refereeId, cfg.rpcUrl, cfg.refereeKey);
}

/** Send `resolve` to the contract. Returns the transaction hash. */
export async function resolveDuel(cfg, duelId, winner, verdict) {
  const account = refereeAccount(cfg);
  const out = await account.callFunctionRaw({
    contractId: cfg.contractId,
    methodName: "resolve",
    args: { duel_id: duelId, winner, verdict: JSON.stringify(verdict) },
    gas: 150_000_000_000_000n,
  });
  const failure = out?.status?.Failure;
  if (failure) throw new Error(`resolve failed: ${JSON.stringify(failure)}`);
  return out?.transaction?.hash || out?.transaction_outcome?.id;
}
