// src/refreshWorker.js
// Worker that refreshes a token snapshot and caches it for the bot.
// - Market data: Dexscreener
// - Holders/Buyers/Creator/Supply: Etherscan v2 (chainid=2741)
// - Queue: BullMQ
//
// ENV required:
//   REDIS_URL=redis://:password@127.0.0.1:6379/0
//   ETHERSCAN_V2_BASE=https://api.etherscan.io/v2/api
//   ETHERSCAN_API_KEY=YOUR_KEY
//
// Optional:
//   DEFAULT_TOKENS=0xabc...,0xdef...   # used with "--cron" to refresh periodically

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

import {
  getAllTokenTransfers,
  getTokenTotalSupply,
  getContractCreator,
  buildBalanceMap,
  summarizeHoldersFromBalances,
  first20BuyersStatus,
} from './services/absEtherscanV2.js';

// ---------------- Redis (BullMQ connection) ----------------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ requirement
  enableReadyCheck: false,
});

// ---------------- Queue ----------------
export const queueName = 'tabs_refresh'; // NOTE: no colon allowed
export const queue = new Queue(queueName, { connection: bullRedis });

// ---------------- Core refresh ----------------
export async function refreshToken(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(ca)) {
    throw new Error(`Invalid contract address: ${tokenAddress}`);
  }

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    // 1) Dexscreener market (tolerate null)
    const market = await getDexscreenerTokenStats(ca).catch(() => null);

    // 2) Etherscan v2: transfers (ascending), creator, total supply
    const [transfers, creatorInfo, totalSupply] = await Promise.all([
      getAllTokenTransfers(ca, { maxPages: 50 }).catch(() => []),
      getContractCreator(ca).catch(() => ({ contractAddress: ca, creatorAddress: null, txHash: null })),
      getTokenTotalSupply(ca).catch(() => 0),
    ]);

    // 3) Build balance map from transfers and compute holders summary
    const { balances, decimals } = buildBalanceMap(transfers);
    const holdersSummary = summarizeHoldersFromBalances(balances, totalSupply, decimals);

    // 4) First 20 buyers status (skip first 2 receivers heuristic)
    const buyers = first20BuyersStatus(transfers, balances);

    // 5) Creator % (from computed balances vs total supply)
    let creatorPct = 0;
    if (creatorInfo?.creatorAddress) {
      try {
        const bal = balances.get(creatorInfo.creatorAddress) || 0n;
        const tot = BigInt(String(totalSupply || '0'));
        creatorPct = tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0; // 4 dp
      } catch {
        creatorPct = 0;
      }
    }

    // 6) Final payload
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market, // { name, symbol, priceUsd, volume{m5,h1,h6,h24}, priceChange{m5,h1,h6,h24}, marketCap, marketCapSource, socials, ... } or null
      holdersTop20: holdersSummary.holdersTop20,     // [{ address, percent }]
      top10CombinedPct: holdersSummary.top10CombinedPct,
      burnedPct: holdersSummary.burnedPct,
      holdersCount: holdersSummary.holdersCount,
      creator: { address: creatorInfo?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers,                         // [{ address, status }]
    };

    // 7) Cache (3 min TTL for summary, 10 min for last_refresh gate)
    await setJSON(`token:${ca}:summary`, payload, 180);
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);

    return payload;
  });
}

// ---------------- Worker (job consumer) ----------------
new Worker(
  queueName,
  async (job) => {
    const { tokenAddress } = job.data || {};
    return refreshToken(tokenAddress);
  },
  { connection: bullRedis }
);

// ---------------- Optional: simple cron refresher ----------------
// Use: pm2 start ... -- "--cron"
// and set DEFAULT_TOKENS in .env (comma-separated CAs).
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
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