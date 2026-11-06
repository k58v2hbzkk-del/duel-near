// Offline stand-ins for every outside service the referee talks to:
// NEAR RPC, Coinbase, CoinGecko, TheSportsDB, NEAR AI Cloud, 1Click.
// Used by the tests and by `npm run demo` so judges can run the full
// decision flow with no keys and no network.
//
// The fake NEAR AI really signs "request_hash:response_hash" with an
// ECDSA key, so the demo exercises the same signature check as production.
import { Wallet } from "ethers";
import { sha256 } from "./nearai.js";

const TEE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"; // test-only key
export const teeWallet = new Wallet(TEE_KEY);

const json = (obj, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

/**
 * @param {object} o
 *   duels: duels returned by get_ready_for_referee
 *   prices: { "BTC": number } candle close at the resolve time
 *   coinbaseDown: force Coinbase errors (tests the CoinGecko fallback)
 *   events: { [event_id]: TheSportsDB event }
 *   aiAnswer: { winner, confidence, reason } or (messages) => answer
 */
export function mockFetch(o = {}) {
  const calls = [];
  const chats = new Map();
  let n = 0;
  const fn = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    // NEAR RPC view
    if (init.method === "POST" && /rpc\./.test(url)) {
      const body = JSON.parse(init.body);
      const method = body.params.method_name;
      const out = method === "get_ready_for_referee" ? o.duels || [] : null;
      return json({ jsonrpc: "2.0", id: "duel", result: { result: [...Buffer.from(JSON.stringify(out))] } });
    }
    if (url.includes("api.exchange.coinbase.com")) {
      if (o.coinbaseDown) return json({ message: "down" }, 503);
      const asset = url.match(/products\/([A-Z]+)-USD/)[1];
      const start = Number(new Date(decodeURIComponent(url.match(/start=([^&]+)/)[1])).getTime() / 1000);
      const p = o.prices?.[asset];
      return json(p === undefined ? [] : [[start, p - 50, p + 50, p - 10, p, 12.3]]);
    }
    if (url.includes("api.coingecko.com")) {
      const from = Number(url.match(/from=(\d+)/)[1]);
      const p = o.geckoPrice;
      return json({ prices: p === undefined ? [] : [[(from + 600) * 1000, p]] });
    }
    if (url.includes("thesportsdb.com")) {
      const id = decodeURIComponent(url.match(/id=([^&]+)/)[1]);
      const ev = o.events?.[id];
      return json({ events: ev ? [ev] : null });
    }
    if (url.includes("/chat/completions")) {
      const req = JSON.parse(init.body);
      const answer = typeof o.aiAnswer === "function" ? o.aiAnswer(req.messages, req.model) : o.aiAnswer;
      const id = `chatcmpl-demo-${++n}`;
      const resObj = { id, model: req.model, choices: [{ message: { role: "assistant", content: JSON.stringify(answer) } }] };
      const raw = JSON.stringify(resObj);
      chats.set(id, `${sha256(init.body)}:${sha256(raw)}`);
      return { ok: true, status: 200, text: async () => raw, json: async () => resObj };
    }
    if (url.includes("/signature/")) {
      const id = decodeURIComponent(url.match(/signature\/([^?]+)/)[1]);
      const text = chats.get(id);
      const signature = await teeWallet.signMessage(text);
      return json({ text, signature, signing_address: teeWallet.address, signing_algo: "ecdsa", signature_kind: "provider_tee" });
    }
    if (url.includes("/attestation/report")) {
      return json({ signing_address: teeWallet.address, intel_quote: "demo", nvidia_payload: "demo" });
    }
    if (url.includes("1click.chaindefuser.com/v0/tokens")) {
      return json([
        { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, blockchain: "near", symbol: "USDC", price: 1 },
        { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 150 },
        { assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", decimals: 18, blockchain: "bsc", symbol: "USDT", price: 1 },
      ]);
    }
    if (url.includes("1click.chaindefuser.com/v0/quote")) {
      const req = JSON.parse(init.body);
      return json({ quoteRequest: req, quote: { amountIn: req.amount, amountOut: o.quoteOut || "9750000", timeEstimate: 20, ...(req.dry ? {} : { depositAddress: "0xDEPOSIT" }) } });
    }
    return json({ error: `no mock for ${url}` }, 404);
  };
  fn.calls = calls;
  return fn;
}

const NOW = Date.UTC(2026, 10, 13, 20, 0, 0); // Fri 13 Nov 2026 20:00 UTC
export const DEMO_NOW = NOW;

export function demoDuels() {
  const base = { opponent: "truth.testnet", creator: "tajudeen.testnet", status: "Locked", token: null, stake: "1000000000000000000000000", judge: null, claims: [], payout_to: [], verdict: null, winner: null, invited: null, created_at_ms: NOW - 86_400_000, join_by_ms: NOW - 80_000_000 };
  return [
    { ...base, id: 0, kind: "price", title: "BTC above $120k by Friday 6pm?", creator_side: "BTC >= $120,000", opponent_side: "BTC < $120,000", params: JSON.stringify({ asset: "BTC", target_usd: 120000, creator_wins_if: "above" }), resolve_at_ms: NOW - 2 * 3_600_000 },
    { ...base, id: 1, kind: "football", title: "Arsenal vs Chelsea", creator_side: "Arsenal win", opponent_side: "Chelsea win or draw", params: JSON.stringify({ event_id: "2267091", creator_pick: "home", home: "Arsenal", away: "Chelsea" }), resolve_at_ms: NOW - 3 * 3_600_000 },
    { ...base, id: 2, kind: "game", title: "EA SPORTS FC 26 — first to win a match", creator_side: "Tajudeen wins", opponent_side: "Truth wins", params: JSON.stringify({ game: "EA SPORTS FC 26", format: "one match, 6-minute halves" }), resolve_at_ms: NOW - 26 * 3_600_000,
      claims: [
        { player: "tajudeen.testnet", winner: "tajudeen.testnet", evidence: "Final whistle 3-1, Saka scored twice. Screenshot: https://i.imgur.com/fc26-final.png" },
        { player: "truth.testnet", winner: "truth.testnet", evidence: "I won" },
      ] },
    { ...base, id: 3, kind: "custom", title: "Truth runs 10km before Sunday", creator_side: "He won't", opponent_side: "He will", params: JSON.stringify({ proof: "Strava activity link" }), resolve_at_ms: NOW - 25 * 3_600_000,
      claims: [{ player: "truth.testnet", winner: "truth.testnet", evidence: "trust me bro" }] },
  ];
}

export function demoWorld() {
  return mockFetch({
    duels: demoDuels(),
    prices: { BTC: 118_420.55 },
    events: { "2267091": { strHomeTeam: "Arsenal", strAwayTeam: "Chelsea", intHomeScore: "2", intAwayScore: "1", strStatus: "Match Finished" } },
    aiAnswer: (messages) => {
      const text = JSON.stringify(messages);
      if (text.includes("fc26-final")) return { winner: "creator", confidence: 0.86, reason: "Creator gave a specific score with a screenshot; opponent's claim has no evidence." };
      return { winner: "opponent", confidence: 0.35, reason: "Only an unsupported claim; no proof of a 10 km run." };
    },
  });
}
