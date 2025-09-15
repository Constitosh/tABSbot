const Queue = require('bullmq').Queue; // Assume imported
const { Worker } = require('bullmq');
const cache = require('./cache');
const { getDexscreenerTokenStats } = require('./services/dexscreener');
const { getContractCreator, getTokenHolders, getTokenTransfers } = require('./services/explorer');
const { 
  summarizeHolders, 
  buildCurrentBalanceMap, 
  first20BuyersStatus, 
  renderTop20Holders, 
  renderFirst20Buyers 
} = require('./services/compute');
const chains = require('../../chains');

// Assume Redis connection: const redis = ...;
const queue = new Queue('refresh', { connection: redis });
const worker = new Worker('refresh', async (job) => {
  const { tokenAddress, chain } = job.data;
  await refreshToken(tokenAddress, chain);
}, { connection: redis });

async function refreshToken(tokenAddress, chain = 'abstract') {
  const market = await getDexscreenerTokenStats(tokenAddress, chain);
  if (!market) throw new Error('No market data on this chain');

  const creatorInfo = await getContractCreator(tokenAddress, chain);
  const holders = await getTokenHolders(tokenAddress, chain, 1, 100); // Top 100 for creator
  const { top20, top10CombinedPct, burnedPct } = summarizeHolders(holders);
  const creatorHolder = holders.find(h => h.address === creatorInfo.address.toLowerCase()) || { percent: 0 };
  const transfers = await getTokenTransfers(tokenAddress, chain);
  const currentBalancesMap = buildCurrentBalanceMap(holders);
  const first20Buyers = first20BuyersStatus(transfers, currentBalancesMap, tokenAddress);

  const payload = {
    tokenAddress,
    chain,
    updatedAt: Date.now(),
    market,
    holdersTop20: top20,
    top10CombinedPct,
    burnedPct,
    creator: { address: creatorInfo.address, percent: creatorHolder.percent },
    first20Buyers
  };

  const key = `token:${chain}:${tokenAddress}:summary`;
  await cache.setJSON(key, payload, 180); // 180s TTL
  return payload;
}

// Scheduler (run every 120s for defaults)
if (process.env.CRON === 'true') {
  const defaults = (process.env.DEFAULT_TOKENS || '').split(',').map(s => {
    const parts = s.trim().split(':');
    return { chain: parts[0] || 'abstract', tokenAddress: parts[1] };
  }).filter(d => d.tokenAddress && chains[d.chain]);

  setInterval(async () => {
    for (let d of defaults) {
      await queue.add('refresh', d, { removeOnComplete: 1 });
    }
  }, 120000);
}

module.exports = { refreshToken, queue };
