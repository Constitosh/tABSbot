// src/refreshWorker.js
// Worker: refreshes a token snapshot and caches it for the bot.
// - Market data: Dexscreener
// - On-chain: Etherscan v2 (logs + stats.tokensupply + contract creator)
// - Queue: BullMQ

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

import {
  getAllTransferLogs,
  getTokenTotalSupply,
  getContractCreation,
  buildBalanceMapFromLogs,
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
        const cap = m?.marketCap ?? m?.fdv ?? 0;
        console.log('[WORKER] Dexscreener ok', ca, 'pair=', m?.pairAddress || null, 'cap=', cap);
        return m || null;
      })
      .catch((e) => {
        console.log('[WORKER] Dexscreener failed:', e?.message || e);
        return null;
      });

    const pairAddr = market?.pairAddress || null;
    const dexCreator = market?.moonshot?.creator || null;

    // 2) Etherscan v2: logs + supply + creator (creator: prefer Dex; fall back to Etherscan)
    let logs = [];
    let totalSupplyStr = '0';
    let creatorAddr = dexCreator || null;

    try {
      const [logsRes, supplyRes, creatorRes] = await Promise.all([
        getAllTransferLogs(ca, { maxPages: 25, pageSize: 1000 }),
        getTokenTotalSupply(ca),
        creatorAddr ? Promise.resolve(null) : getContractCreation(ca),
      ]);

      logs = logsRes || [];
      totalSupplyStr = String(supplyRes || '0');
      if (!creatorAddr) creatorAddr = creatorRes?.creatorAddress || null;

      console.log(
        '[WORKER] ESV2 ok',
        ca,
        'logs=', logs.length,
        'creator=', creatorAddr || 'unknown',
        'supply=', totalSupplyStr
      );
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e?.message || e);
    }

    // 3) Build balances + holders (exclude pair address from stats)
    let balances = new Map();
    let decimals = 18;
    let holdersSummary = {
      holdersTop20: [],
      top10CombinedPct: 0,
      burnedPct: 0,
      holdersCount: 0,
    };

    try {
      const bm = buildBalanceMapFromLogs(logs || []);
      balances = bm.balances;
      decimals = bm.decimals;

      holdersSummary = summarizeHoldersFromBalances(balances, totalSupplyStr, {
        exclude: [pairAddr],
      });
    } catch (e) {
      console.log('[WORKER] holders compute failed:', e?.message || e);
    }

    // 4) First 20 buyers status (creator first) excluding pair/burn
    let buyersList = [];
    try {
      buyersList = first20BuyersStatus({
        logs: logs || [],
        balances: balances || new Map(),
        creator: creatorAddr,
        pair: pairAddr,
      });
    } catch (e) {
      console.log('[WORKER] buyers compute failed:', e?.message || e);
    }

    // 5) Creator % (based on balances map)
    let creatorPct = 0;
    try {
      if (creatorAddr) {
        const bal = balances.get(creatorAddr.toLowerCase()) || 0n;
        const tot = BigInt(String(totalSupplyStr || '0'));
        creatorPct = tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0;
      }
    } catch (e) {
      console.log('[WORKER] creator% compute failed:', e?.message || e);
      creatorPct = 0;
    }

    // 6) Final payload (renderer-compatible)
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      market,             // dexscreener normalized object
      pairAddress: pairAddr,

      // holders / buyers
      holdersTop20: holdersSummary.holdersTop20,
      top10CombinedPct: holdersSummary.top10CombinedPct,
      burnedPct: holdersSummary.burnedPct,
      holdersCount: holdersSummary.holdersCount,
      buyersFirst20: buyersList,
      buyers: buyersList,

      // creator
      creator: { address: creatorAddr, percent: creatorPct },
      creatorAddress: creatorAddr,
      creatorPercent: creatorPct,

      decimals,
      source: ['Dexscreener', 'Etherscan'],
    };

    // 7) Cache (3 min TTL for summary, 10 min for last_refresh gate)
    const sumKey = `token:${ca}:summary`;
    const gateKey = `token:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180);
      await setJSON(gateKey, { ts: Date.now() }, 600);
      console.log('[WORKER] cached token:' + sumKey + ' ttl=180s');
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
      const ca = job.data?.tokenAddress || job.data;
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
          await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
        } catch (e) {
          console.error('[CRON] Enqueue failed for', ca, e?.message || e);
        }
      }
    }, 120_000);
  }
}
