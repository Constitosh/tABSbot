// src/refreshWorker.js
// Entry for the refresh worker (BullMQ). Safe for ESM.

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, withLock } from './cache.js';
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
    // 1) Market (Dexscreener) — use ONLY the tokens endpoint; Abstract-only inside
    //    The new function returns: { summary, bestPair, pairsRaw, selection }
    const { summary: mkt } = await getDexscreenerTokenStats(ca);
    // mkt contains:
    // name, symbol, priceUsd, volume{m5,h1,h6,h24}, priceChange{m5,h1,h6,h24},
    // marketCap, fdv, marketCapSource, imageUrl/header/openGraph,
    // socials{twitter,telegram,website,others[]}, moonshot{present,progress,creator,...},
    // txns, liquidity, url, pairAddress, dexId, chainId, pairCreatedAt, pairRaw

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
    let creatorAddr = creator?.creatorAddress || null;
    if (creatorAddr) {
      const row = holders.find(
        (h) => (h.TokenHolderAddress || '').toLowerCase() === creatorAddr.toLowerCase()
      );
      creatorPct = row ? Number(row.Percentage || 0) : 0;
    }

    // 5) Final payload we cache for the bot
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      // Market block (already normalized, includes socials/image/moonshot)
      market: mkt || null,

      // Ownership summary
      holdersTop20: holdersSummary.top20,
      top10CombinedPct: holdersSummary.top10Pct,
      burnedPct: holdersSummary.burnedPct,

      // Creator
      creator: { address: creatorAddr, percent: creatorPct },

      // First 20 buyers (status)
      first20Buyers: buyers,
    };

    // 6) Cache (Redis)
    await setJSON(`token:${ca}:summary`, payload, 180); // 3 min TTL for the whole snapshot
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
// - The bot renderers can keep using data.market.*
// - data.market now also has .imageUrl, .socials{twitter,telegram,website}, and .moonshot{present,progress,creator,...}
//   if you want to surface those in the Overview UI (e.g., link buttons), they’re there.
