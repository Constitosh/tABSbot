// src/refreshWorker.js
import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

import {
  getAllTokenTransfers,
  buildBalanceMap,
  summarizeHoldersFromBalances,
  first20BuyersStatus
} from './services/absEtherscanV2.js';

import {
  getTokenTransfers,
  getTokenTotalSupply,
  getContractCreator,
  getTokenBalance,
  computeFirst20BuyersSeed,
  statusFromBalance
} from './services/abscanFree.js';


const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

export async function refreshToken(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) throw new Error('Invalid CA');

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    // 1) Market
    const mkt = await getDexscreenerTokenStats(ca);

    // 2) All transfers (Abstract via Etherscan v2 chainid=2741)
    const transfers = await getAllTokenTransfers(ca);

    // 3) Balance map -> holders/top10/burned
    const { balances, decimals } = buildBalanceMap(transfers);

    // Dexscreener often returns FDV; we don't know exact totalSupply on-chain from v2 free.
    // We can estimate "supply" from largest mint (sum of incoming from ZERO) OR
    // better: use Dexscreener marketCap / priceUsd if present to back-solve supply.
    let estSupply = 0n;
    if (Number(mkt?.priceUsd) > 0 && Number(mkt?.marketCap) > 0) {
      const supply = Math.round(Number(mkt.marketCap) / Number(mkt.priceUsd));
      estSupply = BigInt(supply) * (10n ** BigInt(decimals));
    } else {
      // fallback: infer from sum of positive balances
      let sumRaw = 0n;
      for (const v of balances.values()) if (v > 0n) sumRaw += v;
      estSupply = sumRaw;
    }

    const holdersSummary = summarizeHoldersFromBalances(balances, estSupply, decimals);

    // 4) First 20 buyers + status
    const buyers = first20BuyersStatus(transfers, balances);

    // 5) Creator address (from Abscan free)
    const creator = await getContractCreator(ca);
    let creatorPct = 0;
    if (creator?.creatorAddress && estSupply > 0n) {
      const currRaw = balances.get(creator.creatorAddress.toLowerCase()) || 0n;
      creatorPct = Number((currRaw * 1000000n) / estSupply) / 10000;
    }

    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market: mkt,
      holdersTop20: holdersSummary.holdersTop20,
      holdersCount: holdersSummary.holdersCount,
      top10CombinedPct: holdersSummary.top10CombinedPct,
      burnedPct: holdersSummary.burnedPct,
      creator: { address: creator?.creatorAddress || null, percent: creatorPct },
      first20Buyers: buyers
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
