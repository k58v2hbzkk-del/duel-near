#!/usr/bin/env node
// `npm run demo` — the whole DUEL referee flow offline, no keys, no network.
// Four real-looking duels are due. The referee settles each one the way it
// does on testnet, then shows the receipt that would be written onchain.
import { runOnce } from "./run.js";
import { loadConfig } from "./config.js";
import { demoWorld, DEMO_NOW, demoDuels } from "./mock.js";
import { OneClick, cashOutQuote, topUpQuote, fromUnits } from "./intents.js";

const cfg = { ...loadConfig({ DUEL_CONTRACT: "duel-demo.testnet", NEARAI_API_KEY: "demo" }) };
const world = demoWorld();
const line = () => console.log("─".repeat(64));

console.log("\nDUEL — bet your friends on anything. Referee demo (offline).\n");
for (const d of demoDuels()) {
  console.log(`#${d.id} [${d.kind}] ${d.title}`);
  console.log(`    ${d.creator} → "${d.creator_side}"   vs   ${d.opponent} → "${d.opponent_side}"   (1 NEAR each)`);
}
line();

const settled = await runOnce(cfg, {
  fetchFn: world,
  clock: () => DEMO_NOW,
  log: () => {},
  send: async (_cfg, id) => `demo-tx-${id}`,
});

for (const r of settled) {
  const v = r.verdict;
  const pot = v.winner ? "1.96 NEAR (2 NEAR pot − 2% fee)" : "1 NEAR back to each player";
  console.log(`#${r.id} → ${v.winner ? `WINNER ${v.winner}` : "DRAW / REFUND"}  ·  paid: ${pot}`);
  console.log(`    how: ${v.method}  ·  ${v.reason}`);
  if (v.ai) {
    console.log(`    AI receipt: model ${v.ai.model}, chat ${v.ai.chat_id}`);
    console.log(`      TEE signature valid: ${v.ai.sig_valid}  ·  covers request+response hashes: ${v.ai.sig_covers_hashes}  ·  signer in attestation: ${v.ai.signer_in_attestation}`);
  }
  console.log(`    onchain receipt: ${JSON.stringify(v).length} bytes, inputs_sha256 ${v.inputs_sha256.slice(0, 16)}…`);
}
line();

// NEAR Intents: stake from any chain, cash out to any chain.
const oc = new OneClick({ fetchFn: world });
const up = await topUpQuote(oc, { fromSymbol: "SOL", fromChain: "sol", amount: "0.07", refundTo: "SoLanaWalletAddr", nearAccount: "truth.near" });
console.log(`Stake from Solana: send 0.07 SOL → ~${fromUnits(up.q.quote.amountOut, 6)} USDC lands in truth.near, ready to join a duel`);
const out = await cashOutQuote(oc, { amount: "9.8", toSymbol: "USDT", toChain: "bsc", recipient: "0xYourBnbWallet", nearAccount: "tajudeen.near" });
console.log(`Cash out winnings: 9.8 USDC on NEAR → ~${fromUnits(out.q.quote.amountOut, 6)} USDT on BNB Chain`);
line();
console.log("Live versions: `npm run quote` (real NEAR Intents prices), `npm run referee` (testnet).\n");
