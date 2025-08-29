import { Worker, Queue } from 'bullmq';
import { setJSON, withLock, redisClient } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { getContractCreator, getTokenHolders, getTokenTransfers } from './services/abscan.js';
import { summarizeHolders, buildCurrentBalanceMap, first20BuyersStatus } from './services/compute.js';
import 'dotenv/config';

export const queueName = 'tabs:refresh';
export const queue = new Queue(queueName, { connection: redisClient.options });

async function refreshToken(tokenAddress) {
  const lockKey = `lock:refresh:${tokenAddress}`;
  return withLock(lockKey, 60, async () => {
    // 1) Dexscreener market stats
    const mkt = await getDexscreenerTokenStats(tokenAddress);

    // 2) Holders (top 100 for good coverage)
    const holders = await getTokenHolders(tokenAddress, 1, 100);

    // 3) Creator (deployer)
    const creator = await getContractCreator(tokenAddress);

    // 4) Transfers for first-buyer computation (first ~1000)
    const transfers = await getTokenTransfers(tokenAddress, 0, 999999999, 1, 1000);

    // --- Compute summaries ---
    const holdersSummary = summarizeHolders(holders);
    const balanceMap = buildCurrentBalanceMap(holders);
    const buyers = first20BuyersStatus(transfers, balanceMap);

    // Compute creator % if present in holder list
    let creatorPct = 0;
    if (creator?.creatorAddress) {
      const row = holders.find(h => h.TokenHolderAddress?.toLowerCase() === creator.creatorAddress.toLowerCase());
      creatorPct = row ? Number(row.Percentage || 0) : 0;
    }

    const payload = {
      tokenAddress,
      updatedAt: Date.now(),
      market: mkt,                  // { name, symbol, priceUsd, volume24h, priceChange:{h1,h6,h24}, marketCap }
      holdersTop20: holdersSummary.top20,
      top10CombinedPct: holdersSummary.top10Pct,
      burnedPct: holdersSummary.burnedPct,
      creator: { address: creator?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers
    };

    await setJSON(`token:${tokenAddress}:summary`, payload, 180); // TTL 3 min
    await setJSON(`token:${tokenAddress}:last_refresh`, { ts: Date.now() }, 600);
    return payload;
  });
}

// BullMQ consumer
new Worker(queueName, async job => {
  const { tokenAddress } = job.data;
  return refreshToken(tokenAddress);
}, { connection: redisClient.options });

// Optional: simple scheduler loop (every 120s) – enqueue known tokens
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map(s=>s.trim()).filter(Boolean);
  setInterval(async () => {
    for (const ca of list) {
      await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    }
  }, 120_000);
}

export { refreshToken };
