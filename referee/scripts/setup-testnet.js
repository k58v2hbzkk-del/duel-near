#!/usr/bin/env node
// One-shot testnet setup, run by .github/workflows/deploy-testnet.yml.
// Needs: DUEL_SEED (repo secret). The contract account itself is created
// beforehand by the NEAR testnet faucet (see the workflow).
//
// 1. derive keys + account names from DUEL_SEED
// 2. deploy contract/target/near/duel_contract.wasm and init it
// 3. create the referee account and two demo players as sub-accounts
// 4. write deployments/testnet.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Account, JsonRpcProvider } from "near-api-js";
import { deriveKey, accountsFor } from "../src/keys.js";

const RPC = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const seed = process.env.DUEL_SEED;
const wasmPath = process.argv[2] || "../contract/target/near/duel_contract.wasm";
const NEAR = 10n ** 24n;

const names = accountsFor(seed);
const keys = {
  contract: deriveKey(seed, "contract"),
  referee: deriveKey(seed, "referee"),
  alice: deriveKey(seed, "alice"),
  bob: deriveKey(seed, "bob"),
};
const provider = new JsonRpcProvider({ url: RPC });

async function exists(id) {
  try {
    await provider.viewAccount({ accountId: id });
    return true;
  } catch {
    return false;
  }
}

const contract = new Account(names.contract, RPC, keys.contract.secretKey);
if (!(await exists(names.contract))) throw new Error(`${names.contract} does not exist yet: run the faucet step first`);

console.log(`deploying ${wasmPath} to ${names.contract}`);
await contract.deployContract(new Uint8Array(readFileSync(wasmPath)));

let initialised = true;
try {
  await provider.callFunction({ contractId: names.contract, method: "get_config", args: {} });
} catch {
  initialised = false;
}
if (!initialised) {
  await contract.callFunctionRaw({
    contractId: names.contract,
    methodName: "new",
    args: {
      owner: names.contract,
      referee: names.referee,
      treasury: names.contract,
      fee_bps: 200,
      min_stake_near: (NEAR / 10n).toString(),
      grace_ms: 7 * 24 * 3600 * 1000,
    },
    gas: 100_000_000_000_000n,
  });
  console.log("initialised");
}

for (const [who, amount] of [["referee", 1n], ["alice", 2n], ["bob", 2n]]) {
  if (await exists(names[who])) continue;
  await contract.createAccount({ newAccountId: names[who], publicKey: keys[who].publicKey, nearToTransfer: amount * NEAR });
  console.log(`created ${names[who]}`);
}

mkdirSync("../deployments", { recursive: true });
const out = { network: "testnet", contract: names.contract, referee: names.referee, demo_players: [names.alice, names.bob], deployed_at: new Date().toISOString() };
writeFileSync("../deployments/testnet.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
