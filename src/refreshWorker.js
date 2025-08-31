// src/refreshWorker.js
// Worker that refreshes a token snapshot and caches it for the bot.
// - Market data: Dexscreener
// - Holders/Buyers/Creator/Supply: Etherscan v2 (chainid=2741)
// - Queue: BullMQ

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

import {
  getAllTokenTransfers,
  getTokenTotalSupply,   // returns STRING now
  getContractCreator,
  buildBalanceMap,
  summarizeHoldersFromBalances,
  first20BuyersStatus,
} from './services/absEtherscanV2.js';

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
    console.log('[WORKER] refreshToken start', ca);

    // 1) Dexscreener market (tolerate null)
    const market = await getDexscreenerTokenStats(ca)
      .then((m) => {
        console.log('[WORKER] Dexscreener ok', ca, 'mktCap=' + (m?.marketCap ?? m?.fdv ?? 0));
        return m;
      })
      .catch((e) => {
        console.log('[WORKER] Dexscreener failed:', e?.message || e);
        return null;
      });

    // 2) Etherscan v2: transfers, creator, totalSupply (string)
    let transfers = [];
    let creatorInfo = { contractAddress: ca, creatorAddress: null, txHash: null };
    let totalSupplyStr = '0';
    try {
      [transfers, creatorInfo, totalSupplyStr] = await Promise.all([
        getAllTokenTransfers(ca, { maxPages: 50 }),
        getContractCreator(ca),
        getTokenTotalSupply(ca), // <- STRING
      ]);
      console.log('[WORKER] ESV2 ok', ca, 'transfers=' + transfers.length, 'totalSupply=' + totalSupplyStr);
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e?.message || e);
    }

    // 3) Build balances + holders
    let holdersSummary = { holdersTop20: [], top10CombinedPct: 0, burnedPct: 0, holdersCount: 0, decimals: 18 };
    let balances = new Map();
    let decimals = 18;
    try {
      const bm = buildBalanceMap(transfers);
      balances = bm.balances;
      decimals = bm.decimals;
      holdersSummary = summarizeHoldersFromBalances(balances, totalSupplyStr, decimals);
    } catch (e) {
      console.log('[WORKER] compute holders failed:', e?.message || e);
    }

    // 4) First 20 buyers status
    let buyers = [];
    try {
      buyers = first20BuyersStatus(transfers, balances);
    } catch (e) {
      console.log('[WORKER] buyers compute failed:', e?.message || e);
    }

    // 5) Creator %
    let creatorPct = 0;
    try {
      if (creatorInfo?.creatorAddress) {
        const bal = balances.get(creatorInfo.creatorAddress) || 0n;
        const tot = BigInt(String(totalSupplyStr || '0'));
        creatorPct = tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0;
      }
    } catch (e) {
      console.log('[WORKER] creator% compute failed:', e?.message || e);
      creatorPct = 0;
    }

    // 6) Final payload
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market, // dexscreener summary object or null
      holdersTop20: holdersSummary.holdersTop20,
      top10CombinedPct: holdersSummary.top10CombinedPct,
      burnedPct: holdersSummary.burnedPct,
      holdersCount: holdersSummary.holdersCount,
      creator: { address: creatorInfo?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers,
      decimals,
    };

    // 7) Cache (3 min TTL for summary, 10 min for last_refresh gate)
    const sumKey = `token:${ca}:summary`;
    const gateKey = `token:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180);
      await setJSON(gateKey, { ts: Date.now() }, 600);
      console.log('[WORKER] cached summary', sumKey, 'ttl=180');
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
    console.log('[WORKER] job received:', job.name, job.id, job.data);
    try {
      const res = await refreshToken(job.data?.tokenAddress);
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
          await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
        } catch (e) {
          console.error('[CRON] Enqueue failed for', ca, e?.message || e);
        }
      }
    }, 120_000);
  }
}