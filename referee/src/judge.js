// Routes a duel to the right oracle and turns the decision into an onchain
// verdict receipt.
import { decidePrice } from "./oracles/price.js";
import { decideFootball } from "./oracles/football.js";
import { decideWithAI } from "./oracles/ai.js";
import { sha256 } from "./nearai.js";

export async function decide(duel, ctx) {
  try {
    switch (duel.kind) {
      case "price":
        return await decidePrice(duel, ctx);
      case "football":
        return await decideFootball(duel, { ...ctx, sportsDbKey: ctx.cfg.sportsDbKey });
      case "game":
      case "custom":
        return await decideWithAI(duel, ctx);
      default:
        return { status: "decided", method: "invalid", result: "draw", reason: `unknown kind ${duel.kind} — refunded`, data: {} };
    }
  } catch (e) {
    // Bad params can never be settled fairly: refund. Network errors: retry later.
    const msg = String(e.message || e);
    if (/params need/.test(msg)) {
      return { status: "decided", method: "invalid", result: "draw", reason: `invalid bet terms (${msg}) — refunded`, data: {} };
    }
    return { status: "wait", reason: `error: ${msg}` };
  }
}

export function winnerAccount(duel, result) {
  if (result === "creator") return duel.creator;
  if (result === "opponent") return duel.opponent;
  return null;
}

/** Compact JSON receipt stored onchain with the settlement (<= 4 KB). */
export function buildVerdict(duel, decision, now) {
  const inputs = {
    id: duel.id, kind: duel.kind, title: duel.title, params: duel.params,
    creator_side: duel.creator_side, opponent_side: duel.opponent_side,
    resolve_at_ms: duel.resolve_at_ms, claims: duel.claims,
  };
  const v = {
    v: 1,
    duel: duel.id,
    referee: "duel-ai-referee",
    method: decision.method,
    result: decision.result,
    winner: winnerAccount(duel, decision.result),
    reason: decision.reason,
    data: decision.data,
    inputs_sha256: sha256(JSON.stringify(inputs)),
    decided_at: new Date(now).toISOString(),
  };
  if (decision.ai) v.ai = decision.ai;
  let s = JSON.stringify(v);
  if (s.length > 4000) {
    v.data = { truncated: true };
    v.reason = v.reason.slice(0, 200);
    s = JSON.stringify(v);
  }
  return v;
}
