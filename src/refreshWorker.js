// src/refreshWorker.js
// Sources:
//  • Market: Dexscreener
//  • On-chain: Etherscan V2 (chainid=2741) — logs.getLogs, contract.getcontractcreation, stats.tokensupply
// Queue: BullMQ

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// ---------- Etherscan V2 client ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract

if (!ES_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY is missing');
console.log('[WORKER BOOT] ETHERSCAN_BASE =', ES_BASE);
console.log('[WORKER BOOT] ETHERSCAN_CHAIN_ID =', ES_CHAIN);

const http = axios.create({ baseURL: ES_BASE, timeout: 25_000 });

function esParams(params) {
  return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } };
}
function esURLString(params) {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}
async function esGET(params, { logTag, logOnceUrl = false } = {}) {
  if (logOnceUrl) console.log(`[ESV2] ${logTag || ''} ${esURLString(params)}`);
  const { data } = await http.get('', esParams(params));
  if (data?.status !== '1') {
    const msg = data?.result || data?.message || 'Unknown error';
    throw new Error(`Etherscan v2 error: ${msg}`);
  }
  return data.result;
}

// ERC-20 Transfer(address,address,uint256) keccak256 topic
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

// Pull Transfer logs (paginated)
async function getAllTransferLogs(token, { fromBlock = 0, toBlock = 'latest', pageStart = 1, maxPages = 50, offset = 1000 } = {}) {
  const all = [];
  for (let page = pageStart; page < pageStart + maxPages; page++) {
    const params = {
      module: 'logs',
      action: 'getLogs',
      address: token,
      topic0: TOPIC_TRANSFER,
      fromBlock,
      toBlock,
      page,
      offset,
    };
    const logOnce = (page === pageStart); // print first page URL
    const batch = await esGET(params, { logTag: '[logs]', logOnceUrl: logOnce });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < offset) break;
  }
  return all;
}

// Deployer (creator)
async function getContractCreator(token) {
  const params = { module: 'contract', action: 'getcontractcreation', contractaddresses: token };
  const r = await esGET(params, { logTag: '[creator]', logOnceUrl: true });
  const row = Array.isArray(r) ? r[0] : null;
  return row?.contractCreator || null;
}

// Total supply (raw units string)
async function getTokenTotalSupply(token) {
  const params = { module: 'stats', action: 'tokensupply', contractaddress: token };
  const r = await esGET(params, { logTag: '[supply]', logOnceUrl: true });
  return String(r);
}

// Build balances by replaying Transfer logs
function buildBalancesFromLogs(logs) {
  const balances = new Map(); // addr -> bigint
  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    const val  = toBig(lg.data);
    if (!DEAD.has(from)) balances.set(from, (balances.get(from) || 0n) - val);
    if (!DEAD.has(to))   balances.set(to,   (balances.get(to)   || 0n) + val);
  }
  for (const [a, v] of balances) if (v <= 0n) balances.delete(a);
  return balances;
}

// First 20 buyers (via pairAddress)
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

    // 1) Dexscreener (market + pair)
    let market = null;
    let pairAddress = null;
    try {
      const { summary } = await getDexscreenerTokenStats(ca);
      market = summary || null;
      pairAddress = summary?.pairAddress || null;
      console.log('[WORKER] Dexscreener ok', ca, 'pair=', pairAddress, 'cap=', summary?.marketCap ?? summary?.fdv ?? 0);
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan V2
    let logs = [];
    let creatorAddr = null;
    let totalSupplyRaw = '0';
    try {
      [logs, creatorAddr, totalSupplyRaw] = await Promise.all([
        getAllTransferLogs(ca, { maxPages: 50, offset: 1000 }),
        getContractCreator(ca),
        getTokenTotalSupply(ca),
      ]);
      console.log('[WORKER] ESV2 ok', ca, 'logs=', logs.length, 'creator=', creatorAddr, 'supply=', totalSupplyRaw);
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e?.message || e);
    }

    // 3) Compute
    let holdersTop20 = [];
    let holdersCount = null;
    let top10CombinedPct = 0;
    let burnedPct = 0;
    let first20Buyers = [];
    let creatorPercent = 0;

    try {
      const balances = buildBalancesFromLogs(logs);

      // burned supply (sum transfers to dead addresses)
      let burned = 0n;
      for (const lg of logs) {
        const to = topicToAddr(lg.topics[2]);
        if (DEAD.has(to)) burned += toBig(lg.data);
      }

      const supply = toBig(totalSupplyRaw || '0');
      const ranked = [...balances.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
      holdersCount = ranked.length;

      holdersTop20 = ranked.slice(0, 20).map(([address, bal]) => ({
        address,
        percent: supply > 0n ? Number((bal * 1000000n) / supply) / 10000 : 0,
      }));

      const top10Sum = ranked.slice(0, 10).reduce((a, [, v]) => a + v, 0n);
      top10CombinedPct = supply > 0n ? Number((top10Sum * 1000000n) / supply) / 10000 : 0;
      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      if (creatorAddr) {
        const bal = balances.get(String(creatorAddr).toLowerCase()) || 0n;
        creatorPercent = supply > 0n ? Number((bal * 1000000n) / supply) / 10000 : 0;
      }

      first20Buyers = first20BuyersMatrix(logs, pairAddress);
    } catch (e) {
      console.log('[WORKER] compute failed:', e?.message || e);
    }

    // 4) Final payload for your renderers
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      market, // Dexscreener block (price/volume/change/cap/socials/pairAddress)

      holdersTop20,
      top10CombinedPct,
      burnedPct,
      holdersCount,

      first20Buyers,

      creator: { address: creatorAddr, percent: creatorPercent },
    };

    // 5) Cache (3m TTL; refresh gate 10m)
    const sumKey  = `token:${ca}:summary`;
    const gateKey = `token:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180);
      await setJSON(gateKey, { ts: Date.now() }, 600);
      console.log('[WORKER] cached', sumKey, 'ttl=180s', 'elapsed', (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('[WORKER] cache write failed:', e?.message || e);
    }

    console.log('[WORKER] refreshToken done', ca);
    return payload;
  });
}

// ---------- Worker (consumer) ----------
new Worker(
  'tabs_refresh',
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

// ---------- Optional: cron refresher ----------
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
