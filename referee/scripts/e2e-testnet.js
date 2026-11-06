#!/usr/bin/env node
// Live end-to-end run on NEAR testnet (run by the deploy workflow):
//   A. price duel: taj bets BTC stays above half its current price, truth
//      takes the other side; after the resolve time the DUEL referee reads
//      Coinbase and pays the winner.
//   B. game duel: truth concedes, the contract settles on its own.
// Prints every transaction link and appends them to deployments/e2e.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Account } from "near-api-js";
import { deriveKey, accountsFor } from "../src/keys.js";
import { loadConfig } from "../src/config.js";
import { view } from "../src/near.js";
import { runOnce } from "../src/run.js";

const seed = process.env.DUEL_SEED;
const names = accountsFor(seed);
const cfg = loadConfig({ ...process.env, DUEL_CONTRACT: names.contract, REFEREE_ACCOUNT: names.referee, REFEREE_PRIVATE_KEY: deriveKey(seed, "referee").secretKey, CLAIM_WINDOW_MINS: "1" });
const taj = new Account(names.alice, cfg.rpcUrl, deriveKey(seed, "alice").secretKey);
const truth = new Account(names.bob, cfg.rpcUrl, deriveKey(seed, "bob").secretKey);
const STAKE = (10n ** 24n) / 5n; // 0.2 NEAR
const tx = (r) => `${cfg.explorer}/txns/${r.transaction?.hash || r.transaction_outcome?.id}`;
const ret = (r) => JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
const log = [];
const step = (label, r) => {
  const l = { step: label, tx: tx(r) };
  log.push(l);
  console.log(`${label}: ${l.tx}`);
  if (r.status?.Failure) throw new Error(`${label} failed: ${JSON.stringify(r.status.Failure)}`);
};

const cb = await (await fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker")).json();
const target = Math.round(Number(cb.price) / 2);
const resolveAt = Date.now() + 3 * 60_000;

// A. price duel
let r = await taj.callFunctionRaw({
  contractId: names.contract, methodName: "create_duel", deposit: STAKE, gas: 100_000_000_000_000n,
  args: { args: { title: `BTC at or above $${target.toLocaleString("en-US")} in 3 minutes?`, creator_side: `BTC ≥ $${target}`, opponent_side: `BTC < $${target}`, kind: "price", params: JSON.stringify({ asset: "BTC", target_usd: target, creator_wins_if: "above" }), resolve_at_ms: resolveAt, join_window_mins: 2 } },
});
step("A1 taj creates a BTC price duel (0.2 NEAR)", r);
const priceId = ret(r);
r = await truth.callFunctionRaw({ contractId: names.contract, methodName: "join_duel", args: { duel_id: priceId }, deposit: STAKE, gas: 50_000_000_000_000n });
step("A2 truth locks the same stake", r);

// B. game duel settled by concession
r = await taj.callFunctionRaw({
  contractId: names.contract, methodName: "create_duel", deposit: STAKE, gas: 100_000_000_000_000n,
  args: { args: { title: "EA SPORTS FC 26: First to win one match", creator_side: "I win", opponent_side: "I win", kind: "game", params: JSON.stringify({ game: "EA SPORTS FC 26" }), resolve_at_ms: Date.now() + 3_600_000, invited: names.bob } },
});
step("B1 taj challenges truth to EA SPORTS FC (invite-only)", r);
const gameId = ret(r);
r = await truth.callFunctionRaw({ contractId: names.contract, methodName: "join_duel", args: { duel_id: gameId }, deposit: STAKE, gas: 50_000_000_000_000n });
step("B2 truth accepts", r);
r = await truth.callFunctionRaw({ contractId: names.contract, methodName: "submit_claim", args: { duel_id: gameId, winner: names.alice, evidence: "GG, 3-1" }, gas: 100_000_000_000_000n });
step("B3 truth concedes, contract pays taj instantly", r);
const g = await view(cfg.rpcUrl, names.contract, "get_duel", { duel_id: gameId });
if (g.status !== "Settled" || g.winner !== names.alice) throw new Error(`game duel not settled: ${g.status}`);

// A3: wait for the resolve time, then the referee settles
const wait = resolveAt + 2.5 * 60_000 - Date.now();
console.log(`waiting ${Math.ceil(wait / 1000)}s for the BTC candle…`);
await new Promise((s) => setTimeout(s, Math.max(0, wait)));
const results = await runOnce(cfg);
const mine = results.find((x) => x.id === priceId);
if (!mine || mine.status !== "settled") throw new Error(`referee did not settle duel ${priceId}: ${JSON.stringify(mine)}`);
log.push({ step: "A3 DUEL referee reads Coinbase and pays the winner", tx: `${cfg.explorer}/txns/${mine.tx}`, verdict: mine.verdict });
console.log(`A3 referee: ${mine.verdict.reason}`);
const p = await view(cfg.rpcUrl, names.contract, "get_duel", { duel_id: priceId });
if (p.winner !== names.alice) throw new Error("expected taj to win the price duel");

const file = "../deployments/e2e.json";
const prev = existsSync(file) ? JSON.parse(readFileSync(file)) : [];
prev.unshift({ ran_at: new Date().toISOString(), contract: names.contract, steps: log });
writeFileSync(file, JSON.stringify(prev.slice(0, 5), null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## DUEL testnet end-to-end\n\n${log.map((l) => `- ${l.step}: [tx](${l.tx})`).join("\n")}\n`);
}
console.log("end-to-end OK");
