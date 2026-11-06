import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePrice } from "../src/oracles/price.js";
import { decideFootball } from "../src/oracles/football.js";
import { decideWithAI, buildMessages } from "../src/oracles/ai.js";
import { decide, buildVerdict } from "../src/judge.js";
import { NearAI, verifyChatSignature, sha256 } from "../src/nearai.js";
import { OneClick, toUnits, fromUnits, topUpQuote, cashOutQuote } from "../src/intents.js";
import { runOnce } from "../src/run.js";
import { loadConfig } from "../src/config.js";
import { mockFetch, demoDuels, demoWorld, DEMO_NOW, teeWallet } from "../src/mock.js";

const cfg = { ...loadConfig({ DUEL_CONTRACT: "duel.testnet", NEARAI_API_KEY: "test" }), claimWindowMs: 24 * 3_600_000 };
const [priceDuel, footballDuel, gameDuel, customDuel] = demoDuels();
const now = DEMO_NOW;

// ------------------------------------------------------------------ price
test("price: below target -> opponent wins", async () => {
  const d = await decidePrice(priceDuel, { now, fetchFn: mockFetch({ prices: { BTC: 118000 } }) });
  assert.equal(d.status, "decided");
  assert.equal(d.result, "opponent");
  assert.match(d.reason, /118,000/);
});

test("price: exactly at target counts as above", async () => {
  const d = await decidePrice(priceDuel, { now, fetchFn: mockFetch({ prices: { BTC: 120000 } }) });
  assert.equal(d.result, "creator");
});

test("price: 'below' bets flip the rule", async () => {
  const duel = { ...priceDuel, params: JSON.stringify({ asset: "btc", target_usd: 120000, creator_wins_if: "below" }) };
  const d = await decidePrice(duel, { now, fetchFn: mockFetch({ prices: { BTC: 110000 } }) });
  assert.equal(d.result, "creator");
});

test("price: waits for the closing candle", async () => {
  const d = await decidePrice(priceDuel, { now: priceDuel.resolve_at_ms + 30_000, fetchFn: mockFetch({ prices: { BTC: 1 } }) });
  assert.equal(d.status, "wait");
});

test("price: falls back to CoinGecko when Coinbase is down", async () => {
  const d = await decidePrice(priceDuel, { now, fetchFn: mockFetch({ coinbaseDown: true, geckoPrice: 125000 }) });
  assert.equal(d.result, "creator");
  assert.match(d.data.source, /coingecko/);
});

test("price: no data anywhere -> wait, never guess", async () => {
  const d = await decidePrice(priceDuel, { now, fetchFn: mockFetch({ coinbaseDown: true }) });
  assert.equal(d.status, "wait");
});

// --------------------------------------------------------------- football
const ev = (o) => ({ strHomeTeam: "Arsenal", strAwayTeam: "Chelsea", intHomeScore: "2", intAwayScore: "1", strStatus: "Match Finished", ...o });

test("football: home win and creator picked home", async () => {
  const d = await decideFootball(footballDuel, { now, fetchFn: mockFetch({ events: { "2267091": ev() } }) });
  assert.equal(d.result, "creator");
  assert.match(d.reason, /2-1/);
});

test("football: draw when creator picked home -> opponent", async () => {
  const d = await decideFootball(footballDuel, { now, fetchFn: mockFetch({ events: { "2267091": ev({ intAwayScore: "2" }) } }) });
  assert.equal(d.result, "opponent");
});

test("football: postponed match refunds both", async () => {
  const d = await decideFootball(footballDuel, { now, fetchFn: mockFetch({ events: { "2267091": ev({ strStatus: "Postponed", intHomeScore: null }) } }) });
  assert.equal(d.result, "draw");
});

test("football: match still running -> wait", async () => {
  const d = await decideFootball(footballDuel, { now, fetchFn: mockFetch({ events: { "2267091": ev({ strStatus: "2H" }) } }) });
  assert.equal(d.status, "wait");
});

// --------------------------------------------------------------------- AI
const ai = (answer) => new NearAI({ apiKey: "k", baseUrl: "https://cloud-api.near.ai/v1", fetchFn: mockFetch({ aiAnswer: answer }) });

test("ai: waits for the claim window when only one player reported", async () => {
  const d = await decideWithAI(customDuel, { now: customDuel.resolve_at_ms + 60_000, cfg, ai: ai({}) });
  assert.equal(d.status, "wait");
});

test("ai: nobody reported after the window -> refund", async () => {
  const duel = { ...customDuel, claims: [] };
  const d = await decideWithAI(duel, { now, cfg, ai: ai({}) });
  assert.equal(d.result, "draw");
  assert.equal(d.method, "no-show");
});

test("ai: confident verdict picks a winner, with a verified TEE signature", async () => {
  const d = await decideWithAI(gameDuel, { now, cfg, ai: ai({ winner: "creator", confidence: 0.9, reason: "screenshot shows 3-1" }) });
  assert.equal(d.result, "creator");
  assert.equal(d.ai.sig_valid, true);
  assert.equal(d.ai.sig_covers_hashes, true);
  assert.equal(d.ai.signer_in_attestation, true);
  assert.equal(d.ai.signing_address, teeWallet.address);
});

test("ai: unsure or low confidence -> refund, lying never beats a draw", async () => {
  for (const answer of [{ winner: "unsure", confidence: 0.9 }, { winner: "opponent", confidence: 0.5 }, null]) {
    const d = await decideWithAI(gameDuel, { now, cfg, ai: ai(answer) });
    assert.equal(d.result, "draw");
  }
});

test("ai: screenshot links are sent to the vision model", async () => {
  const { messages, hasImages } = buildMessages(gameDuel);
  assert.equal(hasImages, true);
  assert.ok(messages[1].content.some((p) => p.type === "image_url"));
  const f = mockFetch({ aiAnswer: { winner: "creator", confidence: 0.9, reason: "ok" } });
  const vcfg = { ...cfg, nearai: { ...cfg.nearai, visionModel: "vision-model" } };
  await decideWithAI(gameDuel, { now, cfg: vcfg, ai: new NearAI({ apiKey: "k", baseUrl: "https://x/v1", fetchFn: f }) });
  const call = f.calls.find((c) => c.url.includes("chat/completions"));
  assert.equal(JSON.parse(call.init.body).model, "vision-model");
});

test("signature check rejects a tampered response hash", async () => {
  const text = `${sha256("req")}:${sha256("res")}`;
  const signature = await teeWallet.signMessage(text);
  const good = verifyChatSignature({ text, signature, signing_address: teeWallet.address }, sha256("req"), sha256("res"));
  assert.equal(good.signature_valid && good.text_matches_hashes, true);
  const bad = verifyChatSignature({ text, signature, signing_address: teeWallet.address }, sha256("req"), sha256("other"));
  assert.equal(bad.text_matches_hashes, false);
});

// ------------------------------------------------------------------ judge
test("judge: invalid params refund instead of guessing", async () => {
  const d = await decide({ ...priceDuel, params: "{}" }, { now, cfg, fetchFn: mockFetch() });
  assert.equal(d.result, "draw");
  assert.equal(d.method, "invalid");
});

test("verdict receipt maps result to accounts and fits onchain", () => {
  const v = buildVerdict(gameDuel, { method: "ai-judge", result: "opponent", reason: "x".repeat(5000), data: { big: "y".repeat(5000) } }, now);
  assert.equal(v.winner, "truth.testnet");
  assert.ok(JSON.stringify(v).length <= 4096);
  assert.equal(v.inputs_sha256.length, 64);
});

// ---------------------------------------------------------------- runOnce
test("referee run settles every due duel in the demo world", async () => {
  const sent = [];
  const out = await runOnce(cfg, {
    fetchFn: demoWorld(),
    clock: () => now,
    log: () => {},
    send: async (_c, id, winner, verdict) => (sent.push({ id, winner, verdict }), `tx${id}`),
  });
  assert.equal(out.length, 4);
  const byId = Object.fromEntries(sent.map((s) => [s.id, s]));
  assert.equal(byId[0].winner, "truth.testnet"); // BTC under target
  assert.equal(byId[1].winner, "tajudeen.testnet"); // Arsenal won
  assert.equal(byId[2].winner, "tajudeen.testnet"); // screenshot evidence
  assert.equal(byId[3].winner, null); // "trust me bro" -> refund
  assert.equal(byId[2].verdict.ai.sig_valid, true);
});

// ---------------------------------------------------------------- intents
test("units round-trip", () => {
  assert.equal(toUnits("9.8", 6), "9800000");
  assert.equal(fromUnits("9800000", 6), "9.8");
  assert.equal(toUnits("1", 24), "1" + "0".repeat(24));
  assert.equal(fromUnits("5", 6), "0.000005");
});

test("1Click top-up quote goes from SOL to USDC in the player's NEAR account", async () => {
  const f = mockFetch();
  const r = await topUpQuote(new OneClick({ fetchFn: f }), { fromSymbol: "SOL", fromChain: "sol", amount: "0.1", refundTo: "SoLAddr", nearAccount: "taj.near" });
  const body = JSON.parse(f.calls.find((c) => c.url.endsWith("/v0/quote")).init.body);
  assert.equal(body.dry, true);
  assert.equal(body.amount, "100000000");
  assert.equal(body.recipient, "taj.near");
  assert.equal(body.recipientType, "DESTINATION_CHAIN");
  assert.match(body.destinationAsset, /17208628/);
  assert.ok(r.q.quote.amountOut);
});

test("1Click cash-out quote sends USDC on NEAR to USDT on BNB", async () => {
  const f = mockFetch();
  await cashOutQuote(new OneClick({ fetchFn: f }), { amount: "9.8", toSymbol: "USDT", toChain: "bsc", recipient: "0xabc", nearAccount: "taj.near" });
  const body = JSON.parse(f.calls.find((c) => c.url.endsWith("/v0/quote")).init.body);
  assert.equal(body.amount, "9800000");
  assert.equal(body.refundTo, "taj.near");
  assert.match(body.originAsset, /17208628/);
});

test("1Click rejects unsupported coins clearly", async () => {
  await assert.rejects(() => new OneClick({ fetchFn: mockFetch() }).token("XYZ", "sol"), /does not support/);
});
