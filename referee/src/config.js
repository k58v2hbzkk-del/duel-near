// Runtime configuration for the DUEL referee. Everything comes from env vars
// so the same code runs locally, in GitHub Actions, or inside a TEE.

const NETWORKS = {
  testnet: { rpc: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io" },
  mainnet: { rpc: "https://rpc.mainnet.near.org", explorer: "https://nearblocks.io" },
};

export function loadConfig(env = process.env) {
  const network = env.NEAR_NETWORK || "testnet";
  const net = NETWORKS[network] || NETWORKS.testnet;
  return {
    network,
    rpcUrl: env.NEAR_RPC_URL || net.rpc,
    explorer: net.explorer,
    contractId: env.DUEL_CONTRACT || "",
    refereeId: env.REFEREE_ACCOUNT || "",
    refereeKey: env.REFEREE_PRIVATE_KEY || "",
    nearai: {
      apiKey: env.NEARAI_API_KEY || "",
      baseUrl: env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1",
      model: env.NEARAI_MODEL || "zai-org/GLM-5.1-FP8",
      visionModel: env.NEARAI_VISION_MODEL || "",
    },
    sportsDbKey: env.THESPORTSDB_KEY || "123",
    // How long players get to report a game / real-life result after the
    // resolve time before the AI judges with whatever evidence exists.
    claimWindowMs: Number(env.CLAIM_WINDOW_MINS || 24 * 60) * 60_000,
    // AI must be at least this sure, otherwise the duel is a draw (refund).
    minConfidence: Number(env.MIN_CONFIDENCE || 0.8),
  };
}
