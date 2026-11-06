#!/usr/bin/env node
// Live NEAR Intents quote, no keys needed (dry run, mainnet prices).
//   node src/quote.js topup  SOL sol 0.1 <your-sol-address> <your.near>
//   node src/quote.js cashout 10 USDT bsc <your-0x-address> <your.near>
import { OneClick, topUpQuote, cashOutQuote, fromUnits } from "./intents.js";

const [mode = "cashout", ...a] = process.argv.slice(2);
const oc = new OneClick({ jwt: process.env.ONECLICK_JWT || "" });

try {
  let r;
  if (mode === "topup") {
    const [sym = "SOL", chain = "sol", amount = "0.1", refundTo = "11111111111111111111111111111111", nearAccount = "duel-demo.near"] = a;
    r = await topUpQuote(oc, { fromSymbol: sym, fromChain: chain, amount, refundTo, nearAccount });
    console.log(`Stake from ${chain.toUpperCase()}: send ${amount} ${sym} -> receive ~${fromUnits(r.q.quote.amountOut, r.to.decimals)} USDC on NEAR in ${nearAccount}`);
  } else {
    const [amount = "10", sym = "USDT", chain = "bsc", recipient = "0x000000000000000000000000000000000000dEaD", nearAccount = "duel-demo.near"] = a;
    r = await cashOutQuote(oc, { amount, toSymbol: sym, toChain: chain, recipient, nearAccount });
    console.log(`Cash out: ${amount} USDC on NEAR -> ~${fromUnits(r.q.quote.amountOut, r.to.decimals)} ${sym} on ${chain.toUpperCase()} to ${recipient}`);
  }
  console.log(`time estimate: ${r.q.quote.timeEstimate ?? "?"}s  |  origin ${r.from.assetId}  ->  ${r.to.assetId}`);
} catch (e) {
  console.error(`quote failed: ${e.message}`);
  process.exitCode = 1;
}
