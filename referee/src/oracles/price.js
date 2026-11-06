// Price bets: "BTC above $120,000 at <resolve time>".
// Source 1: Coinbase 1-minute candles. Source 2: CoinGecko price history.
// Both are free, keyless, and work from US-hosted runners.

const COINGECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", NEAR: "near", BNB: "binancecoin",
  XRP: "ripple", DOGE: "dogecoin", TON: "the-open-network", SUI: "sui", HYPE: "hyperliquid",
  ADA: "cardano", AVAX: "avalanche-2", LINK: "chainlink", TRX: "tron", PEPE: "pepe",
};

export function parsePriceParams(params) {
  const p = typeof params === "string" ? JSON.parse(params || "{}") : params;
  const asset = String(p.asset || "").toUpperCase();
  const target = Number(p.target_usd);
  const dir = p.creator_wins_if;
  if (!asset || !Number.isFinite(target) || target <= 0 || !["above", "below"].includes(dir)) {
    throw new Error("price params need asset, target_usd, creator_wins_if (above|below)");
  }
  return { asset, target, dir };
}

async function coinbase(asset, atMs, fetchFn) {
  const start = Math.floor(atMs / 60_000) * 60;
  const url = `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60&start=${new Date(start * 1000).toISOString()}&end=${new Date((start + 60) * 1000).toISOString()}`;
  const res = await fetchFn(url, { headers: { "user-agent": "duel-referee" } });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows.find((r) => r[0] === start) || rows[0] : null;
  if (!row) return null;
  return { price: Number(row[4]), at: row[0] * 1000, source: `coinbase:${asset}-USD:1m-close`, url };
}

async function coingecko(asset, atMs, fetchFn) {
  const id = COINGECKO_IDS[asset];
  if (!id) throw new Error(`no coingecko id for ${asset}`);
  const from = Math.floor(atMs / 1000) - 600;
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${from}&to=${from + 1200}`;
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const { prices = [] } = await res.json();
  if (!prices.length) return null;
  const best = prices.reduce((a, b) => (Math.abs(b[0] - atMs) < Math.abs(a[0] - atMs) ? b : a));
  if (Math.abs(best[0] - atMs) > 10 * 60_000) return null;
  return { price: Number(best[1]), at: best[0], source: `coingecko:${id}`, url };
}

/**
 * Decide a price duel. Returns { status: "decided", result, reason, data }
 * or { status: "wait", reason }.
 * Rule: "above" = price >= target. "below" = price < target.
 */
export async function decidePrice(duel, { now, fetchFn = fetch }) {
  const { asset, target, dir } = parsePriceParams(duel.params);
  const at = duel.resolve_at_ms;
  if (now < at + 2 * 60_000) return { status: "wait", reason: "waiting for the closing candle" };
  let quote = null;
  const errors = [];
  for (const src of [coinbase, coingecko]) {
    try {
      quote = await src(asset, at, fetchFn);
      if (quote && Number.isFinite(quote.price)) break;
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  if (!quote) return { status: "wait", reason: `no price yet (${errors.join("; ") || "empty"})` };
  const above = quote.price >= target;
  const creatorWins = dir === "above" ? above : !above;
  const fmt = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  return {
    status: "decided",
    method: "price-oracle",
    result: creatorWins ? "creator" : "opponent",
    reason: `${asset} was ${fmt(quote.price)} at ${new Date(quote.at).toISOString()} (target ${fmt(target)}, creator needed ${dir})`,
    data: { source: quote.source, price: quote.price, at: quote.at, target, dir },
  };
}
