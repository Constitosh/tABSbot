// src/refreshWorker.js
import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// Etherscan-free helpers
import {
  getTokenTransfers as esTransfers,
  getTokenTotalSupply as esSupply,
  getContractCreator as esCreator,
  getTokenBalance as esBalance,
  computeFirst20BuyersStatus,
  statusFromBalance
} from './services/etherscanFree.js';

// If you still have Abscan code, we’ll only use it when ABSCAN_API is set and you want it
const USE_ABSCAN = false; // ← force Etherscan-only mode for now

const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

export async function refreshToken(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) throw new Error('Invalid CA');

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    // 1) Market (dexscreener)
    const mkt = await getDexscreenerTokenStats(ca);

    // 2) Etherscan-only path
    const [transfers, totalSupply, creatorInfo] = await Promise.all([
      esTransfers(ca, 0, 999999999, 1, 1000),   // ascending, up to 1000 txs
      esSupply(ca),
      esCreator(ca)
    ]);

    // 3) First 20 buyers + status (we will fetch balances)
    const { buyers, seeds } = computeFirst20BuyersStatus(transfers);
    const buyersStatuses = [];
    for (const addr of buyers) {
      const seed = seeds.get(addr);
      const currBal = await esBalance(ca, addr);
      const status = statusFromBalance(seed.amountRaw, seed.decimals, String(currBal));
      buyersStatuses.push({ address: addr, status });
    }

    // 4) Creator % (we can get creator’s current balance)
    let creatorPct = 0;
    const creatorAddr = creatorInfo?.creatorAddress || null;
    if (creatorAddr && totalSupply > 0) {
      const creatorBal = await esBalance(ca, creatorAddr);
      creatorPct = (Number(creatorBal) / Number(totalSupply)) * 100;
    }

    // 5) We cannot get top holders / holdersCount on free API → mark as unavailable
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market: mkt,                         // from Dexscreener
      holdersTop20: [],                    // not available on free API
      holdersCount: null,                  // not available on free API
      top10CombinedPct: null,              // not available on free API
      burnedPct: null,                     // not available on free API
      creator: { address: creatorAddr, percent: creatorPct },
      first20Buyers: buyersStatuses
    };

    await setJSON(`token:${ca}:summary`, payload, 180);
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
    return payload;
  });
}

new Worker(queueName, async job => {
  const { tokenAddress } = job.data;
  return refreshToken(tokenAddress);
}, { connection: bullRedis });

// optional cron based on DEFAULT_TOKENS…
