#![allow(unused_must_use, deprecated)]
use super::*;
use near_sdk::mock::MockAction;

use near_sdk::test_utils::{get_created_receipts, get_logs, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0_MS: u64 = 1_800_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("duel.testnet")
}
fn referee() -> AccountId {
    acc("referee.testnet")
}
fn treasury() -> AccountId {
    acc("treasury.testnet")
}
fn taj() -> AccountId {
    acc("tajudeen.testnet")
}
fn truth() -> AccountId {
    acc("truth.testnet")
}
fn usdc() -> AccountId {
    acc("usdc.testnet")
}

fn ctx(caller: &AccountId, deposit: u128, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

fn setup() -> Contract {
    ctx(&owner(), 0, T0_MS);
    // 2% fee, 0.1 NEAR minimum stake
    Contract::new(owner(), referee(), treasury(), 200, U128(NEAR / 10), None)
}

fn args(kind: &str, resolve_in_ms: u64) -> CreateArgs {
    CreateArgs {
        title: "BTC above $120k on Friday?".into(),
        creator_side: "BTC >= $120,000".into(),
        opponent_side: "BTC < $120,000".into(),
        kind: kind.into(),
        params: r#"{"asset":"bitcoin","target_usd":120000,"creator_wins_if":"above"}"#.into(),
        invited: None,
        judge: None,
        join_window_mins: Some(60),
        resolve_at_ms: T0_MS + resolve_in_ms,
    }
}

/// Create a NEAR duel (1 NEAR each) and lock it.
fn locked_duel(c: &mut Contract) -> u64 {
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&truth(), NEAR, T0_MS + 1000);
    c.join_duel(id);
    id
}

/// All native NEAR transfers created so far: (receiver, yocto).
fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn ft_transfers() -> Vec<(AccountId, String)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, .. }
                    if method_name == b"ft_transfer" =>
                {
                    Some((to.clone(), String::from_utf8(args).unwrap()))
                }
                _ => None,
            })
        })
        .collect()
}

// ------------------------------------------------------------------ create

#[test]
fn create_and_join_locks_both_stakes() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    let d = c.get_duel(id).unwrap();
    assert_eq!(d.status, Status::Locked);
    assert_eq!(d.opponent, Some(truth()));
    assert_eq!(d.stake, U128(NEAR));
    assert!(get_logs().iter().any(|l| l.contains("duel_locked")));
    assert_eq!(c.get_player_duels(taj()).len(), 1);
    assert_eq!(c.get_player_duels(truth()).len(), 1);
}

#[test]
#[should_panic(expected = "stake below minimum")]
fn rejects_tiny_stake() {
    let mut c = setup();
    ctx(&taj(), NEAR / 100, T0_MS);
    c.create_duel(args("price", DAY_MS));
}

#[test]
#[should_panic(expected = "bad kind")]
fn rejects_unknown_kind() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    c.create_duel(args("lottery", DAY_MS));
}

#[test]
#[should_panic(expected = "resolve time must be in the future")]
fn rejects_past_resolve_time() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS + DAY_MS * 2);
    c.create_duel(args("price", DAY_MS));
}

#[test]
#[should_panic(expected = "stake must match exactly")]
fn join_needs_exact_stake() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&truth(), NEAR / 2, T0_MS);
    c.join_duel(id);
}

#[test]
#[should_panic(expected = "cannot join your own duel")]
fn cannot_join_own_duel() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&taj(), NEAR, T0_MS);
    c.join_duel(id);
}

#[test]
#[should_panic(expected = "invite-only")]
fn invite_only_duel_blocks_strangers() {
    let mut c = setup();
    let mut a = args("price", DAY_MS);
    a.invited = Some(truth());
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(a);
    ctx(&acc("stranger.testnet"), NEAR, T0_MS);
    c.join_duel(id);
}

#[test]
#[should_panic(expected = "the judge cannot play")]
fn judge_cannot_join() {
    let mut c = setup();
    let mut a = args("game", DAY_MS);
    a.judge = Some(acc("ref-friend.testnet"));
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(a);
    ctx(&acc("ref-friend.testnet"), NEAR, T0_MS);
    c.join_duel(id);
}

#[test]
#[should_panic(expected = "join window closed")]
fn join_window_closes() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&truth(), NEAR, T0_MS + 61 * 60_000);
    c.join_duel(id);
}

// ------------------------------------------------------------------ settle

#[test]
fn referee_settles_and_winner_gets_pot_minus_fee() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&referee(), 0, T0_MS + DAY_MS);
    c.resolve(id, Some(truth()), r#"{"by":"ai"}"#.into());
    let d = c.get_duel(id).unwrap();
    assert_eq!(d.status, Status::Settled);
    assert_eq!(d.winner, Some(truth()));
    // pot 2 NEAR, 2% fee = 0.04 NEAR
    assert!(transfers().contains(&(truth(), 2 * NEAR - 4 * NEAR / 100)));
    assert_eq!(c.get_owed(treasury(), None), U128(4 * NEAR / 100));
    assert!(c.get_ready_for_referee(None).is_empty());
}

#[test]
#[should_panic(expected = "only the judge")]
fn stranger_cannot_settle() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + DAY_MS);
    c.resolve(id, Some(taj()), "{}".into());
}

#[test]
#[should_panic(expected = "too early")]
fn referee_cannot_settle_early() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&referee(), 0, T0_MS + DAY_MS - 1);
    c.resolve(id, Some(taj()), "{}".into());
}

#[test]
#[should_panic(expected = "winner must be a player")]
fn winner_must_be_player() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&referee(), 0, T0_MS + DAY_MS);
    c.resolve(id, Some(referee()), "{}".into());
}

#[test]
fn friend_judge_settles_not_referee() {
    let mut c = setup();
    let judge = acc("ref-friend.testnet");
    let mut a = args("game", DAY_MS);
    a.judge = Some(judge.clone());
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(a);
    ctx(&truth(), NEAR, T0_MS);
    c.join_duel(id);
    // the AI referee does not see friend-judged duels
    ctx(&referee(), 0, T0_MS + DAY_MS);
    assert!(c.get_ready_for_referee(None).is_empty());
    ctx(&judge, 0, T0_MS + DAY_MS);
    c.resolve(id, Some(taj()), r#"{"by":"friend"}"#.into());
    assert_eq!(c.get_duel(id).unwrap().winner, Some(taj()));
}

#[test]
fn ready_list_shows_due_duels_only() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&referee(), 0, T0_MS + 5);
    assert!(c.get_ready_for_referee(None).is_empty());
    ctx(&referee(), 0, T0_MS + DAY_MS);
    let ready = c.get_ready_for_referee(None);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].id, id);
}

#[test]
fn draw_refunds_both_without_fee() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&referee(), 0, T0_MS + DAY_MS);
    c.resolve(id, None, r#"{"by":"ai","result":"draw"}"#.into());
    assert_eq!(c.get_duel(id).unwrap().status, Status::Draw);
    let t = transfers();
    assert!(t.contains(&(taj(), NEAR)));
    assert!(t.contains(&(truth(), NEAR)));
    assert_eq!(c.get_owed(treasury(), None), U128(0));
}

// ------------------------------------------------------------------ claims

#[test]
fn concession_settles_immediately() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + 5000); // before resolve time
    let p = c.submit_claim(id, Some(truth()), Some("GG, you won".into()));
    assert!(p.is_some());
    let d = c.get_duel(id).unwrap();
    assert_eq!(d.status, Status::Settled);
    assert_eq!(d.winner, Some(truth()));
    assert!(d.verdict.unwrap().contains("concession"));
}

#[test]
fn matching_claims_settle_without_referee() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + 5000);
    assert!(c.submit_claim(id, None, None).is_none()); // taj says draw
    ctx(&truth(), 0, T0_MS + 6000);
    assert!(c.submit_claim(id, None, None).is_some()); // truth agrees
    assert_eq!(c.get_duel(id).unwrap().status, Status::Draw);
}

#[test]
fn conflicting_claims_wait_for_referee() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + 5000);
    assert!(c.submit_claim(id, Some(taj()), None).is_none());
    ctx(&truth(), 0, T0_MS + 6000);
    assert!(c.submit_claim(id, Some(truth()), None).is_none());
    let d = c.get_duel(id).unwrap();
    assert_eq!(d.status, Status::Locked);
    assert_eq!(d.claims.len(), 2);
}

#[test]
fn changing_your_claim_replaces_it() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + 5000);
    c.submit_claim(id, Some(taj()), None);
    c.submit_claim(id, None, None);
    assert_eq!(c.get_duel(id).unwrap().claims.len(), 1);
}

// ----------------------------------------------------------- refunds/cancel

#[test]
fn creator_cancels_open_duel() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&taj(), 0, T0_MS + 10);
    c.cancel_duel(id);
    assert_eq!(c.get_duel(id).unwrap().status, Status::Cancelled);
    assert!(transfers().contains(&(taj(), NEAR)));
}

#[test]
#[should_panic(expected = "only the creator can cancel now")]
fn stranger_cannot_cancel_before_window_ends() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&truth(), 0, T0_MS + 10);
    c.cancel_duel(id);
}

#[test]
fn anyone_refunds_after_grace_period() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&acc("anyone.testnet"), 0, T0_MS + DAY_MS + 7 * DAY_MS + 1);
    c.refund_expired(id);
    assert_eq!(c.get_duel(id).unwrap().status, Status::Refunded);
    let t = transfers();
    assert!(t.contains(&(taj(), NEAR)) && t.contains(&(truth(), NEAR)));
}

#[test]
#[should_panic(expected = "grace period not over")]
fn no_refund_during_grace() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&acc("anyone.testnet"), 0, T0_MS + DAY_MS + 1);
    c.refund_expired(id);
}

// ------------------------------------------------------------------ payouts

#[test]
fn payout_goes_to_chosen_address() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    // e.g. a NEAR Intents deposit address that forwards to Solana
    let intents_addr = acc("6d3a0f8b2c1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a");
    ctx(&truth(), 0, T0_MS + 10);
    c.set_payout(id, intents_addr.clone());
    ctx(&referee(), 0, T0_MS + DAY_MS);
    c.resolve(id, Some(truth()), "{}".into());
    assert!(transfers().iter().any(|(to, _)| to == &intents_addr));
}

#[test]
fn failed_payout_becomes_owed_and_withdrawable() {
    let mut c = setup();
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner()).predecessor_account_id(owner());
    testing_env_with_promise_results(b.build(), PromiseResult::Failed);
    assert!(!c.on_payout(None, truth(), U128(5)));
    assert_eq!(c.get_owed(truth(), None), U128(5));
    ctx(&truth(), 0, T0_MS);
    c.withdraw_owed(None);
    assert_eq!(c.get_owed(truth(), None), U128(0));
    assert!(transfers().contains(&(truth(), 5)));
}

// ------------------------------------------------------------------- tokens

#[test]
fn usdc_duel_via_ft_transfer_call() {
    let mut c = setup();
    ctx(&owner(), 0, T0_MS);
    c.set_token(usdc(), Some(U128(1_000_000))); // $1 minimum (6 decimals)
    let msg = serde_json::json!({"create": {
        "title": "Arsenal beat Chelsea?", "creator_side": "Arsenal win",
        "opponent_side": "Chelsea win or draw", "kind": "football",
        "params": "{\"event_id\":\"123\"}", "resolve_at_ms": T0_MS + DAY_MS
    }})
    .to_string();
    ctx(&usdc(), 0, T0_MS);
    c.ft_on_transfer(taj(), U128(5_000_000), msg);
    ctx(&usdc(), 0, T0_MS + 1);
    c.ft_on_transfer(truth(), U128(5_000_000), r#"{"join":{"duel_id":0}}"#.into());
    assert_eq!(c.get_duel(0).unwrap().status, Status::Locked);
    ctx(&referee(), 0, T0_MS + DAY_MS);
    c.resolve(0, Some(taj()), "{}".into());
    let ft = ft_transfers();
    assert!(ft.iter().any(|(t, a)| t == &usdc() && a.contains("tajudeen.testnet") && a.contains("9800000")));
}

#[test]
#[should_panic(expected = "token not accepted")]
fn unknown_token_rejected() {
    let mut c = setup();
    ctx(&acc("scam-token.testnet"), 0, T0_MS);
    c.ft_on_transfer(taj(), U128(5), r#"{"join":{"duel_id":0}}"#.into());
}

#[test]
#[should_panic(expected = "wrong token")]
fn cannot_join_near_duel_with_token() {
    let mut c = setup();
    ctx(&owner(), 0, T0_MS);
    c.set_token(usdc(), Some(U128(1)));
    ctx(&taj(), NEAR, T0_MS);
    let id = c.create_duel(args("price", DAY_MS));
    ctx(&usdc(), 0, T0_MS);
    c.ft_on_transfer(truth(), U128(NEAR), format!(r#"{{"join":{{"duel_id":{id}}}}}"#));
}

// -------------------------------------------------------------------- admin

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_changes_fee() {
    let mut c = setup();
    ctx(&taj(), 0, T0_MS);
    c.set_fee(0);
}

#[test]
fn latest_lists_newest_first() {
    let mut c = setup();
    ctx(&taj(), NEAR, T0_MS);
    c.create_duel(args("price", DAY_MS));
    c.create_duel(args("custom", DAY_MS));
    let l = c.get_latest(None);
    assert_eq!(l[0].id, 1);
    assert_eq!(c.get_config().duel_count, 2);
}

#[test]
#[should_panic(expected = "evidence too long")]
fn evidence_is_bounded() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + 5000);
    c.submit_claim(id, Some(taj()), Some("x".repeat(501)));
}

// ---------------------------------------------------------------- witnesses

fn pk(i: usize) -> PublicKey {
    [
        "ed25519:HAz8tUMQ1mfSD9YSpUoiyKuG4cGRjjwXPLgMC4BJfVRd",
        "ed25519:G1WxtuyqXnA3PZJGSdmc7mBoAXtwXf9sfo2Vxxz1yhsr",
        "ed25519:CfH6m7wsakSAJNjxs681k2XVPWezdP2zYG5UhiNe4jAh",
        "ed25519:DHfAQBfWGQ2gv2pxMEo7ajED1CfSvFWF9wV7VEySZYGh",
    ][i]
    .parse()
    .unwrap()
}

/// Called as a witness: predecessor = contract itself, signed with `key`.
fn as_witness(key: PublicKey, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner())
        .predecessor_account_id(owner())
        .signer_account_id(owner())
        .signer_account_pk(key)
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

/// Locked duel with 3 approved witnesses (taj adds 2, truth adds 1).
fn duel_with_witnesses(c: &mut Contract) -> u64 {
    let id = locked_duel(c);
    for (i, who) in [(0, taj()), (1, taj()), (2, truth())] {
        ctx(&who, WITNESS_FEE, T0_MS + 10);
        c.add_witness(id, format!("friend{i}"), pk(i));
    }
    ctx(&truth(), 0, T0_MS + 20);
    c.approve_witness(id, 0);
    c.approve_witness(id, 1);
    ctx(&taj(), 0, T0_MS + 20);
    c.approve_witness(id, 2);
    id
}

#[test]
fn approving_a_witness_adds_a_vote_only_key() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), WITNESS_FEE, T0_MS + 10);
    c.add_witness(id, "Ada".into(), pk(0));
    ctx(&truth(), 0, T0_MS + 20);
    c.approve_witness(id, 0);
    let added = get_created_receipts().into_iter().flat_map(|r| r.actions).any(|a| matches!(
        a,
        MockAction::AddKeyWithFunctionCall { ref method_names, ref allowance, .. } if method_names.iter().any(|f| f == "witness_vote") && allowance.is_some()
    ));
    assert!(added);
    assert!(c.get_duel(id).unwrap().witnesses[0].approved);
}

#[test]
#[should_panic(expected = "the other player must approve")]
fn cannot_approve_your_own_witness() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), WITNESS_FEE, T0_MS + 10);
    c.add_witness(id, "Ada".into(), pk(0));
    c.approve_witness(id, 0);
}

#[test]
#[should_panic(expected = "attach exactly 0.1 NEAR")]
fn adding_a_witness_needs_the_fee() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), 0, T0_MS + 10);
    c.add_witness(id, "Ada".into(), pk(0));
}

#[test]
#[should_panic(expected = "not a player")]
fn strangers_cannot_add_witnesses() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&acc("stranger.testnet"), WITNESS_FEE, T0_MS + 10);
    c.add_witness(id, "Ada".into(), pk(0));
}

#[test]
fn majority_of_witnesses_settles() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    as_witness(pk(0), T0_MS + DAY_MS);
    assert!(c.witness_vote(id, Some(truth())).is_none()); // 1 of 3
    as_witness(pk(2), T0_MS + DAY_MS + 1);
    assert!(c.witness_vote(id, Some(truth())).is_some()); // 2 of 3 -> settled
    let d = c.get_duel(id).unwrap();
    assert_eq!(d.status, Status::Settled);
    assert_eq!(d.winner, Some(truth()));
    assert!(d.verdict.unwrap().contains("witnesses"));
    let deleted = get_created_receipts().into_iter().flat_map(|r| r.actions).filter(|a| matches!(a, MockAction::DeleteKey { .. })).count();
    assert_eq!(deleted, 3);
}

#[test]
fn split_witnesses_do_not_settle() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    as_witness(pk(0), T0_MS + DAY_MS);
    c.witness_vote(id, Some(truth()));
    as_witness(pk(1), T0_MS + DAY_MS);
    c.witness_vote(id, Some(taj()));
    assert_eq!(c.get_duel(id).unwrap().status, Status::Locked);
}

#[test]
#[should_panic(expected = "witnesses vote with their witness key")]
fn players_cannot_call_witness_vote() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    ctx(&taj(), 0, T0_MS + DAY_MS);
    c.witness_vote(id, Some(taj()));
}

#[test]
#[should_panic(expected = "not a witness of this duel")]
fn unknown_key_cannot_vote() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    as_witness(pk(3), T0_MS + DAY_MS);
    c.witness_vote(id, Some(taj()));
}

#[test]
#[should_panic(expected = "witness not approved")]
fn unapproved_witness_cannot_vote() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), WITNESS_FEE, T0_MS + 10);
    c.add_witness(id, "Ada".into(), pk(0));
    as_witness(pk(0), T0_MS + DAY_MS);
    c.witness_vote(id, Some(taj()));
}

#[test]
#[should_panic(expected = "already voted")]
fn witness_votes_once() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    as_witness(pk(0), T0_MS + DAY_MS);
    c.witness_vote(id, Some(taj()));
    c.witness_vote(id, Some(taj()));
}

#[test]
#[should_panic(expected = "voting opens at the resolve time")]
fn witnesses_wait_for_the_result() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    as_witness(pk(0), T0_MS + 100);
    c.witness_vote(id, Some(taj()));
}

#[test]
fn witnesses_can_vote_early_when_players_disagree() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    ctx(&taj(), 0, T0_MS + 100);
    c.submit_claim(id, Some(taj()), None);
    ctx(&truth(), 0, T0_MS + 100);
    c.submit_claim(id, Some(truth()), None);
    as_witness(pk(0), T0_MS + 200);
    assert!(c.witness_vote(id, Some(taj())).is_none());
}

#[test]
fn referee_waits_for_witnesses_then_can_step_in() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    ctx(&referee(), 0, T0_MS + DAY_MS + 10);
    assert!(c.get_ready_for_referee(None).is_empty());
    ctx(&referee(), 0, T0_MS + 2 * DAY_MS + 10);
    assert_eq!(c.get_ready_for_referee(None).len(), 1);
    c.resolve(id, None, "{}".into());
    assert_eq!(c.get_duel(id).unwrap().status, Status::Draw);
}

#[test]
#[should_panic(expected = "witnesses are still voting")]
fn referee_cannot_overrule_witnesses_early() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    ctx(&referee(), 0, T0_MS + DAY_MS + 10);
    c.resolve(id, Some(taj()), "{}".into());
}

#[test]
fn rejecting_a_witness_refunds_the_fee() {
    let mut c = setup();
    let id = locked_duel(&mut c);
    ctx(&taj(), WITNESS_FEE, T0_MS + 10);
    c.add_witness(id, "Ada".into(), pk(0));
    ctx(&truth(), 0, T0_MS + 20);
    c.reject_witness(id, 0);
    assert!(c.get_duel(id).unwrap().witnesses.is_empty());
    assert!(transfers().contains(&(taj(), WITNESS_FEE)));
}

#[test]
#[should_panic(expected = "this witness key is already in use")]
fn witness_key_belongs_to_one_duel() {
    let mut c = setup();
    let a = locked_duel(&mut c);
    ctx(&taj(), WITNESS_FEE, T0_MS + 10);
    c.add_witness(a, "Ada".into(), pk(0));
    ctx(&taj(), NEAR, T0_MS);
    let b = c.create_duel(args("price", DAY_MS));
    ctx(&taj(), WITNESS_FEE, T0_MS + 10);
    c.add_witness(b, "Ada".into(), pk(0));
}

#[test]
fn concession_still_settles_and_cleans_witness_keys() {
    let mut c = setup();
    let id = duel_with_witnesses(&mut c);
    ctx(&taj(), 0, T0_MS + 100);
    c.submit_claim(id, Some(truth()), None);
    assert_eq!(c.get_duel(id).unwrap().status, Status::Settled);
    let deleted = get_created_receipts().into_iter().flat_map(|r| r.actions).filter(|a| matches!(a, MockAction::DeleteKey { .. })).count();
    assert_eq!(deleted, 3);
}
