//! DUEL — bet your friends on anything.
//!
//! Two players lock equal stakes in this contract. A referee settles the bet:
//! either the DUEL AI referee agent (default) or a friend both players chose
//! as judge. The winner is paid automatically. Nobody holds the money but
//! the contract.
//!
//! Safety rules (anti-gaming):
//! * A concession is final: if a player claims the *other* player won, the
//!   duel settles immediately for the other player.
//! * If both players claim the same result, it settles without the referee.
//! * Only the referee / chosen judge can settle a disputed duel, and only
//!   after `resolve_at_ms`.
//! * The judge can never be one of the players.
//! * If nobody settles within the grace period, anyone can trigger a full
//!   refund to both players. Funds can never be stuck.
//! * Payouts that fail (e.g. unregistered token account) are kept as
//!   "owed" balances that the owner can withdraw later.
//!
//! Group-chat witnesses (v2):
//! * Either player can add a witness (a friend from the group chat) by their
//!   witness key. The OTHER player must approve it, so nobody can secretly
//!   be their own witness.
//! * On approval the contract adds a function-call access key to ITSELF that
//!   can only call `witness_vote`, with a small gas allowance. The witness
//!   votes from a link: no wallet, no NEAR, no gas.
//! * A majority of approved witnesses settles the duel. Keys are deleted
//!   when the duel ends.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, serde_json, AccountId, Allowance, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

pub const MAX_TITLE: usize = 140;
pub const MAX_SIDE: usize = 100;
pub const MAX_PARAMS: usize = 1024;
pub const MAX_VERDICT: usize = 4096;
pub const MAX_EVIDENCE: usize = 500;
pub const MAX_WITNESSES: usize = 5;
pub const MAX_NAME: usize = 32;
/// Paid by whoever adds a witness; funds the witness key's gas allowance.
pub const WITNESS_FEE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
pub const VERSION: u32 = 2;
pub const MAX_FEE_BPS: u16 = 1000; // 10%
pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_HORIZON_MS: u64 = 120 * DAY_MS;
pub const KINDS: [&str; 4] = ["price", "football", "game", "custom"];

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Duels,
    Locked,
    Owed,
    Tokens,
    Players,
    DuelsV2,
    LockedV2,
    PlayersV2,
    WitnessKeys,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Created, waiting for an opponent.
    Open,
    /// Both stakes locked, waiting for the result.
    Locked,
    /// Winner paid.
    Settled,
    /// Draw: both stakes returned.
    Draw,
    /// Nobody joined: creator refunded.
    Cancelled,
    /// Nobody settled in time: both refunded.
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub player: AccountId,
    /// Who the player says won. `None` = draw.
    pub winner: Option<AccountId>,
    /// Optional proof: a link to a screenshot / clip, or a short note.
    pub evidence: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Witness {
    pub name: String,
    pub key: PublicKey,
    pub added_by: AccountId,
    pub approved: bool,
    pub voted: bool,
    /// Who the witness says won. `None` = draw (only meaningful if `voted`).
    pub vote: Option<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Duel {
    pub id: u64,
    pub creator: AccountId,
    pub opponent: Option<AccountId>,
    /// If set, only this account may join (invite-only duel).
    pub invited: Option<AccountId>,
    pub title: String,
    pub creator_side: String,
    pub opponent_side: String,
    /// "price" | "football" | "game" | "custom"
    pub kind: String,
    /// JSON parameters the referee uses to settle (asset, target, event id…).
    pub params: String,
    /// `None` = native NEAR, otherwise a NEP-141 token contract.
    pub token: Option<AccountId>,
    /// Stake per player.
    pub stake: U128,
    /// Friend-as-judge. `None` = the DUEL AI referee.
    pub judge: Option<AccountId>,
    pub created_at_ms: u64,
    pub join_by_ms: u64,
    pub resolve_at_ms: u64,
    pub status: Status,
    pub claims: Vec<Claim>,
    pub winner: Option<AccountId>,
    /// Verdict receipt (JSON) written by whoever settled the duel.
    pub verdict: Option<String>,
    /// Where each player wants winnings sent (e.g. a NEAR Intents deposit
    /// address that forwards to another chain). Defaults to the player.
    pub payout_to: Vec<(AccountId, AccountId)>,
    /// Friends from the group chat who can settle a dispute by majority.
    pub witnesses: Vec<Witness>,
}

impl Duel {
    pub fn is_player(&self, a: &AccountId) -> bool {
        &self.creator == a || self.opponent.as_ref() == Some(a)
    }
    pub fn approved_witnesses(&self) -> usize {
        self.witnesses.iter().filter(|w| w.approved).count()
    }
    fn claims_conflict(&self) -> bool {
        self.claims.len() == 2 && self.claims[0].winner != self.claims[1].winner
    }
    fn payout_account(&self, player: &AccountId) -> AccountId {
        self.payout_to
            .iter()
            .find(|(p, _)| p == player)
            .map(|(_, r)| r.clone())
            .unwrap_or_else(|| player.clone())
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CreateArgs {
    pub title: String,
    pub creator_side: String,
    pub opponent_side: String,
    pub kind: String,
    #[serde(default)]
    pub params: String,
    #[serde(default)]
    pub invited: Option<AccountId>,
    #[serde(default)]
    pub judge: Option<AccountId>,
    /// How long the duel stays open for joining. Default 24h.
    #[serde(default)]
    pub join_window_mins: Option<u32>,
    /// When the result can be settled (unix ms).
    pub resolve_at_ms: u64,
}

/// `msg` for `ft_transfer_call` into this contract.
#[near(serializers = [json])]
pub enum FtMsg {
    #[serde(rename = "create")]
    Create(CreateArgs),
    #[serde(rename = "join")]
    Join { duel_id: u64 },
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub referee: AccountId,
    pub treasury: AccountId,
    pub fee_bps: u16,
    pub min_stake_near: U128,
    pub grace_ms: u64,
    pub witness_window_ms: u64,
    pub duel_count: u64,
    pub version: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    referee: AccountId,
    treasury: AccountId,
    fee_bps: u16,
    min_stake_near: u128,
    grace_ms: u64,
    witness_window_ms: u64,
    next_id: u64,
    duels: LookupMap<u64, Duel>,
    locked: IterableSet<u64>,
    /// "account|token" -> amount owed after a failed payout (or fees).
    owed: LookupMap<String, u128>,
    /// Allowed NEP-141 tokens -> minimum stake.
    tokens: LookupMap<AccountId, u128>,
    players: LookupMap<AccountId, Vec<u64>>,
    /// witness public key -> duel id (a key belongs to exactly one duel)
    witness_keys: LookupMap<PublicKey, u64>,
}

fn owed_key(account: &AccountId, token: &Option<AccountId>) -> String {
    format!(
        "{}|{}",
        account,
        token.as_ref().map(|t| t.as_str()).unwrap_or("near")
    )
}

fn event(name: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({"standard":"duel","version":"1.0.0","event":name,"data":data})
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        referee: AccountId,
        treasury: AccountId,
        fee_bps: u16,
        min_stake_near: U128,
        grace_ms: Option<u64>,
    ) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee too high");
        Self {
            owner,
            referee,
            treasury,
            fee_bps,
            min_stake_near: min_stake_near.0,
            grace_ms: grace_ms.unwrap_or(7 * DAY_MS),
            witness_window_ms: DAY_MS,
            next_id: 0,
            duels: LookupMap::new(StorageKey::DuelsV2),
            locked: IterableSet::new(StorageKey::LockedV2),
            owed: LookupMap::new(StorageKey::Owed),
            tokens: LookupMap::new(StorageKey::Tokens),
            players: LookupMap::new(StorageKey::PlayersV2),
            witness_keys: LookupMap::new(StorageKey::WitnessKeys),
        }
    }

    /// v1 -> v2 upgrade on testnet: start a fresh duel book (v1 test duels
    /// were all settled). Only the contract account itself can call this.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v2(
        owner: AccountId,
        referee: AccountId,
        treasury: AccountId,
        fee_bps: u16,
        min_stake_near: U128,
        grace_ms: Option<u64>,
    ) -> Self {
        Self::new(owner, referee, treasury, fee_bps, min_stake_near, grace_ms)
    }

    // ---------------------------------------------------------------- create

    /// Create a duel staking native NEAR. Attach exactly the stake.
    #[payable]
    pub fn create_duel(&mut self, args: CreateArgs) -> u64 {
        let stake = env::attached_deposit().as_yoctonear();
        require!(stake >= self.min_stake_near, "stake below minimum");
        self.internal_create(env::predecessor_account_id(), None, stake, args)
    }

    /// Join an open duel staking native NEAR. Attach exactly the stake.
    #[payable]
    pub fn join_duel(&mut self, duel_id: u64) {
        let amount = env::attached_deposit().as_yoctonear();
        self.internal_join(env::predecessor_account_id(), None, amount, duel_id);
    }

    /// NEP-141 entry point: create or join a duel with a token stake
    /// (e.g. USDC on NEAR, which is what NEAR Intents delivers).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let min = self.tokens.get(&token).copied();
        require!(min.is_some(), "token not accepted");
        let parsed: FtMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad msg"));
        match parsed {
            FtMsg::Create(args) => {
                require!(amount.0 >= min.unwrap(), "stake below minimum");
                self.internal_create(sender_id, Some(token), amount.0, args);
            }
            FtMsg::Join { duel_id } => {
                self.internal_join(sender_id, Some(token), amount.0, duel_id);
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    fn internal_create(
        &mut self,
        creator: AccountId,
        token: Option<AccountId>,
        stake: u128,
        a: CreateArgs,
    ) -> u64 {
        let now = env::block_timestamp_ms();
        require!(stake > 0, "stake required");
        require!(!a.title.trim().is_empty() && a.title.len() <= MAX_TITLE, "bad title");
        require!(
            !a.creator_side.trim().is_empty()
                && !a.opponent_side.trim().is_empty()
                && a.creator_side.len() <= MAX_SIDE
                && a.opponent_side.len() <= MAX_SIDE,
            "bad sides"
        );
        require!(KINDS.contains(&a.kind.as_str()), "bad kind");
        require!(a.params.len() <= MAX_PARAMS, "params too long");
        require!(a.resolve_at_ms > now, "resolve time must be in the future");
        require!(a.resolve_at_ms <= now + MAX_HORIZON_MS, "resolve time too far");
        if let Some(i) = &a.invited {
            require!(i != &creator, "cannot invite yourself");
        }
        if let Some(j) = &a.judge {
            require!(j != &creator, "judge cannot be a player");
            require!(a.invited.as_ref() != Some(j), "judge cannot be a player");
        }
        let window = a.join_window_mins.unwrap_or(24 * 60) as u64 * 60_000;
        require!(window >= 60_000, "join window too short");
        let join_by = (now + window).min(a.resolve_at_ms);

        let id = self.next_id;
        self.next_id += 1;
        let duel = Duel {
            id,
            creator: creator.clone(),
            opponent: None,
            invited: a.invited,
            title: a.title,
            creator_side: a.creator_side,
            opponent_side: a.opponent_side,
            kind: a.kind,
            params: a.params,
            token,
            stake: U128(stake),
            judge: a.judge,
            created_at_ms: now,
            join_by_ms: join_by,
            resolve_at_ms: a.resolve_at_ms,
            status: Status::Open,
            claims: vec![],
            winner: None,
            verdict: None,
            payout_to: vec![],
            witnesses: vec![],
        };
        event("duel_created", serde_json::json!({"id": id, "creator": creator, "stake": U128(stake)}));
        self.duels.insert(id, duel);
        self.index_player(&creator, id);
        id
    }

    fn internal_join(&mut self, player: AccountId, token: Option<AccountId>, amount: u128, id: u64) {
        let now = env::block_timestamp_ms();
        let mut d = self.get(id);
        require!(d.status == Status::Open, "duel not open");
        require!(now <= d.join_by_ms, "join window closed");
        require!(player != d.creator, "cannot join your own duel");
        if let Some(i) = &d.invited {
            require!(i == &player, "this duel is invite-only");
        }
        require!(d.judge.as_ref() != Some(&player), "the judge cannot play");
        require!(d.token == token, "wrong token");
        require!(amount == d.stake.0, "stake must match exactly");
        d.opponent = Some(player.clone());
        d.status = Status::Locked;
        event("duel_locked", serde_json::json!({"id": id, "opponent": player}));
        self.duels.insert(id, d);
        self.locked.insert(id);
        self.index_player(&player, id);
    }

    // --------------------------------------------------------------- players

    /// Creator can cancel before anyone joins. Anyone can cancel an open duel
    /// after its join window closed. The creator is refunded.
    pub fn cancel_duel(&mut self, duel_id: u64) -> Promise {
        let mut d = self.get(duel_id);
        require!(d.status == Status::Open, "duel not open");
        let caller = env::predecessor_account_id();
        require!(
            caller == d.creator || env::block_timestamp_ms() > d.join_by_ms,
            "only the creator can cancel now"
        );
        d.status = Status::Cancelled;
        self.cleanup_witness_keys(&d);
        let to = d.payout_account(&d.creator.clone());
        let (token, stake) = (d.token.clone(), d.stake.0);
        let owner = d.creator.clone();
        event("duel_cancelled", serde_json::json!({"id": duel_id}));
        self.duels.insert(duel_id, d);
        self.pay(token, to, owner, stake)
    }

    /// Where to send my winnings / refund (e.g. a NEAR Intents deposit
    /// address that forwards to my wallet on another chain).
    pub fn set_payout(&mut self, duel_id: u64, receiver: AccountId) {
        let mut d = self.get(duel_id);
        let caller = env::predecessor_account_id();
        require!(d.is_player(&caller), "not a player");
        require!(matches!(d.status, Status::Open | Status::Locked), "duel finished");
        d.payout_to.retain(|(p, _)| p != &caller);
        d.payout_to.push((caller, receiver));
        self.duels.insert(duel_id, d);
    }

    /// Report the result. `winner = None` means draw.
    /// * Conceding (naming the other player) settles immediately.
    /// * If both players report the same result, it settles immediately.
    pub fn submit_claim(
        &mut self,
        duel_id: u64,
        winner: Option<AccountId>,
        evidence: Option<String>,
    ) -> Option<Promise> {
        let mut d = self.get(duel_id);
        let caller = env::predecessor_account_id();
        require!(d.status == Status::Locked, "duel not locked");
        require!(d.is_player(&caller), "not a player");
        if let Some(e) = &evidence {
            require!(e.len() <= MAX_EVIDENCE, "evidence too long");
        }
        if let Some(w) = &winner {
            require!(d.is_player(w), "winner must be a player");
        }
        d.claims.retain(|c| c.player != caller);
        d.claims.push(Claim { player: caller.clone(), winner: winner.clone(), evidence });
        event("claim", serde_json::json!({"id": duel_id, "player": caller, "winner": winner}));

        let conceded = matches!(&winner, Some(w) if w != &caller);
        let agreed = d.claims.len() == 2 && d.claims[0].winner == d.claims[1].winner;
        if conceded || agreed {
            let how = if conceded { "concession" } else { "both players agreed" };
            let verdict = serde_json::json!({
                "settled_by": "players",
                "method": how,
                "winner": winner,
            })
            .to_string();
            return Some(self.settle(d, winner, verdict));
        }
        self.duels.insert(duel_id, d);
        None
    }

    // ------------------------------------------------------------- witnesses

    /// Add a friend from the group chat as a witness. Attach exactly 0.1
    /// NEAR (it pays for their votes, so they never need NEAR or a wallet).
    /// The other player must approve the witness before it counts.
    #[payable]
    pub fn add_witness(&mut self, duel_id: u64, name: String, public_key: PublicKey) {
        let mut d = self.get(duel_id);
        let caller = env::predecessor_account_id();
        require!(d.is_player(&caller), "not a player");
        require!(matches!(d.status, Status::Open | Status::Locked), "duel finished");
        require!(d.judge.is_none(), "this duel has a friend judge");
        require!(env::attached_deposit().as_yoctonear() == WITNESS_FEE, "attach exactly 0.1 NEAR");
        require!(!name.trim().is_empty() && name.len() <= MAX_NAME, "bad witness name");
        require!(d.witnesses.len() < MAX_WITNESSES, "too many witnesses");
        require!(d.witnesses.iter().all(|w| !w.voted), "voting already started");
        require!(!self.witness_keys.contains_key(&public_key), "this witness key is already in use");
        require!(d.witnesses.iter().all(|w| w.key != public_key), "duplicate witness");
        self.witness_keys.insert(public_key.clone(), duel_id);
        event("witness_added", serde_json::json!({"id": duel_id, "name": name, "by": caller}));
        d.witnesses.push(Witness { name, key: public_key, added_by: caller, approved: false, voted: false, vote: None });
        self.duels.insert(duel_id, d);
    }

    /// The OTHER player approves a witness (after checking the witness code
    /// the friend posted in the group chat). This activates their vote key.
    pub fn approve_witness(&mut self, duel_id: u64, index: u32) -> Promise {
        let mut d = self.get(duel_id);
        let caller = env::predecessor_account_id();
        let i = index as usize;
        require!(i < d.witnesses.len(), "no such witness");
        require!(d.status == Status::Open || d.status == Status::Locked, "duel finished");
        require!(d.is_player(&caller), "not a player");
        require!(d.witnesses[i].added_by != caller, "the other player must approve");
        require!(!d.witnesses[i].approved, "already approved");
        d.witnesses[i].approved = true;
        let key = d.witnesses[i].key.clone();
        event("witness_approved", serde_json::json!({"id": duel_id, "name": d.witnesses[i].name}));
        self.duels.insert(duel_id, d);
        let me = env::current_account_id();
        Promise::new(me.clone()).add_access_key_allowance(
            key,
            Allowance::limited(NearToken::from_yoctonear(WITNESS_FEE)).unwrap(),
            me,
            "witness_vote",
        )
    }

    /// Either player can remove a witness that hasn't been approved yet (e.g.
    /// the witness code didn't match). The fee goes back to whoever added it.
    pub fn reject_witness(&mut self, duel_id: u64, index: u32) -> Promise {
        let mut d = self.get(duel_id);
        let caller = env::predecessor_account_id();
        let i = index as usize;
        require!(i < d.witnesses.len(), "no such witness");
        require!(d.is_player(&caller), "not a player");
        require!(!d.witnesses[i].approved, "already approved");
        let w = d.witnesses.remove(i);
        self.witness_keys.remove(&w.key);
        self.duels.insert(duel_id, d);
        Promise::new(w.added_by).transfer(NearToken::from_yoctonear(WITNESS_FEE))
    }

    /// Called by a witness from their link. The transaction is signed with
    /// the witness's function-call key on THIS contract account, so the
    /// witness needs no account, no wallet and no gas.
    pub fn witness_vote(&mut self, duel_id: u64, winner: Option<AccountId>) -> Option<Promise> {
        let me = env::current_account_id();
        require!(env::predecessor_account_id() == me, "witnesses vote with their witness key");
        let pk = env::signer_account_pk();
        require!(self.witness_keys.get(&pk) == Some(&duel_id), "not a witness of this duel");
        let mut d = self.get(duel_id);
        require!(d.status == Status::Locked, "duel not locked");
        require!(
            env::block_timestamp_ms() >= d.resolve_at_ms || d.claims_conflict(),
            "voting opens at the resolve time"
        );
        if let Some(w) = &winner {
            require!(d.is_player(w), "winner must be a player");
        }
        let i = d.witnesses.iter().position(|w| w.key == pk).unwrap_or_else(|| env::panic_str("not a witness"));
        require!(d.witnesses[i].approved, "witness not approved");
        require!(!d.witnesses[i].voted, "already voted");
        d.witnesses[i].voted = true;
        d.witnesses[i].vote = winner.clone();
        event("witness_vote", serde_json::json!({"id": duel_id, "name": d.witnesses[i].name, "winner": winner}));

        let n = d.approved_witnesses();
        let same = d.witnesses.iter().filter(|w| w.approved && w.voted && w.vote == winner).count();
        if same * 2 > n {
            let votes: Vec<_> = d
                .witnesses
                .iter()
                .filter(|w| w.approved)
                .map(|w| serde_json::json!({"name": w.name, "voted": w.voted, "winner": w.vote}))
                .collect();
            let verdict = serde_json::json!({
                "settled_by": "witnesses",
                "method": "group-chat majority",
                "winner": winner,
                "votes": votes,
            })
            .to_string();
            return Some(self.settle(d, winner, verdict));
        }
        self.duels.insert(duel_id, d);
        None
    }

    fn cleanup_witness_keys(&mut self, d: &Duel) {
        let me = env::current_account_id();
        for w in &d.witnesses {
            self.witness_keys.remove(&w.key);
            if w.approved {
                Promise::new(me.clone()).delete_key(w.key.clone()).detach();
            } else {
                // never activated: give the fee back
                Promise::new(w.added_by.clone()).transfer(NearToken::from_yoctonear(WITNESS_FEE)).detach();
            }
        }
    }

    // ----------------------------------------------------------------- judge

    /// Settle a duel. Callable by the chosen judge, or the DUEL referee when
    /// no judge was chosen, once the resolve time has passed.
    pub fn resolve(&mut self, duel_id: u64, winner: Option<AccountId>, verdict: String) -> Promise {
        let d = self.get(duel_id);
        let caller = env::predecessor_account_id();
        let judge = d.judge.clone().unwrap_or_else(|| self.referee.clone());
        require!(caller == judge, "only the judge can settle this duel");
        require!(d.status == Status::Locked, "duel not locked");
        require!(env::block_timestamp_ms() >= d.resolve_at_ms, "too early to settle");
        if d.approved_witnesses() > 0 {
            require!(
                env::block_timestamp_ms() >= d.resolve_at_ms + self.witness_window_ms,
                "witnesses are still voting"
            );
        }
        require!(verdict.len() <= MAX_VERDICT, "verdict too long");
        if let Some(w) = &winner {
            require!(d.is_player(w), "winner must be a player");
        }
        self.settle(d, winner, verdict)
    }

    /// Safety valve: if nobody settled within the grace period after the
    /// resolve time, anyone can refund both players.
    pub fn refund_expired(&mut self, duel_id: u64) -> Promise {
        let mut d = self.get(duel_id);
        require!(d.status == Status::Locked, "duel not locked");
        require!(
            env::block_timestamp_ms() > d.resolve_at_ms + self.grace_ms,
            "grace period not over"
        );
        d.status = Status::Refunded;
        self.locked.remove(&duel_id);
        self.cleanup_witness_keys(&d);
        let a = d.creator.clone();
        let b = d.opponent.clone().unwrap();
        let (to_a, to_b) = (d.payout_account(&a), d.payout_account(&b));
        let (token, stake) = (d.token.clone(), d.stake.0);
        event("duel_refunded", serde_json::json!({"id": duel_id}));
        self.duels.insert(duel_id, d);
        self.pay(token.clone(), to_a, a, stake)
            .and(self.pay(token, to_b, b, stake))
    }

    fn settle(&mut self, mut d: Duel, winner: Option<AccountId>, verdict: String) -> Promise {
        let id = d.id;
        self.locked.remove(&id);
        self.cleanup_witness_keys(&d);
        let (token, stake) = (d.token.clone(), d.stake.0);
        d.verdict = Some(verdict);
        d.winner = winner.clone();
        let promise = match winner {
            Some(w) => {
                d.status = Status::Settled;
                let pot = stake * 2;
                let fee = pot * self.fee_bps as u128 / 10_000;
                if fee > 0 {
                    let k = owed_key(&self.treasury, &token);
                    let cur = self.owed.get(&k).copied().unwrap_or(0);
                    self.owed.insert(k, cur + fee);
                }
                let to = d.payout_account(&w);
                event("duel_settled", serde_json::json!({"id": id, "winner": w, "paid": U128(pot - fee), "fee": U128(fee)}));
                self.pay(token, to, w, pot - fee)
            }
            None => {
                d.status = Status::Draw;
                let a = d.creator.clone();
                let b = d.opponent.clone().unwrap();
                let (to_a, to_b) = (d.payout_account(&a), d.payout_account(&b));
                event("duel_draw", serde_json::json!({"id": id}));
                self.pay(token.clone(), to_a, a, stake)
                    .and(self.pay(token, to_b, b, stake))
            }
        };
        self.duels.insert(id, d);
        promise
    }

    // ---------------------------------------------------------------- payout

    fn pay(&self, token: Option<AccountId>, to: AccountId, owner: AccountId, amount: u128) -> Promise {
        let transfer = match &token {
            None => Promise::new(to).transfer(NearToken::from_yoctonear(amount)),
            Some(t) => ext_ft::ext(t.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(to, U128(amount), Some("DUEL payout".into())),
        };
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_payout(token, owner, U128(amount)),
        )
    }

    /// If a payout failed, keep the money as an owed balance for its owner.
    #[private]
    pub fn on_payout(&mut self, token: Option<AccountId>, owner: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            let k = owed_key(&owner, &token);
            let cur = self.owed.get(&k).copied().unwrap_or(0);
            self.owed.insert(k, cur + amount.0);
            event("payout_failed", serde_json::json!({"owner": owner, "amount": amount}));
        }
        ok
    }

    /// Withdraw an owed balance (failed payouts, or protocol fees for the
    /// treasury) to yourself.
    pub fn withdraw_owed(&mut self, token: Option<AccountId>) -> Promise {
        let caller = env::predecessor_account_id();
        let k = owed_key(&caller, &token);
        let amount = self.owed.remove(&k).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.pay(token, caller.clone(), caller, amount)
    }

    // ----------------------------------------------------------------- admin

    pub fn set_referee(&mut self, referee: AccountId) {
        self.assert_owner();
        self.referee = referee;
    }

    pub fn set_fee(&mut self, fee_bps: u16) {
        self.assert_owner();
        require!(fee_bps <= MAX_FEE_BPS, "fee too high");
        self.fee_bps = fee_bps;
    }

    pub fn set_witness_window(&mut self, ms: u64) {
        self.assert_owner();
        self.witness_window_ms = ms;
    }

    pub fn set_min_stake_near(&mut self, min: U128) {
        self.assert_owner();
        self.min_stake_near = min.0;
    }

    /// Accept a NEP-141 token (e.g. USDC) with a minimum stake.
    pub fn set_token(&mut self, token: AccountId, min_stake: Option<U128>) {
        self.assert_owner();
        match min_stake {
            Some(m) => {
                self.tokens.insert(token, m.0);
            }
            None => {
                self.tokens.remove(&token);
            }
        }
    }

    // ----------------------------------------------------------------- views

    pub fn get_duel(&self, duel_id: u64) -> Option<Duel> {
        self.duels.get(&duel_id).cloned()
    }

    /// Newest first.
    pub fn get_latest(&self, limit: Option<u64>) -> Vec<Duel> {
        let limit = limit.unwrap_or(20).min(50);
        (0..self.next_id)
            .rev()
            .take(limit as usize)
            .filter_map(|i| self.duels.get(&i).cloned())
            .collect()
    }

    /// Locked duels the DUEL referee should settle now (no friend judge,
    /// resolve time passed).
    pub fn get_ready_for_referee(&self, limit: Option<u64>) -> Vec<Duel> {
        let now = env::block_timestamp_ms();
        let limit = limit.unwrap_or(25).min(100) as usize;
        self.locked
            .iter()
            .filter_map(|i| self.duels.get(i))
            .filter(|d| {
                d.judge.is_none()
                    && now >= d.resolve_at_ms
                    && (d.approved_witnesses() == 0 || now >= d.resolve_at_ms + self.witness_window_ms)
            })
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn get_player_duels(&self, account: AccountId) -> Vec<Duel> {
        self.players
            .get(&account)
            .map(|ids| ids.iter().rev().filter_map(|i| self.duels.get(i).cloned()).collect())
            .unwrap_or_default()
    }

    pub fn get_owed(&self, account: AccountId, token: Option<AccountId>) -> U128 {
        U128(self.owed.get(&owed_key(&account, &token)).copied().unwrap_or(0))
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            referee: self.referee.clone(),
            treasury: self.treasury.clone(),
            fee_bps: self.fee_bps,
            min_stake_near: U128(self.min_stake_near),
            grace_ms: self.grace_ms,
            witness_window_ms: self.witness_window_ms,
            duel_count: self.next_id,
            version: VERSION,
        }
    }

    pub fn get_token_min_stake(&self, token: AccountId) -> Option<U128> {
        self.tokens.get(&token).map(|m| U128(*m))
    }

    // --------------------------------------------------------------- helpers

    fn get(&self, id: u64) -> Duel {
        self.duels
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("duel not found"))
    }

    fn index_player(&mut self, a: &AccountId, id: u64) {
        let mut v = self.players.get(a).cloned().unwrap_or_default();
        v.push(id);
        self.players.insert(a.clone(), v);
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
}

#[cfg(test)]
mod tests;
