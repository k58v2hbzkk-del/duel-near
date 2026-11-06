// Football bets settled from TheSportsDB match results (free, keyless tier).
// params: { event_id, creator_pick: "home" | "away" | "draw", home?, away? }

const FINISHED = new Set(["Match Finished", "FT", "AET", "PEN", "AP", "FT_PEN", "After Extra Time"]);
const VOID = /postpon|cancel|abandon|suspend|award/i;

export function parseFootballParams(params) {
  const p = typeof params === "string" ? JSON.parse(params || "{}") : params;
  if (!p.event_id || !["home", "away", "draw"].includes(p.creator_pick)) {
    throw new Error("football params need event_id and creator_pick (home|away|draw)");
  }
  return { eventId: String(p.event_id), pick: p.creator_pick };
}

export async function fetchEvent(eventId, { key = "123", fetchFn = fetch } = {}) {
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/lookupevent.php?id=${encodeURIComponent(eventId)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`thesportsdb ${res.status}`);
  const json = await res.json();
  const ev = json?.events?.[0];
  return ev ? { ev, url } : null;
}

export async function decideFootball(duel, { now, sportsDbKey, fetchFn = fetch }) {
  const { eventId, pick } = parseFootballParams(duel.params);
  const found = await fetchEvent(eventId, { key: sportsDbKey, fetchFn });
  if (!found) return { status: "wait", reason: `match ${eventId} not found yet` };
  const { ev, url } = found;
  const name = `${ev.strHomeTeam} vs ${ev.strAwayTeam}`;
  const status = String(ev.strStatus || "");
  if (VOID.test(status) || ev.strPostponed === "yes") {
    return {
      status: "decided",
      method: "football-oracle",
      result: "draw",
      reason: `${name} was ${status || "postponed"} — stakes refunded`,
      data: { source: "thesportsdb", event_id: eventId, status, url },
    };
  }
  const hs = ev.intHomeScore, as = ev.intAwayScore;
  const hasScore = hs !== null && hs !== undefined && hs !== "" && as !== null && as !== undefined && as !== "";
  if (!hasScore || !(FINISHED.has(status) || /finish/i.test(status))) {
    return { status: "wait", reason: `${name} not finished (status: ${status || "unknown"})` };
  }
  const h = Number(hs), a = Number(as);
  const outcome = h > a ? "home" : a > h ? "away" : "draw";
  return {
    status: "decided",
    method: "football-oracle",
    result: outcome === pick ? "creator" : "opponent",
    reason: `Full time: ${ev.strHomeTeam} ${h}-${a} ${ev.strAwayTeam}. Creator picked ${pick}.`,
    data: { source: "thesportsdb", event_id: eventId, score: `${h}-${a}`, outcome, status, url },
  };
}
