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
// ---------- BullMQ Redis ----------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ---------- Queue ----------
export const queueName = 'tabs_refresh'; // no colon
export const queue = new Queue(queueName, { connection: bullRedis });

// ---------- Core refresh ----------
export async function refreshToken(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    // 1) Dexscreener market
    const market = await getDexscreenerTokenStats(ca).catch(() => null);

    // 2) Etherscan V2 data
    const [transfers, creatorInfo, totalSupply] = await Promise.all([
      getAllTokenTransfers(ca, { maxPages: 50 }).catch(() => []),
      getContractCreator(ca).catch(() => ({ contractAddress: ca, creatorAddress: null, txHash: null })),
      getTokenTotalSupply(ca).catch(() => 0),
    ]);

    // 3) Build balances & summaries
    const { balances, decimals } = buildBalanceMap(transfers);
    const holdersSummary = summarizeHoldersFromBalances(balances, totalSupply, decimals);

    // 4) First 20 buyers status
    const buyers = first20BuyersStatus(transfers, balances);

    // 5) Creator %
    let creatorPct = 0;
    if (creatorInfo?.creatorAddress) {
      try {
        const bal = balances.get(creatorInfo.creatorAddress) || 0n;
        const tot = BigInt(String(totalSupply || '0'));
        creatorPct = tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0;
      } catch {}
    }

    // 6) Final payload to cache
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

    await setJSON(`token:${ca}:summary`, payload, 180); // 3 min
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600); // 10 min gate

    return payload;
  });
}

// ---------- Worker consumer ----------
new Worker(
  queueName,
  async (job) => {
    const { tokenAddress } = job.data || {};
    return refreshToken(tokenAddress);
  },
  { connection: bullRedis }
);

// ---------- Optional cron ----------
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) {
    console.log('[CRON] Refresh tokens every 120s:', list.join(', '));
    setInterval(async () => {
      for (const ca of list) {
        try {
          await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
        } catch (e) {
          console.error('[CRON] enqueue failed', ca, e?.message || e);
        }
      }
    }, 120_000);
  }
}
