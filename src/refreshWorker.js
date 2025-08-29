// src/refreshWorker.js
// Entry for the refresh worker (BullMQ). Safe for ESM.
// - Requires: "type":"module" in package.json
// - Loads env from ./configEnv.js (make sure .env is in project root)

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, withLock, redisClient } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { getContractCreator, getTokenHolders, getTokenTransfers } from './services/abscan.js';
import {
  summarizeHolders,
  buildCurrentBalanceMap,
  first20BuyersStatus,
} from './services/compute.js';

// -------- BullMQ Redis (must disable retries & ready check) --------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// -------- Queue name (no colons allowed) --------
export const queueName = 'tabs_refresh';

// Expose the queue so other modules (bot) can enqueue manual refreshes.
export const queue = new Queue(queueName, { connection: bullRedis });

// -------- Core refresh logic --------
export async function refreshToken(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) {
    throw new Error(`Invalid contract address: ${tokenAddress}`);
  }

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    // 1) Market (Dexscreener)
    const mkt = await getDexscreenerTokenStats(ca); // may return null if no pair yet

    // 2) Holders (top 100), Creator, Transfers (ascending)
    const holders = await getTokenHolders(ca, 1, 100); // Etherscan-style
    const creator = await getContractCreator(ca);
    const transfers = await getTokenTransfers(ca, 0, 999999999, 1, 1000);

    // 3) Compute summaries
    const holdersSummary = summarizeHolders(holders);
    const balanceMap = buildCurrentBalanceMap(holders);
    const buyers = first20BuyersStatus(transfers, balanceMap);

    // 4) Creator % (if present in holder list)
    let creatorPct = 0;
    if (creator?.creatorAddress) {
      const row = holders.find(
        (h) => (h.TokenHolderAddress || '').toLowerCase() === creator.creatorAddress.toLowerCase()
      );
      creatorPct = row ? Number(row.Percentage || 0) : 0;
    }

    // 5) Final payload
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market: mkt, // { name, symbol, priceUsd, volume24h, priceChange:{h1,h6,h24}, marketCap } or null
      holdersTop20: holdersSummary.top20,
      top10CombinedPct: holdersSummary.top10Pct,
      burnedPct: holdersSummary.burnedPct,
      creator: { address: creator?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers,
    };

    // 6) Cache (Redis via app client)
    await setJSON(`token:${ca}:summary`, payload, 180); // 3 min TTL
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);

    return payload;
  });
}

// -------- Worker (consumes jobs) --------
new Worker(
  queueName,
  async (job) => {
    const { tokenAddress } = job.data;
    return refreshToken(tokenAddress);
  },
  { connection: bullRedis }
);

// -------- Optional: lightweight cron to refresh default tokens every 120s --------
// Usage: npm run worker -- --cron   (and set DEFAULT_TOKENS=0xabc...,0xdef... in .env)
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map((s) => s.trim()).filter(Boolean);
  setInterval(async () => {
    for (const ca of list) {
      await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    }
  }, 120_000);
}

// NOTE:
// - BullMQ uses `bullRedis`; your app cache/setJSON/withLock continue to use `redisClient` from cache.js.
// - Make sure .env has REDIS_URL set, and ./configEnv.js loads it before any Redis client is created.
