// Browser-side NEAR access: config, views over JSON-RPC, wallet calls.
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { actionCreators } from "@near-js/transactions";
import "@near-wallet-selector/modal-ui/styles.css";

/* global __DUEL_CONTRACT__, __DUEL_NETWORK__ */
const qs = new URLSearchParams(location.search);
export const NETWORK = qs.get("network") || (typeof __DUEL_NETWORK__ !== "undefined" ? __DUEL_NETWORK__ : "testnet");
export const CONTRACT = qs.get("contract") || (typeof __DUEL_CONTRACT__ !== "undefined" ? __DUEL_CONTRACT__ : "");
export const RPC = NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const YOCTO = 10n ** 24n;
const TGAS = 1_000_000_000_000n;

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64bytes = (arr) => new TextDecoder().decode(new Uint8Array(arr));

export async function view(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "duel", method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: b64(JSON.stringify(args)) },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(j.error?.data || j.result?.error || "view failed");
  return JSON.parse(unb64bytes(j.result.result));
}

let selector, modal;
export async function initWallet() {
  selector = await setupWalletSelector({
    network: NETWORK,
    modules: [setupMyNearWallet(), setupMeteorWallet(), setupHotWallet(), setupIntearWallet()],
  });
  modal = setupModal(selector, { contractId: CONTRACT, description: "Connect a NEAR wallet to lock your stake." });
  return selector;
}

export function accountId() {
  const st = selector?.store.getState();
  return st?.accounts?.find((a) => a.active)?.accountId || st?.accounts?.[0]?.accountId || null;
}

export function onAccountChange(cb) {
  selector?.store.observable.subscribe(() => cb(accountId()));
}

export function connect() {
  modal.show();
}

export async function disconnect() {
  const w = await selector.wallet();
  await w.signOut();
}

/**
 * Call a contract method. `depositYocto` is a bigint.
 * Returns the parsed return value when the wallet gives it back (injected
 * wallets); redirect wallets come back to `callbackHash`.
 */
export async function call(method, args, { depositYocto = 0n, gasTgas = 150n, callbackHash, receiverId = CONTRACT } = {}) {
  if (!accountId()) {
    connect();
    throw new Error("Connect a wallet first");
  }
  const w = await selector.wallet();
  const callbackUrl = callbackHash ? `${location.origin}${location.pathname}${location.search}${callbackHash}` : undefined;
  const outcome = await w.signAndSendTransaction({
    receiverId,
    actions: [actionCreators.functionCall(method, args, gasTgas * TGAS, depositYocto)],
    callbackUrl,
  });
  const failure = outcome?.status?.Failure;
  if (failure) throw new Error(prettyFailure(failure));
  const sv = outcome?.status?.SuccessValue;
  if (sv) {
    try {
      return JSON.parse(atob(sv));
    } catch {}
  }
  return outcome ? null : undefined;
}

function prettyFailure(f) {
  const s = JSON.stringify(f);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : "Transaction failed";
}

export function toYocto(near) {
  const [w, f = ""] = String(near).trim().split(".");
  return BigInt(w || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24) || "0");
}

export function fromYocto(y, digits = 4) {
  const v = BigInt(y);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
