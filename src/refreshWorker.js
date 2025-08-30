import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { getContractCreator, getTokenHolders, getTokenTransfers } from './services/abscan.js';
import { summarizeHolders, buildCurrentBalanceMap, first20BuyersStatus } from './services/compute.js';
console.log('[WORKER BOOT] ABSCAN_API=', process.env.ABSCAN_API);


const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

export async function refreshToken(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    const { summary: mkt } = await getDexscreenerTokenStats(ca);

    const { holders, holderCount } = await getTokenHolders(ca, 1, 100);
    const creator     = await getContractCreator(ca);
    const transfers   = await getTokenTransfers(ca, 0, 999999999, 1, 1000);

    // adapt to compute utils expected shape
    const holdersForCompute = holders.map(h => ({
      TokenHolderAddress: h.address,
      Percentage: h.percent,
      Balance: h.balance,
    }));

    const holdersSummary = summarizeHolders(holdersForCompute);
    const balanceMap     = buildCurrentBalanceMap(holdersForCompute);
    const buyers         = first20BuyersStatus(transfers, balanceMap);

    const creatorAddr = creator?.creatorAddress || null;
    let creatorPct = 0;
    if (creatorAddr) {
      const hit = holders.find(h => (h.address || '').toLowerCase() === creatorAddr);
      creatorPct = hit ? Number(hit.percent || 0) : 0;
    }

    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      market: mkt || null,

      holdersCount: holderCount ?? null,
      holdersTop20: holders.slice(0,20).map(h => ({ address: h.address, percent: Number(h.percent || 0) })),
      top10CombinedPct: holdersSummary.top10Pct,
      burnedPct: holdersSummary.burnedPct,

      creator: { address: creatorAddr, percent: creatorPct },

      first20Buyers: buyers,
    };

    await setJSON(`token:${ca}:summary`, payload, 180);
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
    return payload;
  });
}

new Worker(queueName, async (job) => {
  const { tokenAddress } = job.data;
  return refreshToken(tokenAddress);
}, { connection: bullRedis });

if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map(s=>s.trim()).filter(Boolean);
  setInterval(async () => {
    for (const ca of list) {
      await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    }
  }, 120_000);
}