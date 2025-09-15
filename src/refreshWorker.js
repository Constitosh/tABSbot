import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import * as cache from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { getContractCreator, getTokenHolders, getTokenTransfers } from './services/explorer.js';
import { 
  summarizeHolders, 
  buildCurrentBalanceMap, 
  first20BuyersStatus 
} from './services/compute.js';
import chains from '../chains.js';

// Validate env
if (!process.env.REDIS_URL) {
  console.error('Missing REDIS_URL in .env');
  process.exit(1);
}

// Explicit Redis config
const redisOptions = {
  host: '127.0.0.1',
  port: 6379,
  password: process.env.REDIS_URL.match(/:([^@]+)@/)?.[1] || undefined,
  db: 0
};

const redis = new Redis(redisOptions);
redis.on('connect', () => console.log('Worker: Redis connected'));
redis.on('error', (err) => console.error('Worker: Redis error:', err.message));

const queue = new Queue('refresh', { connection: redis });
const worker = new Worker('refresh', async (job) => {
  const { tokenAddress, chain } = job.data;
  await refreshToken(tokenAddress, chain);
}, { connection: redis });

async function refreshToken(tokenAddress, chain = 'ethereum') {
  const config = chains[chain];
  if (!config) throw new Error(`Unsupported chain for Etherscan V2: ${chain}`);

  const market = await getDexscreenerTokenStats(tokenAddress, chain);
  if (!market) throw new Error('No market data on this chain');

  const creatorInfo = await getContractCreator(tokenAddress, chain);
  const holders = await getTokenHolders(tokenAddress, chain, 1, 100);
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
  await cache.setJSON(key, payload, 180);
  return payload;
}

if (process.env.CRON === 'true') {
  const defaults = (process.env.DEFAULT_TOKENS || '').split(',').map(s => {
    const parts = s.trim().split(':');
    return { chain: parts[0] || 'ethereum', tokenAddress: parts[1] };
  }).filter(d => d.tokenAddress && chains[d.chain]);

  setInterval(async () => {
    for (let d of defaults) {
      await queue.add('refresh', d, { removeOnComplete: 1 });
    }
  }, 120000);
}

console.log('Worker started');