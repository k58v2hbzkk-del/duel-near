// Game and real-life bets ("I beat you 3-1 on EA SPORTS FC", "I'll finish a
// 10k run before Sunday"). Settled by a private AI judge on NEAR AI Cloud
// that reads the bet terms and both players' claims and evidence.
//
// Anti-gaming rules:
//  * If both players agree or one concedes, the contract settles on its own
//    (the AI is never asked).
//  * Players get a claim window after the resolve time to report.
//  * If the AI is not confident enough, the duel is a draw: both refunded.
//    Lying can therefore never win you more than an honest draw.
//  * No claims at all after the window = draw (refund).

const IMAGE = /\.(png|jpe?g|webp|gif)(\?|$)/i;

export function buildMessages(duel) {
  const role = (acc) => (acc === duel.creator ? "creator" : acc === duel.opponent ? "opponent" : "unknown");
  const claims = (duel.claims || []).map((c) => ({
    by: role(c.player),
    says_winner: c.winner ? role(c.winner) : "draw",
    evidence: c.evidence || null,
  }));
  const system =
    "You are the referee for DUEL, a peer-to-peer bet between two friends. " +
    "Decide who won using ONLY the bet terms, the players' claims and the evidence. " +
    "Players may lie. A claim without evidence is weak. If the evidence does not clearly " +
    "show a winner, answer \"unsure\". Never invent facts. Reply with JSON only: " +
    '{"winner":"creator"|"opponent"|"draw"|"unsure","confidence":0..1,"reason":"one short sentence"}';
  const terms = {
    bet: duel.title,
    kind: duel.kind,
    creator_wins_if: duel.creator_side,
    opponent_wins_if: duel.opponent_side,
    extra_terms: safeParse(duel.params),
    resolve_time: new Date(duel.resolve_at_ms).toISOString(),
    claims,
  };
  const text = JSON.stringify(terms, null, 1);
  const images = claims.map((c) => c.evidence).filter((e) => e && IMAGE.test(e));
  const user = images.length
    ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
    : text;
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], hasImages: images.length > 0 };
}

function safeParse(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return { note: String(s).slice(0, 300) };
  }
}

export async function decideWithAI(duel, { now, cfg, ai }) {
  const claims = duel.claims || [];
  const windowEnds = duel.resolve_at_ms + cfg.claimWindowMs;
  const bothClaimed = claims.length >= 2;
  if (!bothClaimed && now < windowEnds) {
    return { status: "wait", reason: `waiting for players to report (window ends ${new Date(windowEnds).toISOString()})` };
  }
  if (claims.length === 0) {
    return { status: "decided", method: "no-show", result: "draw", reason: "Nobody reported a result — stakes refunded", data: {} };
  }
  if (!ai) return { status: "wait", reason: "NEARAI_API_KEY not set — AI judge unavailable" };

  const { messages, hasImages } = buildMessages(duel);
  const model = hasImages && cfg.nearai.visionModel ? cfg.nearai.visionModel : cfg.nearai.model;
  const { answer, receipt } = await ai.judge(model, messages);
  const winner = answer?.winner;
  const confidence = Number(answer?.confidence ?? 0);
  let result = "draw";
  let reason = String(answer?.reason || "no reason given").slice(0, 280);
  if ((winner === "creator" || winner === "opponent") && confidence >= cfg.minConfidence) {
    result = winner;
  } else if (winner === "draw" && confidence >= cfg.minConfidence) {
    result = "draw";
  } else {
    reason = `Not clear enough to pick a winner (AI said ${winner || "nothing"} at ${confidence}) — refunded. ${reason}`.slice(0, 280);
  }
  return { status: "decided", method: "ai-judge", result, reason, data: { confidence, ai_said: winner }, ai: receipt };
}
