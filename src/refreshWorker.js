// src/refreshWorker.js
// Worker that refreshes a token snapshot and caches it for the bot.
// Sources used:
//   • Market data: Dexscreener (your existing service)
//   • On-chain (holders/buyers/creator/supply): Etherscan v2 (chainid=2741)
// Queue: BullMQ

import './configEnv.js';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// ---------- Etherscan v2 minimal client (Abstract = chainId 2741) ----------
const ES_BASE   = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY    = process.env.ETHERSCAN_API_KEY; // REQUIRED
const ES_CHAIN  = process.env.ETHERSCAN_CHAIN_ID || '2741';

// ERC-20 Transfer(address,address,uint256) keccak256 hash
// Ref: Etherscan v2 'logs.getLogs' + standard ERC-20 Transfer signature
// Docs: https://docs.etherscan.io/etherscan-v2/api-endpoints/logs
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function esURL(params) {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k, v]) => {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  });
  return u.toString();
}

async function esGET(params) {
  if (!ES_KEY) throw new Error('Missing ETHERSCAN_API_KEY');
  const res = await fetch(esURL(params));
  const j = await res.json();
  if (j?.status !== '1') {
    const msg = j?.result || j?.message || 'Unknown error';
    throw new Error(`Etherscan v2 error: ${msg}`);
  }
  return j.result;
}

// Logs (paginated)
async function getTransferLogsAll(token, { fromBlock = 0, toBlock = 'latest', pageStart = 1, maxPages = 50, offset = 1000 } = {}) {
  const all = [];
  for (let page = pageStart; page < pageStart + maxPages; page++) {
    const batch = await esGET({
      module: 'logs',
      action: 'getLogs',
      address: token,
      topic0: TOPIC_TRANSFER,
      fromBlock,
      toBlock,
      page,
      offset,
    }); // Etherscan v2 logs.getLogs. Ref docs.   [oai_citation:2‡docs.etherscan.io](https://docs.etherscan.io/etherscan-v2/api-endpoints/logs?utm_source=chatgpt.com)
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < offset) break; // no more pages
  }
  return all;
}

// Creator (deployer)
async function getContractCreator(token) {
  // Etherscan v2 contracts.getcontractcreation. Ref docs.   [oai_citation:3‡docs.etherscan.io](https://docs.etherscan.io/etherscan-v2/api-endpoints/contracts?utm_source=chatgpt.com)
  const r = await esGET({ module: 'contract', action: 'getcontractcreation', address: token });
  const row = Array.isArray(r) ? r[0] : null;
  return row?.contractCreator || null;
}

// Total supply (raw units string)
async function getTokenTotalSupply(token) {
  // v2 stats.tokensupply supports contractaddress + chainid.   [oai_citation:4‡docs.etherscan.io](https://docs.etherscan.io/etherscan-v2/v2-quickstart?utm_source=chatgpt.com)
  const r = await esGET({ module: 'stats', action: 'tokensupply', contractaddress: token });
  // returns a numeric string (raw units)
  return String(r);
}

// ---------- math helpers ----------
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();

// Build live balances by replaying Transfer logs
function buildBalancesFromLogs(logs) {
  const balances = new Map(); // addr -> bigint
  for (const lg of logs) {
    // topics: [0]=sig, [1]=from, [2]=to ; data = value (uint256)
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    const val  = toBig(lg.data);

    if (!DEAD.has(from)) balances.set(from, (balances.get(from) || 0n) - val);
    if (!DEAD.has(to))   balances.set(to,   (balances.get(to)   || 0n) + val);
  }
  // prune non-positives
  for (const [a, v] of balances) if (v <= 0n) balances.delete(a);
  return balances;
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0n); }

// ---------- buyers classifier (first 20 unique buyers via pairAddress) ----------
function first20BuyersMatrix(logs, pairAddress) {
  if (!pairAddress) return [];
  const pair = String(pairAddress).toLowerCase();
  const buyers = new Map(); // addr -> { firstBuy, buys, sells }

  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    const val  = toBig(lg.data);

    if (from === pair) {
      if (!buyers.has(to)) buyers.set(to, { firstBuy: val, buys: 0n, sells: 0n });
      const rec = buyers.get(to);
      rec.buys += val;
      if (buyers.size >= 20) break;
    } else if (to === pair) {
      if (!buyers.has(from)) continue;
      buyers.get(from).sells += val;
    }
  }

  const rows = [];
  for (const [addr, { firstBuy, buys, sells }] of buyers) {
    let status = 'hold';
    if (sells === 0n && buys > firstBuy) status = 'bought more';
    else if (sells > 0n && sells < buys) status = 'sold some';
    else if (sells >= buys) status = 'sold all';
    rows.push({ address: addr, status });
  }
  return rows.slice(0, 20);
}

// ---------- Redis / BullMQ ----------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

// ---------- Main refresh ----------
export async function refreshToken(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  const lockKey = `lock:refresh:${ca}`;
  return withLock(lockKey, 60, async () => {
    const t0 = Date.now();
    console.log('[WORKER] refreshToken start', ca);

    // 1) Dexscreener (market + pair used for buyers)
    let market = null;
    let pairAddress = null;
    try {
      const { summary } = await getDexscreenerTokenStats(ca);
      market = summary || null;
      pairAddress = summary?.pairAddress || null;
      console.log('[WORKER] Dexscreener ok', ca, 'pair=', pairAddress, 'mcap=', summary?.marketCap ?? summary?.fdv ?? 0);
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan v2 pulls
    let logs = [];
    let creatorAddr = null;
    let totalSupplyRaw = '0';
    try {
      [logs, creatorAddr, totalSupplyRaw] = await Promise.all([
        getTransferLogsAll(ca, { maxPages: 50, offset: 1000 }),
        getContractCreator(ca),
        getTokenTotalSupply(ca),
      ]);
      console.log('[WORKER] Etherscan v2 ok', ca, 'logs=', logs.length, 'creator=', creatorAddr, 'supply=', totalSupplyRaw);
    } catch (e) {
      console.log('[WORKER] Etherscan v2 failed:', e?.message || e);
    }

    // 3) Compute holders / burned / creator / buyers
    let holdersTop20 = [];
    let holdersCount = null;
    let top10CombinedPct = 0;
    let burnedPct = 0;
    let first20Buyers = [];
    let creatorPercent = 0;

    try {
      const balances = buildBalancesFromLogs(logs);

      // burned supply = sum of amounts where to is dead
      let burned = 0n;
      for (const lg of logs) {
        const to = topicToAddr(lg.topics[2]);
        if (DEAD.has(to)) burned += toBig(lg.data);
      }

      const supply = toBig(totalSupplyRaw || '0'); // raw units
      // rank holders (exclude dead by construction)
      const ranked = [...balances.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
      holdersCount = ranked.length;

      // Top-20 list with percents (vs total supply)
      holdersTop20 = ranked.slice(0, 20).map(([address, bal]) => ({
        address,
        percent: supply > 0n ? Number((bal * 1000000n) / supply) / 10000 : 0, // 2dp
      }));

      const top10Sum = ranked.slice(0, 10).reduce((a, [, v]) => a + v, 0n);
      top10CombinedPct = supply > 0n ? Number((top10Sum * 1000000n) / supply) / 10000 : 0;

      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      // creator %
      if (creatorAddr) {
        const bal = balances.get(String(creatorAddr).toLowerCase()) || 0n;
        creatorPercent = supply > 0n ? Number((bal * 1000000n) / supply) / 10000 : 0;
      }

      // buyers matrix (needs the pairAddress from Dexscreener)
      first20Buyers = first20BuyersMatrix(logs, pairAddress);

    } catch (e) {
      console.log('[WORKER] compute failed:', e?.message || e);
    }

    // 4) Final payload for your renderers.js
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      market, // Dexscreener block: price, volume, change, cap, socials, pairAddress, etc.

      holdersTop20,
      top10CombinedPct,
      burnedPct,
      holdersCount,

      first20Buyers,

      creator: { address: creatorAddr, percent: creatorPercent },
    };

    // 5) Cache
    const sumKey = `token:${ca}:summary`;
    const gateKey = `token:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180);           // 3 minutes
      await setJSON(gateKey, { ts: Date.now() }, 600); // 10 minutes gate for cooldown checks
      console.log('[WORKER] cached', sumKey, 'ttl=180ms', 'elapsed', (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('[WORKER] cache write failed:', e?.message || e);
    }

    console.log('[WORKER] refreshToken done', ca);
    return payload;
  });
}

// ---------- Worker (bullmq consumer) ----------
new Worker(
  queueName,
  async (job) => {
    const ca = job.data?.tokenAddress;
    console.log('[WORKER] job received:', job.name, job.id, ca);
    try {
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

// ---------- Optional cron refresher ----------
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