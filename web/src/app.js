import { initWallet, accountId, onAccountChange, connect, disconnect, view, call, toYocto, fromYocto, CONTRACT, NETWORK, EXPLORER } from "./near.js";
import { OneClick, topUpQuote, cashOutQuote, fromUnits } from "../../referee/src/intents.js";
import "./styles.css";

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const oc = new OneClick();
let config = null;
let pollTimer = null;

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => {
  if (!a) return "";
  if (/^[0-9a-f]{64}$/.test(a) || a.length > 40) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  const parts = a.replace(/\.(testnet|near)$/, "").split(".");
  return parts[0];
};
const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const isUsdc = (t) => t && /17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|usdc/i.test(t);
function money(units, token) {
  if (!token) return `${fromYocto(units)} NEAR`;
  return `${fromUnits(units, 6)} ${isUsdc(token) ? "USDC" : short(token)}`;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3200);
}
const fee = () => (config?.fee_bps ?? 200) / 10000;
const link = (id) => `${location.origin}${location.pathname}${location.search}#/d/${id}`;

const STATUS_TEXT = {
  Open: "Waiting for an opponent",
  Locked: "Both stakes locked",
  Settled: "Settled, winner paid",
  Draw: "Draw, both refunded",
  Cancelled: "Cancelled, stake refunded",
  Refunded: "Refunded to both players",
};

function ticket(d, { mini = false, href = true } = {}) {
  const pot = BigInt(d.stake) * 2n;
  const won = (acc) => (d.status === "Settled" ? (d.winner === acc ? "won" : "lost") : "");
  const tag = href ? "a" : "div";
  return `<${tag} class="ticket ${mini ? "mini" : ""} ${d.status === "Settled" ? "stamp" : ""}" ${href ? `href="#/d/${d.id}"` : ""}>
    <div class="q">${esc(d.title)}</div>
    <div class="sides"><div class="side a ${won(d.creator)}"><span class="who">${esc(short(d.creator))}</span><span class="claim">${esc(d.creator_side)}</span></div>
    <div class="side b ${d.opponent ? won(d.opponent) : ""}"><span class="who">${d.opponent ? esc(short(d.opponent)) : d.invited ? esc(short(d.invited)) : "Open seat"}</span><span class="claim ${d.opponent ? "" : "empty"}">${esc(d.opponent_side)}</span></div>
    <div class="vs" aria-hidden="true">vs</div></div>
    <div class="pot"><span>${money(d.stake, d.token)} each</span><b>${money(pot.toString(), d.token)}</b></div>
  </${tag}>`;
}

// ------------------------------------------------------------------ views
const ART = {
  pick: `<svg viewBox="0 0 120 120"><rect x="22" y="30" width="60" height="44" rx="8"/><rect x="38" y="46" width="60" height="44" rx="8"/><path d="M50 62h36M50 72h24"/><circle cx="34" cy="42" r="3"/></svg>`,
  lock: `<svg viewBox="0 0 120 120"><path d="M30 52l30-15 30 15-30 15z"/><path d="M30 52v28l30 15 30-15V52"/><path d="M60 67v28"/><ellipse cx="44" cy="32" rx="10" ry="4"/><path d="M34 32v6c0 2 4.5 4 10 4s10-2 10-4v-6"/><ellipse cx="76" cy="30" rx="10" ry="4"/><path d="M66 30v6c0 2 4.5 4 10 4s10-2 10-4v-6"/></svg>`,
  check: `<svg viewBox="0 0 120 120"><rect x="24" y="24" width="56" height="70" rx="6"/><path d="M34 40h36M34 50h28M34 60h32"/><circle cx="78" cy="76" r="16"/><path d="M90 88l12 12"/><path d="M71 76l5 5 9-10"/></svg>`,
  pay: `<svg viewBox="0 0 120 120"><path d="M42 28h36v18a18 18 0 0 1-36 0z"/><path d="M42 34H30a12 12 0 0 0 12 16M78 34h12a12 12 0 0 1-12 16"/><path d="M60 64v14M46 92h28M50 92l4-14h12l4 14"/></svg>`,
};

async function home() {
  document.querySelector("main").classList.add("full");
  $("#foot").classList.add("hide");
  app.innerHTML = `
    <section class="hero">
      <div class="glass" aria-hidden="true">
        <div class="gq">BTC above $120k by Friday?</div>
        <div class="gs"><div class="p a">Tajudeen<b>Yes</b></div><span class="x">🤺</span><div class="p b">Truth<b>No</b></div></div>
        <div class="gp"><span>Both stakes locked</span><b>10 USDC</b></div>
      </div>
      <h1>Bet your friends<br>on anything.</h1>
      <p class="lede">You both lock the same amount. The referee checks the result. The winner gets paid. Nobody can run away with the money.</p>
      <a class="btn light" href="#/new">Start a duel</a>
      <div class="chips"><span class="chip">📈 Prices</span><span class="chip">⚽ Football</span><span class="chip">🎮 Games</span><span class="chip">🏃 Real life</span></div>
    </section>

    <div class="wrap">
      <h2>What people bet on.</h2>
      <div class="rail">
        <div class="use"><div class="pic price">📈</div><div class="body"><div class="tag">Price</div><div class="say">“BTC hits $120k by Friday.”</div><div class="how">Settled from live market prices at the exact minute.</div></div></div>
        <div class="use"><div class="pic football">⚽</div><div class="body"><div class="tag">Football</div><div class="say">“Arsenal beat Chelsea.”</div><div class="how">Settled from the official full-time score.</div></div></div>
        <div class="use"><div class="pic game">🎮</div><div class="body"><div class="tag">Games</div><div class="say">“I'll beat you on EA FC.”</div><div class="how">You both report the score. Disagree? The AI referee checks your screenshots.</div></div></div>
        <div class="use"><div class="pic life">🏃</div><div class="body"><div class="tag">Real life</div><div class="say">“You won't run 10 km this week.”</div><div class="how">Pick a friend as judge, or let the AI referee decide from proof.</div></div></div>
      </div>

      <h2>How a duel works.</h2>
      <div class="cards">
        <div class="card"><div class="n">01</div><h3>Make the bet.</h3><p>Pick what you're betting on and how much.</p><div class="art">${ART.pick}</div></div>
        <div class="card"><div class="n">02</div><h3>Your friend locks the same amount.</h3><p>Send the link. Once they accept, both stakes are locked until the result is in.</p><div class="art">${ART.lock}</div></div>
        <div class="card"><div class="n">03</div><h3>The referee checks the result.</h3><p>Market data, the official score, or a private AI that reads your proof and signs its decision.</p><div class="art">${ART.check}</div></div>
        <div class="card"><div class="n">04</div><h3>The winner is paid in seconds.</h3><p>Automatically, to the coin and chain they want. A draw refunds you both.</p><div class="art">${ART.pay}</div></div>
      </div>

      <h2>Fair by design.</h2>
      <div class="cards">
        <div class="card"><h3>Nobody holds the money.</h3><p>Stakes sit in a smart contract on NEAR, not with a person or with us.</p></div>
        <div class="card"><h3>Admitting you lost settles it.</h3><p>If one of you says the other won, it pays out at once. If you both report the same result, same.</p></div>
        <div class="card"><h3>Lying doesn't pay.</h3><p>If the AI referee isn't sure who won, both of you get refunded. A fake claim can never beat a draw.</p></div>
        <div class="card"><h3>Never stuck.</h3><p>If no one settles within 7 days, anyone can refund both players.</p></div>
      </div>

      <h2>Bet with what you already hold.</h2>
      <p class="lede" style="margin-bottom:18px">Stake from another chain and cash out to the one you want, through NEAR Intents.</p>
      <div class="tiles">
        <div class="tile"><span><b>SOL</b>Solana</span></div><div class="tile"><span><b>USDT</b>BNB Chain</span></div><div class="tile"><span><b>USDC</b>Base</span></div>
        <div class="tile"><span><b>ETH</b>Ethereum</span></div><div class="tile"><span><b>USDT</b>Tron</span></div><div class="tile"><span><b>BTC</b>Bitcoin</span></div>
      </div>

      <section id="mine"></section>
      <section id="latest"></section>
    </div>

    <section class="closing">
      <h2>Your friend owes you a bet.</h2>
      <a class="btn light" href="#/new">Start a duel</a>
      <div class="fine">
        <div>Stakes held by a NEAR smart contract.<br>Settled by the DUEL referee on NEAR AI Cloud.<a href="https://github.com/k58v2hbzkk-del/duel-near">Source code</a><a href="https://x.com/Tajudeen">Built by Tajudeen (@Tajudeen)</a></div>
        <div class="mk">🤺 DUEL</div>
      </div>
    </section>`;
  if (!CONTRACT) return;
  try {
    const latest = await view("get_latest", { limit: 6 });
    $("#latest").innerHTML = latest.length ? `<h2>Live duels.</h2><div class="list">${latest.map((d) => ticket(d, { mini: true })).join("")}</div>` : "";
    const me = accountId();
    if (me) {
      const mine = await view("get_player_duels", { account: me });
      $("#mine").innerHTML = `<h2>Your duels.</h2>${mine.length ? `<div class="list">${mine.map((d) => ticket(d, { mini: true })).join("")}</div>` : `<p class="muted">No duels yet. Start one and send the link to a friend.</p>`}`;
    }
  } catch (e) {
    $("#latest").innerHTML = `<p class="muted small">Couldn't load live duels right now.</p>`;
  }
}

// -------------------------------------------------------------- create flow
const KINDS = [
  { id: "price", e: "📈", name: "Price", hint: "BTC above $120k by Friday?" },
  { id: "football", e: "⚽", name: "Football", hint: "Arsenal beat Chelsea?" },
  { id: "game", e: "🎮", name: "Game", hint: "EA SPORTS FC, COD, PUBG" },
  { id: "custom", e: "🏃", name: "Real life", hint: "He runs 10 km by Sunday" },
];
const ASSETS = ["BTC", "ETH", "SOL", "NEAR", "BNB", "XRP", "DOGE", "TON", "SUI", "HYPE"];
const GAMES = ["EA SPORTS FC 26", "Call of Duty: Mobile", "PUBG Mobile", "eFootball", "Fortnite", "Chess", "Other game"];

function localInput(ms) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function createView() {
  const s = { kind: "price", dir: "above", pick: "home", event: null };
  const tomorrow = Math.ceil((Date.now() + 86_400_000) / 3_600_000) * 3_600_000;
  app.innerHTML = `
    <h1 class="page-title">New duel</h1>
    <p class="lede">What are you betting on?</p>
    <div class="kinds" role="group" aria-label="Bet type">${KINDS.map((k) => `<button class="kind" data-k="${k.id}" aria-pressed="${k.id === s.kind}"><span class="e" aria-hidden="true">${k.e}</span><b>${k.name}</b><span>${k.hint}</span></button>`).join("")}</div>
    <form id="f" novalidate>
      <div id="fields"></div>
      <label for="stake">Your stake <span class="muted">(NEAR)</span></label>
      <input id="stake" inputmode="decimal" value="1" />
      <p class="hint" id="potHint"></p>
      <label for="invite">Friend's NEAR account <span class="muted">(optional, makes it invite-only)</span></label>
      <input id="invite" placeholder="truth.near" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <div id="judgeWrap"></div>
      <div class="dock"><div class="inner"><button class="btn block" type="submit" id="go">Lock my stake</button></div></div>
    </form>`;

  const fields = $("#fields");
  const render = () => {
    document.querySelectorAll(".kind").forEach((b) => b.setAttribute("aria-pressed", b.dataset.k === s.kind));
    if (s.kind === "price") {
      fields.innerHTML = `
        <div class="two"><div><label for="asset">Coin</label><select id="asset">${ASSETS.map((a) => `<option>${a}</option>`).join("")}</select></div>
        <div><label for="target">Price <span class="muted">($)</span></label><input id="target" inputmode="decimal" value="120000" /></div></div>
        <label>I win if the price is</label>
        <div class="seg" role="group"><button type="button" data-dir="above" aria-pressed="${s.dir === "above"}">At or above</button><button type="button" data-dir="below" aria-pressed="${s.dir === "below"}">Below</button></div>
        <label for="at">Checked at</label><input id="at" type="datetime-local" value="${localInput(tomorrow)}" />
        <p class="hint">Settled from the Coinbase price at that minute, with CoinGecko as backup.</p>`;
    } else if (s.kind === "football") {
      fields.innerHTML = `
        <label for="team">Team</label>
        <div class="row"><input id="team" placeholder="Arsenal" style="flex:1 1 180px" /><button type="button" class="btn ghost" id="find" style="flex:0 0 auto">Find matches</button></div>
        <div class="choices" id="matches"></div>
        <label>I win if</label>
        <div class="seg" role="group" id="picks"><button type="button" data-pick="home" aria-pressed="${s.pick === "home"}">Home wins</button><button type="button" data-pick="draw" aria-pressed="${s.pick === "draw"}">Draw</button><button type="button" data-pick="away" aria-pressed="${s.pick === "away"}">Away wins</button></div>
        <p class="hint">Settled from the official full-time score. Postponed match: both refunded.</p>`;
      $("#find").onclick = findMatches;
    } else if (s.kind === "game") {
      fields.innerHTML = `
        <label for="game">Game</label><select id="game">${GAMES.map((g) => `<option>${g}</option>`).join("")}</select>
        <label for="terms">The bet</label><input id="terms" value="First to win one match" maxlength="90" />
        <label for="at">Play by</label><input id="at" type="datetime-local" value="${localInput(tomorrow)}" />
        <p class="hint">After the match you both report the result. If one of you admits the loss, it settles at once. If you disagree, the private AI judge reads your screenshots and decides. Not clear? Both refunded.</p>`;
    } else {
      fields.innerHTML = `
        <label for="terms">The bet</label><input id="terms" placeholder="Truth runs 10 km before Sunday" maxlength="120" />
        <div class="two"><div><label for="mine">My side</label><input id="mine" value="It won't happen" maxlength="90" /></div>
        <div><label for="theirs">Their side</label><input id="theirs" value="It will happen" maxlength="90" /></div></div>
        <label for="at">Decided by</label><input id="at" type="datetime-local" value="${localInput(tomorrow)}" />`;
    }
    $("#judgeWrap").innerHTML = s.kind === "game" || s.kind === "custom"
      ? `<label for="judge">Friend as judge <span class="muted">(optional, otherwise the AI referee)</span></label><input id="judge" placeholder="ref.near" autocapitalize="off" autocomplete="off" spellcheck="false" />`
      : "";
    fields.querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => { s.dir = b.dataset.dir; fields.querySelectorAll("[data-dir]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
    fields.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { s.pick = b.dataset.pick; fields.querySelectorAll("[data-pick]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  };

  async function findMatches() {
    const q = $("#team").value.trim();
    const box = $("#matches");
    if (!q) return toast("Type a team name first");
    box.innerHTML = `<p class="muted"><span class="spinner"></span> Looking up fixtures</p>`;
    try {
      const t = await (await fetch(`https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=${encodeURIComponent(q)}`)).json();
      const team = t.teams?.find((x) => x.strSport === "Soccer") || t.teams?.[0];
      if (!team) throw new Error(`No team called "${q}"`);
      const ev = await (await fetch(`https://www.thesportsdb.com/api/v1/json/123/eventsnext.php?id=${team.idTeam}`)).json();
      const list = (ev.events || []).filter((e) => e.strTimestamp || e.dateEvent);
      if (!list.length) throw new Error(`No upcoming matches for ${team.strTeam}`);
      box.innerHTML = list.slice(0, 6).map((e, i) => {
        const ms = Date.parse(e.strTimestamp ? `${e.strTimestamp.replace(" ", "T")}${/Z|\+/.test(e.strTimestamp) ? "" : "Z"}` : `${e.dateEvent}T${e.strTime || "15:00:00"}Z`);
        e._ms = ms;
        return `<button type="button" class="choice" data-i="${i}" aria-pressed="false"><span><b>${esc(e.strHomeTeam)} vs ${esc(e.strAwayTeam)}</b><br><span class="muted small">${esc(e.strLeague || "")}</span></span><span class="small">${when(ms)}</span></button>`;
      }).join("");
      box.querySelectorAll(".choice").forEach((b) => (b.onclick = () => {
        s.event = list[Number(b.dataset.i)];
        box.querySelectorAll(".choice").forEach((x) => x.setAttribute("aria-pressed", x === b));
      }));
    } catch (e) {
      box.innerHTML = `<p class="bad small">${esc(e.message)}. Check the spelling, or try the club's full name.</p>`;
    }
  }

  const updatePot = () => {
    const v = Number($("#stake").value) || 0;
    $("#potHint").textContent = `Your friend locks the same amount. The winner gets ${(v * 2 * (1 - fee())).toFixed(3)} NEAR (2% fee). Minimum ${config ? fromYocto(config.min_stake_near) : "0.1"} NEAR.`;
  };
  $("#stake").oninput = updatePot;
  updatePot();
  document.querySelectorAll(".kind").forEach((b) => (b.onclick = () => { s.kind = b.dataset.k; render(); }));
  render();

  $("#f").onsubmit = async (ev) => {
    ev.preventDefault();
    let args;
    try {
      args = buildArgs(s);
    } catch (e) {
      return toast(e.message);
    }
    const go = $("#go");
    go.disabled = true;
    go.innerHTML = `<span class="spinner"></span> Waiting for your wallet`;
    try {
      const id = await call("create_duel", { args }, { depositYocto: toYocto($("#stake").value || "0"), callbackHash: "#/created" });
      if (typeof id === "number") return (location.hash = `#/d/${id}?new=1`);
      location.hash = "#/created";
    } catch (e) {
      toast(e.message);
    } finally {
      go.disabled = false;
      go.textContent = "Lock my stake";
    }
  };
}

function buildArgs(s) {
  const at = () => {
    const v = $("#at")?.value;
    const ms = v ? new Date(v).getTime() : NaN;
    if (!Number.isFinite(ms) || ms < Date.now() + 60_000) throw new Error("Pick a time in the future");
    return ms;
  };
  const invited = $("#invite").value.trim().toLowerCase() || null;
  const judge = $("#judge")?.value.trim().toLowerCase() || null;
  const base = { invited, judge, join_window_mins: 24 * 60 };
  if (s.kind === "price") {
    const asset = $("#asset").value, target = Number($("#target").value.replace(/,/g, ""));
    if (!(target > 0)) throw new Error("Enter a target price");
    const t = `$${target.toLocaleString("en-US")}`;
    const ms = at();
    return { ...base, kind: "price", resolve_at_ms: ms,
      title: `${asset} ${s.dir === "above" ? "at or above" : "below"} ${t} on ${when(ms)}?`,
      creator_side: `${asset} ${s.dir === "above" ? "≥" : "<"} ${t}`, opponent_side: `${asset} ${s.dir === "above" ? "<" : "≥"} ${t}`,
      params: JSON.stringify({ asset, target_usd: target, creator_wins_if: s.dir }) };
  }
  if (s.kind === "football") {
    const e = s.event;
    if (!e) throw new Error("Find and pick a match first");
    const name = { home: `${e.strHomeTeam} win`, away: `${e.strAwayTeam} win`, draw: "Draw" };
    const other = { home: `${e.strAwayTeam} win or draw`, away: `${e.strHomeTeam} win or draw`, draw: "Someone wins" };
    return { ...base, kind: "football", resolve_at_ms: Math.max(e._ms + 150 * 60_000, Date.now() + 120_000),
      join_window_mins: Math.max(1, Math.min(24 * 60, Math.floor((e._ms - Date.now()) / 60_000))),
      title: `${e.strHomeTeam} vs ${e.strAwayTeam}`.slice(0, 140), creator_side: name[s.pick], opponent_side: other[s.pick],
      params: JSON.stringify({ event_id: e.idEvent, creator_pick: s.pick, home: e.strHomeTeam, away: e.strAwayTeam, kickoff_ms: e._ms }) };
  }
  if (s.kind === "game") {
    const game = $("#game").value, terms = $("#terms").value.trim() || "Win one match";
    return { ...base, kind: "game", resolve_at_ms: at(), title: `${game}: ${terms}`.slice(0, 140), creator_side: "I win", opponent_side: "I win",
      params: JSON.stringify({ game, terms }) };
  }
  const terms = $("#terms").value.trim();
  if (!terms) throw new Error("Describe the bet");
  return { ...base, kind: "custom", resolve_at_ms: at(), title: terms.slice(0, 140),
    creator_side: $("#mine").value.trim() || "No", opponent_side: $("#theirs").value.trim() || "Yes", params: JSON.stringify({ terms }) };
}

async function createdView() {
  app.innerHTML = `<p class="muted"><span class="spinner"></span> Finding your new duel</p>`;
  const me = accountId();
  for (let i = 0; i < 6 && me; i++) {
    const mine = await view("get_player_duels", { account: me }).catch(() => []);
    if (mine[0] && Date.now() - mine[0].created_at_ms < 10 * 60_000) return (location.hash = `#/d/${mine[0].id}?new=1`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  location.hash = "#/";
}

// ---------------------------------------------------------------- duel page
const METHOD = {
  "price-oracle": "Settled from live market data",
  "football-oracle": "Settled from the official match result",
  "ai-judge": "Settled by the private AI judge on NEAR AI Cloud",
  "no-show": "Nobody reported a result",
  invalid: "The bet terms could not be checked",
  concession: "One player admitted the loss",
  "both players agreed": "Both players reported the same result",
};

async function duelView(id, isNew) {
  let d;
  try {
    d = await view("get_duel", { duel_id: Number(id) });
  } catch (e) {
    app.innerHTML = `<p class="bad">Could not load duel #${esc(id)}: ${esc(e.message)}</p>`;
    return;
  }
  if (!d) {
    app.innerHTML = `<h2>Duel #${esc(id)} doesn't exist</h2><p><a href="#/new">Start a new duel</a></p>`;
    return;
  }
  const me = accountId();
  const now = Date.now();
  const isPlayer = me && (me === d.creator || me === d.opponent);
  const isJudge = me && d.judge === me;
  const grace = config?.grace_ms ?? 7 * 86_400_000;
  const potAfterFee = (BigInt(d.stake) * 2n * BigInt(10000 - (config?.fee_bps ?? 200))) / 10000n;

  let actions = "";
  if (d.status === "Open") {
    if (me === d.creator) {
      actions = `<div class="panel"><h3>Send it to your friend</h3><p>They lock ${money(d.stake, d.token)} and the duel starts.</p>
        <div class="row"><button class="btn a" id="share">Share link</button><button class="btn ghost" id="copy">Copy link</button></div>
        <div class="row" style="margin-top:10px"><a class="btn ghost small" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(`I just challenged you on DUEL: ${d.title}\nLock your stake 👇`)}&url=${encodeURIComponent(link(d.id))}">Post on X</a><a class="btn ghost small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`I just challenged you on DUEL: ${d.title}\n${link(d.id)}`)}">WhatsApp</a></div></div>
        <button class="btn ghost block" style="margin-top:12px" id="cancel">Cancel and get my stake back</button>`;
    } else if (d.invited && me && me !== d.invited) {
      actions = `<p class="panel">This duel is only for ${esc(d.invited)}.</p>`;
    } else if (now > d.join_by_ms) {
      actions = `<p class="panel">Nobody joined in time.</p><button class="btn ghost block" id="cancel">Refund the creator</button>`;
    } else {
      actions = `<div class="dock"><div class="inner"><button class="btn b block" id="join">${me ? `Lock ${money(d.stake, d.token)} and accept` : "Connect wallet to accept"}</button></div></div>
        <p class="hint">Open until ${when(d.join_by_ms)}. You take: ${esc(d.opponent_side)}.</p>
        ${anyChainPanel(d)}`;
    }
  } else if (d.status === "Locked") {
    const parts = [];
    if (isPlayer) {
      const mine = d.claims.find((c) => c.player === me);
      parts.push(`<div class="panel"><h3>Report the result</h3>
        <p class="small muted">Saying the other player won settles it right away. If you both report the same thing, it settles too. If you disagree, ${d.judge ? `${esc(d.judge)} decides` : "the AI referee decides from your evidence"}.</p>
        <div class="seg" role="group" id="claimSeg"><button type="button" data-w="me" aria-pressed="true">I won</button><button type="button" data-w="them" aria-pressed="false">They won</button><button type="button" data-w="draw" aria-pressed="false">Draw</button></div>
        <label for="evidence">Proof <span class="muted">(link to a screenshot or clip)</span></label><input id="evidence" placeholder="https://…" autocapitalize="off" />
        <button class="btn block" style="margin-top:12px" id="claim">Send result</button>
        ${mine ? `<p class="hint">You reported: ${mine.winner ? (mine.winner === me ? "you won" : "they won") : "draw"}.</p>` : ""}</div>`);
    }
    if (isJudge && now >= d.resolve_at_ms) {
      parts.push(`<div class="panel"><h3>You're the judge</h3><p class="small muted">Pick the winner. Your decision is final and pays out at once.</p>
        <div class="row"><button class="btn a" data-r="${esc(d.creator)}">${esc(short(d.creator))} won</button><button class="btn b" data-r="${esc(d.opponent)}">${esc(short(d.opponent))} won</button></div>
        <button class="btn ghost block" style="margin-top:10px" data-r="">Draw, refund both</button></div>`);
    }
    if (now > d.resolve_at_ms + grace) parts.push(`<button class="btn ghost block" id="refund">Refund both players</button>`);
    if (!parts.length) parts.push(`<p class="panel">Settles after ${when(d.resolve_at_ms)}${d.judge ? `, judged by ${esc(d.judge)}` : " by the DUEL referee"}.</p>`);
    actions = parts.join("");
  } else {
    actions = verdictPanel(d) + (d.status === "Settled" && me === d.winner ? cashOutPanel(d, potAfterFee) : "");
  }

  const claims = d.claims.length
    ? `<ul class="facts">${d.claims.map((c) => `<li><span>${esc(short(c.player))} says</span><span>${c.winner ? `${esc(short(c.winner))} won` : "draw"}${c.evidence ? ` <a href="${/^https?:/.test(c.evidence) ? esc(c.evidence) : "#"}" target="_blank" rel="noopener">proof</a>` : ""}</span></li>`).join("")}</ul>`
    : "";

  app.innerHTML = `
    ${isNew ? `<p class="ok">Your stake is locked. Now send the link.</p>` : ""}
    ${ticket(d, { href: false })}
    <span class="status ${d.status}">${STATUS_TEXT[d.status]}</span>
    <ul class="facts">
      <li><span>Settles</span><span>${when(d.resolve_at_ms)}</span></li>
      <li><span>Referee</span><span>${d.judge ? `${esc(d.judge)} (friend)` : "DUEL AI referee"}</span></li>
      <li><span>Winner gets</span><span>${money(potAfterFee.toString(), d.token)}</span></li>
      <li><span>Duel</span><span><a href="${EXPLORER}/address/${esc(CONTRACT)}" target="_blank" rel="noopener">#${d.id} on ${esc(CONTRACT)}</a></span></li>
    </ul>
    ${claims}
    ${actions}`;
  wireDuel(d, me);

  clearInterval(pollTimer);
  if (d.status === "Open" || d.status === "Locked") {
    pollTimer = setInterval(async () => {
      if (!location.hash.startsWith(`#/d/${d.id}`) || document.activeElement?.tagName === "INPUT") return;
      const fresh = await view("get_duel", { duel_id: d.id }).catch(() => null);
      if (fresh && (fresh.status !== d.status || fresh.claims.length !== d.claims.length)) duelView(d.id);
    }, 8000);
  }
}

function verdictPanel(d) {
  let v = null;
  try {
    v = JSON.parse(d.verdict || "null");
  } catch {}
  if (!v) return `<p class="panel">${STATUS_TEXT[d.status]}.</p>`;
  const how = METHOD[v.method] || (v.settled_by === "friend-judge" ? `Judged by ${v.judge}` : v.settled_by === "players" ? "Settled by the players" : "Settled");
  const ai = v.ai;
  return `<div class="panel"><h3>${d.winner ? `${esc(short(d.winner))} won` : "Draw"}</h3>
    <p>${esc(v.reason || "")}</p>
    <p class="small muted">${esc(how)}${v.decided_at ? `, ${when(Date.parse(v.decided_at))}` : ""}.</p>
    ${ai ? `<ul class="facts"><li><span>AI model</span><span>${esc(ai.model)}</span></li>
      <li><span>Ran inside a TEE</span><span class="${ai.signer_in_attestation ? "ok" : "bad"}">${ai.signer_in_attestation ? "Yes, signer matches the attestation" : "Not proven"}</span></li>
      <li><span>Verdict signature</span><span class="${ai.sig_valid && ai.sig_covers_hashes ? "ok" : "bad"}">${ai.sig_valid && ai.sig_covers_hashes ? "Valid" : "Not verified"}</span></li></ul>` : ""}
    <details class="proof" style="margin-top:12px"><summary>Full receipt</summary><pre>${esc(JSON.stringify(v, null, 2))}</pre></details></div>`;
}

const CHAINS = [
  { label: "SOL on Solana", sym: "SOL", chain: "sol", dummy: "1nc1nerator11111111111111111111111111111111" },
  { label: "USDT on BNB Chain", sym: "USDT", chain: "bsc", dummy: "0x000000000000000000000000000000000000dEaD" },
  { label: "USDC on Base", sym: "USDC", chain: "base", dummy: "0x000000000000000000000000000000000000dEaD" },
  { label: "ETH on Ethereum", sym: "ETH", chain: "eth", dummy: "0x000000000000000000000000000000000000dEaD" },
  { label: "USDT on Tron", sym: "USDT", chain: "tron", dummy: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" },
  { label: "BTC on Bitcoin", sym: "BTC", chain: "btc", dummy: "1BitcoinEaterAddressDontSendf59kuE" },
];
const chainSelect = (id) => `<select id="${id}">${CHAINS.map((c, i) => `<option value="${i}">${c.label}</option>`).join("")}</select>`;

function anyChainPanel(d) {
  return `<div class="panel"><h3>No NEAR? Stake from any chain</h3>
    <p class="small muted">NEAR Intents swaps what you hold into the stake and drops it in your NEAR account.${NETWORK === "testnet" ? " This is a live mainnet quote; testnet duels use test NEAR." : ""}</p>
    <div class="two"><div><label for="topChain">I hold</label>${chainSelect("topChain")}</div><div><label for="topAmt">Amount</label><input id="topAmt" inputmode="decimal" value="${d.token ? fromUnits(d.stake, 6) : "0.05"}" /></div></div>
    <button class="btn ghost block" style="margin-top:12px" id="topQuote">Get a live quote</button><p class="hint" id="topOut"></p></div>`;
}

function cashOutPanel(d, amount) {
  const human = d.token ? fromUnits(amount.toString(), 6) : fromYocto(amount.toString());
  return `<div class="panel"><h3>Cash out to any chain</h3>
    <p class="small muted">Turn your ${esc(human)} ${d.token ? "USDC" : "NEAR"} into the coin you want, on the chain you want, through NEAR Intents.</p>
    <label for="outChain">Send me</label>${chainSelect("outChain")}
    <label for="outAddr">My address on that chain</label><input id="outAddr" autocapitalize="off" spellcheck="false" placeholder="Paste your wallet address" />
    <button class="btn gold block" style="margin-top:12px" id="outQuote" data-amt="${esc(human)}">Get a live quote</button><p class="hint" id="outOut"></p><div id="outGo"></div></div>`;
}

function wireDuel(d, me) {
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  const run = async (btn, label, fn) => {
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span> ${label}`;
    try {
      await fn();
      setTimeout(() => duelView(d.id), 1200);
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  };
  on("#copy", async () => { await navigator.clipboard.writeText(link(d.id)); toast("Link copied"); });
  on("#share", async () => {
    if (navigator.share) return navigator.share({ title: "DUEL", text: `I just challenged you on DUEL: ${d.title}`, url: link(d.id) }).catch(() => {});
    await navigator.clipboard.writeText(link(d.id));
    toast("Link copied");
  });
  on("#join", (e) => {
    if (!me) return connect();
    run(e.currentTarget, "Waiting for your wallet", () => call("join_duel", { duel_id: d.id }, { depositYocto: BigInt(d.stake), callbackHash: `#/d/${d.id}` }));
  });
  on("#cancel", (e) => run(e.currentTarget, "Refunding", () => call("cancel_duel", { duel_id: d.id }, { callbackHash: `#/d/${d.id}` })));
  on("#refund", (e) => run(e.currentTarget, "Refunding", () => call("refund_expired", { duel_id: d.id }, { callbackHash: `#/d/${d.id}` })));
  let w = "me";
  document.querySelectorAll("#claimSeg button").forEach((b) => (b.onclick = () => {
    w = b.dataset.w;
    document.querySelectorAll("#claimSeg button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  on("#claim", (e) => {
    const other = me === d.creator ? d.opponent : d.creator;
    const winner = w === "me" ? me : w === "them" ? other : null;
    const evidence = $("#evidence").value.trim() || null;
    run(e.currentTarget, "Sending", () => call("submit_claim", { duel_id: d.id, winner, evidence }, { callbackHash: `#/d/${d.id}` }));
  });
  document.querySelectorAll("[data-r]").forEach((b) => (b.onclick = (e) => {
    const winner = b.dataset.r || null;
    const verdict = JSON.stringify({ settled_by: "friend-judge", judge: me, winner, decided_at: new Date().toISOString(), reason: winner ? `${winner} won, decided by the judge` : "Draw, decided by the judge" });
    run(e.currentTarget, "Settling", () => call("resolve", { duel_id: d.id, winner, verdict }, { callbackHash: `#/d/${d.id}` }));
  }));
  on("#topQuote", async (e) => {
    const c = CHAINS[Number($("#topChain").value)], amt = $("#topAmt").value.trim(), out = $("#topOut");
    out.innerHTML = `<span class="spinner"></span> Asking NEAR Intents solvers`;
    try {
      const { q, to } = await topUpQuote(oc, { fromSymbol: c.sym, fromChain: c.chain, amount: amt, refundTo: c.dummy, nearAccount: me || "duel.near", stakeSymbol: d.token ? "USDC" : "wNEAR" });
      out.innerHTML = `Send ${esc(amt)} ${c.sym} on ${esc(c.label.split(" on ")[1])}, receive about <b>${esc(Number(fromUnits(q.quote.amountOut, to.decimals)).toFixed(4))} ${to.symbol}</b> in your NEAR account in ~${q.quote.timeEstimate ?? 30}s.`;
    } catch (err) {
      out.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
    }
  });
  on("#outQuote", async (e) => {
    const c = CHAINS[Number($("#outChain").value)], addr = $("#outAddr").value.trim(), out = $("#outOut");
    const amt = e.currentTarget.dataset.amt;
    out.innerHTML = `<span class="spinner"></span> Asking NEAR Intents solvers`;
    try {
      const live = NETWORK === "mainnet" && d.token && addr;
      const { q, to, from } = await cashOutQuote(oc, { amount: amt, toSymbol: c.sym, toChain: c.chain, recipient: addr || c.dummy, nearAccount: me, dry: !live, stakeSymbol: d.token ? "USDC" : "wNEAR" });
      out.innerHTML = `${esc(amt)} ${from.symbol} becomes about <b>${esc(Number(fromUnits(q.quote.amountOut, to.decimals)).toFixed(6))} ${to.symbol}</b> on ${esc(c.label.split(" on ")[1])} in ~${q.quote.timeEstimate ?? 30}s.`;
      if (live && q.quote.depositAddress) {
        const tokenContract = from.assetId.replace(/^nep141:/, "");
        $("#outGo").innerHTML = `<button class="btn block" id="outSend">Send ${esc(amt)} USDC to NEAR Intents</button>`;
        on("#outSend", (ev) => run(ev.currentTarget, "Waiting for your wallet", () =>
          call("ft_transfer", { receiver_id: q.quote.depositAddress, amount: q.quote.amountIn, memo: `DUEL cash out #${d.id}` }, { receiverId: tokenContract, depositYocto: 1n, gasTgas: 30n, callbackHash: `#/d/${d.id}` })));
      } else if (!addr) {
        out.innerHTML += ` Paste your address to cash out for real${NETWORK === "testnet" ? " on mainnet" : ""}.`;
      }
    } catch (err) {
      out.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
    }
  });
}

// ---------------------------------------------------------------- routing
function route() {
  clearInterval(pollTimer);
  document.querySelector("main").classList.remove("full");
  $("#foot").classList.remove("hide");
  window.scrollTo(0, 0);
  const h = location.hash || "#/";
  const m = h.match(/^#\/d\/(\d+)(\?new=1)?/);
  if (!CONTRACT && h !== "#/") {
    app.innerHTML = `<p class="bad">No DUEL contract configured. Add ?contract=your-contract.testnet to the URL.</p>`;
    return;
  }
  if (m) return duelView(m[1], !!m[2]);
  if (h.startsWith("#/new")) return createView();
  if (h.startsWith("#/created")) return createdView();
  return home();
}

function paintWallet(acc) {
  const b = $("#wallet");
  b.textContent = acc ? short(acc) : "Connect wallet";
  b.onclick = acc ? async () => { if (confirm(`Disconnect ${acc}?`)) { await disconnect(); route(); } } : connect;
}

(async () => {
  $("#net").textContent = NETWORK === "mainnet" ? "" : "testnet";
  try {
    await initWallet();
  } catch (e) {
    console.error(e);
  }
  paintWallet(accountId());
  let last = accountId();
  onAccountChange((a) => { if (a === last) return; last = a; paintWallet(a); route(); });
  if (CONTRACT) config = await view("get_config").catch(() => null);
  window.addEventListener("hashchange", route);
  route();
})();
