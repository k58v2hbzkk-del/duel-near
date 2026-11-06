# DUEL — bet your friends on anything

**NEAR HACKATHON 2026 · Tracks: Games With Real Economies (`games`), Social Money (`social`), AI Security & Defense (`security`), Privacy & Private AI (`privacy`)**

Live app: https://k58v2hbzkk-del.github.io/duel-near/ (NEAR testnet) · Contract: `duel-b91d5de8.testnet`

DUEL lets two friends bet on anything: a coin price, a football match, an EA SPORTS FC game, or a real-life challenge. Both stakes are locked in a NEAR smart contract. A referee settles it, and the winner is paid automatically. Nobody holds the money but the contract.

## The problem

Friends bet with each other all the time, over WhatsApp, on X, after a game. Then the loser goes quiet, or the person holding the money "forgets". Betting apps don't help: you bet against the house, not your friend, and they don't cover "I beat you at FC" or "you won't run 10 km by Sunday".

DUEL fixes the three parts that break:

1. **Who holds the money.** The contract does. Both players lock the same stake before the bet starts.
2. **Who decides.** Market data for price bets, the official score for football, your **group chat** for everything else, and a private AI judge on NEAR AI Cloud as the last word.
3. **Who can take part.** Witnesses from the group chat vote from a link with no wallet, no NEAR and no gas.

### Group-chat witnesses (the part only NEAR can do)

Bets between friends already have witnesses: the group chat. DUEL puts them onchain without asking them to install anything.

1. A player taps **Invite a witness** and shares the link in the group chat.
2. The friend opens it, types their name and gets a **witness code** (their browser creates a key). They post the code in the chat.
3. One player adds them. **The other player must approve**, after checking the code matches what the friend posted, so nobody can secretly be their own witness.
4. On approval the contract adds a **function-call access key to its own account** that can call exactly one method, `witness_vote`, with a 0.1 NEAR gas allowance paid by the player who added them.
5. If the players disagree, witnesses vote from the same link. The vote is a real NEAR transaction signed with that key, and **the witness pays nothing**. A majority settles the duel and pays the winner. All witness keys are deleted when the duel ends.

The DUEL referee only steps in if the witnesses haven't reached a majority 24 hours after the resolve time.

### Rivalries

Every pair of friends gets a head-to-head record ("taj 3 – 1 truth") built from their settled duels, shareable to X as an image.

## What NEAR enables here

| NEAR tech | What it does in DUEL | Where |
|---|---|---|
| Smart contract (Rust, near-sdk 5.30) | Escrow: locks both stakes, enforces who can settle and when, pays the winner, refunds draws, safety-valve refunds | [`contract/src/lib.rs`](contract/src/lib.rs) |
| **Function-call access keys** | Witness votes: the contract adds a vote-only key with a gas allowance to itself, so witnesses need no wallet or gas. Keys are scoped to one method and one duel, and deleted afterwards | `add_witness`, `approve_witness`, `witness_vote` in the contract; [`web/src/witness.js`](web/src/witness.js) |
| **NEAR AI Cloud** (private inference in a TEE) | The AI referee for game and real-life bets. Every verdict stores the request/response hashes, the TEE signature and the attested signer address onchain | [`referee/src/nearai.js`](referee/src/nearai.js), [`referee/src/oracles/ai.js`](referee/src/oracles/ai.js) |
| **NEAR Intents** (1Click API) | Stake from any chain (SOL, USDT on BNB, USDC on Base, BTC…) into USDC/wNEAR on NEAR, and cash winnings out to any chain | [`referee/src/intents.js`](referee/src/intents.js), web app |
| NEP-141 `ft_transfer_call` | USDC duels: create or join by sending USDC with a message | `ft_on_transfer` in the contract |
| Named accounts + sub-accounts | `referee.<contract>` is the referee; demo players are sub-accounts created by the deploy script | [`referee/scripts/setup-testnet.js`](referee/scripts/setup-testnet.js) |
| Wallet Selector (MyNearWallet, HOT, Meteor, Intear) | Phone-friendly signing in the web app | [`web/src/near.js`](web/src/near.js) |

## Try it (judges: do X, see Y)

Everything in steps 1 to 3 runs offline with no keys.

**1. Contract tests.** Needs Rust ≥ 1.95.
```bash
cd contract && cargo test
```
See: `test result: ok. 49 passed`. Covers stakes, invite-only duels, friend judges, concessions, matching claims, draws, the 7-day refund valve, failed payouts becoming withdrawable, USDC duels via `ft_transfer_call`, and witnesses: a vote-only key is added on approval, you can't approve your own witness, unknown or unapproved keys can't vote, a majority settles, a split doesn't, the referee waits for witnesses, and keys are deleted at the end.

**2. Referee tests.** Needs Node ≥ 20.
```bash
cd referee && npm ci && npm test
```
See: `# pass 23`. Includes a real ECDSA signature check on AI verdicts, and a tampered hash being rejected.

**3. The whole referee flow, offline.**
```bash
cd referee && npm run demo
```
See: four due duels settled the way they are on testnet:
- `#0` BTC price bet: **truth wins**, because BTC closed at $118,420.55, under the $120k target
- `#1` Arsenal vs Chelsea: **taj wins**, 2-1
- `#2` EA SPORTS FC with a screenshot vs "I won": **taj wins**, AI receipt shows `TEE signature valid: true`
- `#3` "trust me bro" with no proof: **refund**, because the AI wasn't confident enough

Then two NEAR Intents quotes: stake from Solana, and cash out to USDT on BNB.

**4. Live NEAR Intents quote** (mainnet prices, dry run, no keys).
```bash
cd referee && npm run quote -- cashout 10 USDT bsc
```
See: `Cash out: 10 USDC on NEAR -> ~9.9x USDT on BSC …` from real solvers.

**5. Live on testnet.** The contract address is in [`deployments/testnet.json`](deployments/testnet.json). The latest end-to-end run, with every transaction link, is in [`deployments/e2e.json`](deployments/e2e.json):
- A price duel created and joined by two accounts, then settled by the referee from Coinbase data ([payout](https://testnet.nearblocks.io/txns/9hRLw4LmnMegmaypBAm5jdqR9KJAP75d1t38ZKWu2uDj))
- A game duel settled instantly by a concession ([payout](https://testnet.nearblocks.io/txns/BECpDnHcRmKgA7YQF1D4ykdSwodyTXswweX8FpbDCF9L))
- A disputed game duel with three witnesses: added, approved by the other player (vote-only key added: [tx](https://testnet.nearblocks.io/txns/6UPrhjUpPJKJ1cSfXmtNkKE7xCHUsn6eZUeeMqbkDE4r)), then two witnesses vote with no wallet and the majority pays the winner ([vote 1](https://testnet.nearblocks.io/txns/DgZntPDzhbrrCzjbpdT7GCKHvt9mrKYRnc4k6U4zfJxm), [vote 2 + payout](https://testnet.nearblocks.io/txns/gEDi9Q2V1vwLSNJGSZLoE3b53jELYYAHnFNZuhjz3wV)). Open either vote: the signer is the DUEL contract account itself, signed by the witness's function-call key.

**6. The web app.** Hosted at https://k58v2hbzkk-del.github.io/duel-near/, or run it locally:
```bash
cd referee && npm ci && cd ../web && npm ci && DUEL_CONTRACT=<contract from deployments/testnet.json> npm run build && npm run serve
```
Open `http://localhost:8080`, connect a testnet wallet (MyNearWallet works in a phone browser), tap **Start a duel**, pick **Price**, and lock 0.1 NEAR. See: the duel page with a share link. Open the link from a second account and tap **Lock … and accept**. See: status changes to "Both stakes locked".

**7. Be a witness without a wallet.** On a locked duel, tap **Invite a witness** and open that link in a private browser window with no wallet. Type a name and tap **Get my witness code**. See: a code like `HAz8-tUMQ` and a **Send to the group chat** button. Open the link it shares as one player and tap **Add**, then as the other player tap **Code matches, approve**. When the players disagree, the witness link shows **Who won?** and the vote goes through with no wallet.

## How a duel works

```
create_duel (stake locked) ──► join_duel (same stake) ──► Locked
                                                         │
     ┌───────────────────────────────────────────────────┤
     │ submit_claim: "they won"     → settles instantly (concession)
     │ submit_claim ×2, same result → settles instantly (agreement)
     │ resolve (referee or friend judge, after resolve time)
     │ refund_expired (anyone, 7 days after resolve time)
     ▼
  Settled (winner gets pot − 2% fee) · Draw (both refunded) · Refunded
```

**Anti-gaming rules** (enforced in the contract or the referee):
- A concession is final and settles at once.
- The judge can never be a player. An invited duel can only be joined by the invited account.
- Only the referee, or the friend judge both players accepted, can settle a disputed duel, and only after the resolve time.
- If the AI judge is below 80% confidence, the duel is a draw and both are refunded. Lying can never win more than an honest draw.
- If nobody settles within 7 days, anyone can refund both players, so funds are never stuck.
- A payout that fails (for example, an unregistered token account) is kept as an owed balance the owner can withdraw.

## The AI referee's receipt

Every AI verdict written onchain contains:

```json
{ "method": "ai-judge", "result": "creator", "reason": "…",
  "ai": { "model": "zai-org/GLM-5.1-FP8", "chat_id": "…",
          "request_sha256": "…", "response_sha256": "…",
          "signature": "0x…", "signing_address": "0x…",
          "sig_valid": true, "sig_covers_hashes": true,
          "signer_in_attestation": true, "attestation_nonce": "…",
          "attestation_report_sha256": "…" },
  "inputs_sha256": "…" }
```

Anyone can recheck it. The signature covers `request_hash:response_hash`, and the signer must appear in the TEE attestation report fetched with a fresh nonce. The bet terms and evidence go only to the TEE-hosted model.

## Repository map

```
contract/   NEAR smart contract (Rust) + 49 unit tests
referee/    AI referee agent (Node): oracles, NEAR AI client, NEAR Intents client,
            offline demo, testnet setup + end-to-end scripts, 23 tests
web/        Mobile-first web app (create, share, join, report, verdict, cash out)
.github/    CI, testnet deploy + e2e, referee every 10 min, GitHub Pages
deployments/ testnet address + latest e2e transaction links (written by CI)
```

## Running your own referee

```bash
cd referee
export DUEL_CONTRACT=<contract> REFEREE_ACCOUNT=<referee account> REFEREE_PRIVATE_KEY=ed25519:...
export NEARAI_API_KEY=...   # NEAR AI Cloud key (needed for game and real-life bets)
npm run referee:dry         # decide and print, send nothing
npm run referee             # settle due duels
```
Optional settings: `NEARAI_MODEL`, `NEARAI_VISION_MODEL` (used when evidence is an image link), `CLAIM_WINDOW_MINS` (default 1440), `MIN_CONFIDENCE` (default 0.8), `NEAR_NETWORK`.

## Honest limits

- **NEAR Intents is mainnet-only** (HACKATHON.md Q-007). On testnet, the "stake from any chain" and "cash out" panels show live mainnet quotes. Real cross-chain cash-out from the app is enabled for USDC duels on mainnet.
- The referee agent runs in GitHub Actions for this demo. The AI inference runs inside NEAR AI Cloud's TEE and is verifiable; the agent process that calls it is not yet in a TEE. Moving the agent itself into a TEE (Shade Agent-style, with its key never leaving the enclave) is the next step.
- Football results come from TheSportsDB's free tier, so coverage depends on their data.
- Witness keys live in the witness's browser storage. If they clear it, they can't vote; the other witnesses and the referee fallback still settle the duel.
- Full verification of the NVIDIA/Intel attestation quotes is not done in the agent. It checks the signer address against the report and stores the report hash so it can be verified independently.

## Disclosure (HACKATHON.md Q-001 to Q-005)

- **Origin of the idea:** DUEL started as a plugin for the MoonPay PayBox hackathon (Oct 2026, Solana). **None of that code is in this repo.** Everything here (contract, referee, Intents and NEAR AI integration, web app) was written from scratch for NEAR HACKATHON, starting 6 Nov 2026. The first commit, `498ab50`, is an empty baseline. Every file was added after it, during the hackathon window ([full diff](https://github.com/k58v2hbzkk-del/duel-near/compare/498ab50...main)).
- **AI-generated code:** most of the code was written with Claude (Anthropic) under Tajudeen's direction, from a phone.
- **Libraries:** near-sdk (Rust), near-api-js, @near-wallet-selector/*, @near-js/accounts, @near-js/crypto, @near-js/signers, @near-js/providers, @near-js/transactions, ethers (signature recovery and base58 only), esbuild. Data sources: Coinbase Exchange API, CoinGecko, TheSportsDB, NEAR AI Cloud, NEAR Intents 1Click API.

## License

MIT, © 2026 Tajudeen Ramadan ([@Tajudeen](https://x.com/Tajudeen))
