// src/queueCore.js
import './configEnv.js';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { getContractCreator, getTokenHolders, getTokenTransfers } from './services/abscan.js';
import { summarizeHolders, buildCurrentBalanceMap, first20BuyersStatus } from './services/compute.js';

// BullMQ-safe Redis connection
export const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

export async function refreshToken(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    const mkt = await getDexscreenerTokenStats(ca);
    const holders = await getTokenHolders(ca, 1, 100);
    const creator = await getContractCreator(ca);
    const transfers = await getTokenTransfers(ca, 0, 999999999, 1, 1000);

    const holdersSummary = summarizeHolders(holders);
    const balanceMap = buildCurrentBalanceMap(holders);
    const buyers = first20BuyersStatus(transfers, balanceMap);

    let creatorPct = 0;
    if (creator?.creatorAddress) {
      const row = holders.find(
        (h) => (h.TokenHolderAddress || '').toLowerCase() === creator.creatorAddress.toLowerCase()
      );
      creatorPct = row ? Number(row.Percentage || 0) : 0;
    }

    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market: mkt,
      holdersTop20: holdersSummary.top20,
      top10CombinedPct: holdersSummary.top10Pct,
      burnedPct: holdersSummary.burnedPct,
      creator: { address: creator?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers,
    };

    await setJSON(`token:${ca}:summary`, payload, 180);
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
    return payload;
  });
}
