// src/refreshWorker.js
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

const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

export async function refreshToken(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) {
    throw new Error(`Invalid contract address: ${tokenAddress}`);
  }

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    console.log(`[WORKER] refreshToken start ${ca}`);

    // 1) Dexscreener market
    let market = null;
    try {
      market = await getDexscreenerTokenStats(ca);
      console.log(`[WORKER] Dexscreener ok ${ca} mktCap=${market?.marketCap ?? 'n/a'}`);
    } catch (e) {
      console.warn('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan v2 data
    let transfers = [], creatorInfo = null, totalSupply = 0;
    try {
      const [t, c, s] = await Promise.all([
        getAllTokenTransfers(ca, { maxPages: 50 }),
        getContractCreator(ca),
        getTokenTotalSupply(ca),
      ]);
      transfers = t || [];
      creatorInfo = c || { contractAddress: ca, creatorAddress: null, txHash: null };
      totalSupply = s || 0;
      console.log(`[WORKER] ESV2 ok ${ca} transfers=${transfers.length} totalSupply=${totalSupply}`);
    } catch (e) {
      console.error('[WORKER] ESV2 failed:', e?.message || e);
    }

    // 3) Holders & buyers
    const { balances, decimals } = buildBalanceMap(transfers);
    const holdersSummary = summarizeHoldersFromBalances(balances, totalSupply, decimals);
    const buyers = first20BuyersStatus(transfers, balances);

    // 4) Creator %
    let creatorPct = 0;
    try {
      if (creatorInfo?.creatorAddress) {
        const bal = balances.get(creatorInfo.creatorAddress) || 0n;
        const tot = BigInt(String(totalSupply || '0'));
        creatorPct = tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0;
      }
    } catch (_) {}

    // 5) Payload
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market,
      holdersTop20: holdersSummary.holdersTop20,
      top10CombinedPct: holdersSummary.top10CombinedPct,
      burnedPct: holdersSummary.burnedPct,
      holdersCount: holdersSummary.holdersCount,
      creator: { address: creatorInfo?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers,
    };

    // 6) Cache
    await setJSON(`token:${ca}:summary`, payload, 180);
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
    const sanity = await getJSON(`token:${ca}:summary`);
console.log('[WORKER] cached summary key token:%s:summary present=%s name=%s',
  ca, Boolean(sanity), sanity?.market?.name || 'n/a');
    console.log(`[WORKER] refreshToken done ${ca}`);

    return payload;
  });
}

// BullMQ worker
new Worker(
  queueName,
  async (job) => {
    console.log(`[WORKER] job received:`, job.name, job.id, job.data);
    try {
      const res = await refreshToken(job.data?.tokenAddress);
      console.log(`[WORKER] job OK:`, job.id);
      return res;
    } catch (e) {
      console.error(`[WORKER] job FAIL:`, job.id, e?.message || e);
      throw e;
    }
  },
  { connection: bullRedis }
);

// Simple periodic refresher (optional)
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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