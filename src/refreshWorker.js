// refreshWorker.js
import { Worker, Queue } from 'bullmq';
import { setJSON, withLock, redisClient } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { getContractCreator, getTokenHolders, getTokenTransfers } from './services/abscan.js';
import { summarizeHolders, buildCurrentBalanceMap, first20BuyersStatus } from './services/compute.js';
import Redis from 'ioredis';
import 'dotenv/config';

const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

new Worker(queueName, async (job) => {

async function refreshToken(tokenAddress) {
  const lockKey = `lock:refresh:${tokenAddress.toLowerCase()}`;
  return withLock(lockKey, 60, async () => {
    const mkt = await getDexscreenerTokenStats(tokenAddress);

    const holders = await getTokenHolders(tokenAddress, 1, 100);
    const creator = await getContractCreator(tokenAddress);
    const transfers = await getTokenTransfers(tokenAddress, 0, 999999999, 1, 1000);

    const holdersSummary = summarizeHolders(holders);
    const balanceMap = buildCurrentBalanceMap(holders);
    const buyers = first20BuyersStatus(transfers, balanceMap);

    let creatorPct = 0;
    if (creator?.creatorAddress) {
      const row = holders.find(h => (h.TokenHolderAddress || '').toLowerCase() === creator.creatorAddress.toLowerCase());
      creatorPct = row ? Number(row.Percentage || 0) : 0;
    }

    const payload = {
      tokenAddress,
      updatedAt: Date.now(),
      market: mkt,
      holdersTop20: holdersSummary.top20,
      top10CombinedPct: holdersSummary.top10Pct,
      burnedPct: holdersSummary.burnedPct,
      creator: { address: creator?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers
    };

    await setJSON(`token:${tokenAddress.toLowerCase()}:summary`, payload, 180);
    await setJSON(`token:${tokenAddress.toLowerCase()}:last_refresh`, { ts: Date.now() }, 600);
    return payload;
  });
}

// Worker (use same client)
new Worker(queueName, async job => {
  const { tokenAddress } = job.data;
  return refreshToken(tokenAddress);
}, { connection: redisClient });

// optional cron block unchanged...
export { refreshToken };
}, { connection: bullRedis });
