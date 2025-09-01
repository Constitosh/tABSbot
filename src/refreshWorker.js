// src/refreshWorker.js
// Worker that refreshes a token snapshot and caches it for the bot.
// - Market data: Dexscreener
// - Holders/Buyers/Creator: Abscan (Etherscan-style for Abstract)
// - Queue: BullMQ

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import {
  getTokenHolders,
  getTokenTransfers,
  getContractCreator,
} from './services/abscan.js';
import {
  summarizeHolders,
  buildCurrentBalanceMap,
  first20BuyersStatus,
} from './services/compute.js';

console.log('[WORKER BOOT] ABSCAN_API =', process.env.ABSCAN_API || 'https://abscan.org/api');
console.log('[WORKER BOOT] REDIS_URL  =', process.env.REDIS_URL ? 'set' : 'missing');

// ---------------- Redis (BullMQ connection) ----------------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ---------------- Queue ----------------
export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

// ---------------- Core refresh ----------------
export async function refreshToken(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) {
    throw new Error(`Invalid contract address: ${tokenAddress}`);
  }

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    const startTs = Date.now();
    console.log('[WORKER] refreshToken start', ca);

    // 1) Dexscreener market (tolerate null)
    let market = null;
    try {
      const { summary } = await getDexscreenerTokenStats(ca);
      market = summary || null;
      console.log(
        '[WORKER] Dexscreener ok',
        ca,
        'mktCap=',
        market?.marketCap ?? market?.fdv ?? 0
      );
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Abscan (Etherscan-style): holders, transfers, creator
    let holders = [];
    let holderCount = null;
    let transfersAsc = [];
    let creatorAddr = null;

    try {
      const holdersRes = await getTokenHolders(ca, 1, 200);
      holders = Array.isArray(holdersRes?.holders) ? holdersRes.holders : [];
      holderCount = Number(holdersRes?.holderCount ?? holders.length) || null;
      console.log('[WORKER] Holders ok', ca, 'count=', holderCount);
    } catch (e) {
      console.log('[WORKER] Holders failed:', e?.message || e);
    }

    try {
      transfersAsc = await getTokenTransfers(ca, 0, 999999999, 1, 1000);
      console.log('[WORKER] Transfers ok', ca, 'rows=', transfersAsc.length);
    } catch (e) {
      console.log('[WORKER] Transfers failed:', e?.message || e);
    }

    try {
      const creator = await getContractCreator(ca);
      creatorAddr = creator?.creatorAddress || null;
      console.log('[WORKER] Creator ok', ca, 'creator=', creatorAddr || 'unknown');
    } catch (e) {
      console.log('[WORKER] Creator failed:', e?.message || e);
    }

    // 3) Compute holders & buyers summary
    let top10CombinedPct = 0;
    let burnedPct = 0;
    let holdersTop20 = [];
    let first20Buyers = [];
    let creatorPercent = 0;

    try {
      // adapt to compute utils expected shape
      const holdersForCompute = (holders || []).map((h) => ({
        TokenHolderAddress: h.address,
        TokenHolderQuantity: h.balance, // may be 0 if API doesn't return it; still ok for status proxy
        Percentage: h.percent,
      }));

      const sums = summarizeHolders(holdersForCompute);
      top10CombinedPct = Number(sums.top10Pct || 0);
      burnedPct = Number(sums.burnedPct || 0);
      holdersTop20 = (holders || [])
        .slice(0, 20)
        .map((h) => ({ address: h.address, percent: Number(h.percent || 0) }));

      const balanceMap = buildCurrentBalanceMap(holdersForCompute);
      first20Buyers = first20BuyersStatus(transfersAsc || [], balanceMap);

      if (creatorAddr) {
        const hit = (holders || []).find(
          (h) => (h.address || '').toLowerCase() === creatorAddr
        );
        creatorPercent = hit ? Number(hit.percent || 0) : 0;
      }
    } catch (e) {
      console.log('[WORKER] Compute failed:', e?.message || e);
    }

    // 4) Final payload (renderer-compatible)
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      // Dexscreener slice (your renderers read these fields)
      market, // normalized summary or null

      // On-chain slice
      holdersCount: holderCount,
      holdersTop20,
      top10CombinedPct,
      burnedPct,

      creator: { address: creatorAddr, percent: creatorPercent },

      // buyers for renderBuyers()
      first20Buyers,
    };

    // 5) Cache (3 min TTL for summary, 10 min gate for refresh cooldown check)
    const sumKey = `token:${ca}:summary`;
    const gateKey = `token:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180);
      await setJSON(gateKey, { ts: Date.now() }, 600);
      console.log(
        '[WORKER] cached summary',
        sumKey,
        'ttl=180',
        'elapsed=',
        (Date.now() - startTs) + 'ms'
      );
    } catch (e) {
      console.log('[WORKER] cache write failed:', e?.message || e);
    }

    console.log('[WORKER] refreshToken done', ca);
    return payload;
  });
}

// ---------------- Worker (job consumer) ----------------
new Worker(
  queueName,
  async (job) => {
    const ca = job.data?.tokenAddress;
    console.log('[WORKER] job received:', job.name, job.id, ca);
    try {
      const res = await refreshToken(ca);
      console.log('[WORKER] job OK:', job.id);
      return res;
    } catch (e) {
      console.log('[WORKER] job FAIL:', job.id, e?.message || e);
      throw e;
    }
  },
  { connection: bullRedis }
);

// ---------------- Optional: simple cron refresher ----------------
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length) {
    console.log('[CRON] Refreshing tokens every 120s:', list.join(', '));
    setInterval(async () => {
      for (const ca of list) {
        try {
          await queue.add(
            'refresh',
            { tokenAddress: ca },
            { removeOnComplete: true, removeOnFail: true }
          );
        } catch (e) {
          console.error('[CRON] Enqueue failed for', ca, e?.message || e);
        }
      }
    }, 120_000);
  }
}
