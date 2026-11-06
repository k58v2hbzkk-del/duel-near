#!/usr/bin/env node
// DUEL referee: settle every duel that is due.
//   node src/run.js            settle due duels once (used by the GitHub Action)
//   node src/run.js --dry      decide and print, send nothing
//   node src/run.js --watch    keep running, check every 60s
import { appendFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { view, resolveDuel } from "./near.js";
import { decide, buildVerdict, winnerAccount } from "./judge.js";
import { NearAI } from "./nearai.js";

export async function runOnce(cfg, { dry = false, log = console.log, fetchFn = fetch, send = resolveDuel, clock = Date.now } = {}) {
  if (!cfg.contractId) throw new Error("DUEL_CONTRACT not set");
  const ai = cfg.nearai.apiKey ? new NearAI({ ...cfg.nearai, fetchFn }) : null;
  const due = await view(cfg.rpcUrl, cfg.contractId, "get_ready_for_referee", { limit: 25 }, fetchFn);
  const results = [];
  log(`[referee] ${due.length} duel(s) due on ${cfg.contractId}`);
  for (const duel of due) {
    const now = clock();
    const d = await decide(duel, { now, cfg, ai, fetchFn });
    if (d.status !== "decided") {
      log(`  #${duel.id} wait — ${d.reason}`);
      results.push({ id: duel.id, status: "wait", reason: d.reason });
      continue;
    }
    const verdict = buildVerdict(duel, d, now);
    const winner = winnerAccount(duel, d.result);
    log(`  #${duel.id} ${d.result.toUpperCase()} (${winner || "refund both"}) — ${d.reason}`);
    if (dry) {
      results.push({ id: duel.id, status: "dry", verdict });
      continue;
    }
    try {
      const tx = await send(cfg, duel.id, winner, verdict);
      log(`    settled: ${cfg.explorer}/txns/${tx}`);
      results.push({ id: duel.id, status: "settled", tx, verdict });
    } catch (e) {
      log(`    FAILED: ${e.message}`);
      results.push({ id: duel.id, status: "error", error: e.message });
    }
  }
  return results;
}

function summary(cfg, results) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = results.map((r) =>
    `| ${r.id} | ${r.status} | ${r.verdict ? `${r.verdict.result} — ${r.verdict.reason}` : r.reason || r.error || ""} | ${r.tx ? `[tx](${cfg.explorer}/txns/${r.tx})` : ""} |`);
  appendFileSync(file, `## DUEL referee\n\n| duel | status | verdict | tx |\n|---|---|---|---|\n${rows.join("\n") || "| — | nothing due | | |"}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const dry = process.argv.includes("--dry");
  const watch = process.argv.includes("--watch");
  const tick = async () => {
    try {
      summary(cfg, await runOnce(cfg, { dry }));
    } catch (e) {
      console.error(`[referee] ${e.message}`);
      if (!watch) process.exitCode = 1;
    }
  };
  await tick();
  if (watch) setInterval(tick, 60_000);
}
