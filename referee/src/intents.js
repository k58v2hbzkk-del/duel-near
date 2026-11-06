// NEAR Intents 1Click client — works in Node and in the browser (fetch only).
//
// DUEL uses it for two moments:
//   * Top up:   "I hold SOL on Solana / USDT on BNB — let me stake in DUEL."
//               1Click gives a deposit address on the player's chain and
//               delivers USDC on NEAR to their NEAR account.
//   * Cash out: "I won 9.8 USDC — send it to my wallet on Base."
//               The winner sends USDC on NEAR to a 1Click deposit address
//               that delivers the coin they want on the chain they want.
// There is no Intents testnet (HACKATHON.md Q-007): quotes are real mainnet
// quotes; `dry: true` previews them without creating a deposit address.

export const ONECLICK = "https://1click.chaindefuser.com";

export class OneClick {
  constructor({ baseUrl = ONECLICK, jwt = "", fetchFn } = {}) {
    this.baseUrl = baseUrl;
    this.jwt = jwt;
    this.fetch = fetchFn || ((...a) => fetch(...a));
    this._tokens = null;
  }

  headers() {
    const h = { "content-type": "application/json", accept: "application/json" };
    if (this.jwt) h.authorization = `Bearer ${this.jwt}`;
    return h;
  }

  async tokens() {
    if (this._tokens) return this._tokens;
    const res = await this.fetch(`${this.baseUrl}/v0/tokens`, { headers: this.headers() });
    if (!res.ok) throw new Error(`1Click tokens ${res.status}`);
    this._tokens = await res.json();
    return this._tokens;
  }

  /** Find a token by symbol + chain, e.g. ("USDC", "near"), ("SOL", "sol"). */
  async token(symbol, blockchain) {
    const list = await this.tokens();
    const s = symbol.toUpperCase(), b = blockchain.toLowerCase();
    const hit = list.find((t) => t.symbol?.toUpperCase() === s && t.blockchain?.toLowerCase() === b);
    if (!hit) throw new Error(`1Click does not support ${symbol} on ${blockchain}`);
    return hit;
  }

  async quote(req) {
    const body = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100, // 1%
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
      ...req,
    };
    const res = await this.fetch(`${this.baseUrl}/v0/quote`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`1Click quote ${res.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
    return json;
  }

  async status(depositAddress) {
    const res = await this.fetch(`${this.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`1Click status ${res.status}`);
    return res.json();
  }
}

export function toUnits(amount, decimals) {
  const [w, f = ""] = String(amount).split(".");
  return (BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

export function fromUnits(units, decimals) {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Quote: any coin on any chain -> USDC in the player's NEAR account. */
export async function topUpQuote(oc, { fromSymbol, fromChain, amount, refundTo, nearAccount, dry = true, stakeSymbol = "USDC" }) {
  const from = await oc.token(fromSymbol, fromChain);
  const to = await oc.token(stakeSymbol, "near");
  const q = await oc.quote({
    dry,
    originAsset: from.assetId,
    destinationAsset: to.assetId,
    amount: toUnits(amount, from.decimals),
    refundTo,
    recipient: nearAccount,
  });
  return { from, to, q };
}

/** Quote: winnings in USDC on NEAR -> any coin on any chain. */
export async function cashOutQuote(oc, { amount, toSymbol, toChain, recipient, nearAccount, dry = true, stakeSymbol = "USDC" }) {
  const from = await oc.token(stakeSymbol, "near");
  const to = await oc.token(toSymbol, toChain);
  const q = await oc.quote({
    dry,
    originAsset: from.assetId,
    destinationAsset: to.assetId,
    amount: toUnits(amount, from.decimals),
    refundTo: nearAccount,
    recipient,
  });
  return { from, to, q };
}
