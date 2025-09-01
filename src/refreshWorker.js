// src/refreshWorker.js
// Sources:
//  • Dexscreener tokens API (market + pair + socials + image + creator)
//  • Etherscan V2 (chainid=2741): logs.getLogs, stats.tokensupply, account.tokenbalance
// Queue: BullMQ

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';

// ---------- Dexscreener helpers ----------
async function getDexTokenSnapshot(ca) {
  const url = `https://api.dexscreener.com/tokens/v1/abstract/${ca}`;
  const { data } = await axios.get(url, { timeout: 15_000 });
  // API returns an array with one pair object
  if (!Array.isArray(data) || !data.length) return null;
  const p = data[0];

  // normalize socials into simple strings your renderer already expects
  const socials = {};
  if (Array.isArray(p.info?.socials)) {
    for (const s of p.info.socials) {
      if (s.type === 'twitter' && !socials.twitter) socials.twitter = s.url;
      if (s.type === 'telegram' && !socials.telegram) socials.telegram = s.url;
    }
  }
  if (Array.isArray(p.info?.websites) && p.info.websites[0]?.url) {
    socials.website = p.info.websites[0].url;
  }

  // market cap fallback logic
  const marketCap = (typeof p.marketCap === 'number' && p.marketCap > 0) ? p.marketCap
                  : (typeof p.fdv === 'number' && p.fdv > 0) ? p.fdv
                  : null;
  const marketCapSource = (marketCap && marketCap === p.fdv && p.marketCap !== p.fdv) ? 'fdv' : 'marketcap';

  // ensure priceChange has an m5 field (dexscreener doesn’t provide it)
  const priceChange = { m5: 0, h1: p.priceChange?.h1 ?? 0, h6: p.priceChange?.h6 ?? 0, h24: p.priceChange?.h24 ?? 0 };

  return {
    // fields your renderer uses
    name: p.baseToken?.name || 'Token',
    symbol: p.baseToken?.symbol || '',
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    volume: p.volume || {},              // {m5,h1,h6,h24}
    priceChange,                         // {m5,h1,h6,h24}
    liquidity: { usd: p.liquidity?.usd || null },
    marketCap,
    marketCapSource,
    pairAddress: p.pairAddress || null,
    url: p.url || null,

    // extras for UI
    info: {
      imageUrl: p.info?.imageUrl || null,
    },
    socials,
    // creator from Dexscreener (moonshot creator)
    creator: p.moonshot?.creator ? String(p.moonshot.creator).toLowerCase() : null,
  };
}

// ---------- Etherscan V2 client ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract

if (!ES_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 25_000 });
const esParams = (p) => ({ params: { chainid: ES_CHAIN, apikey: ES_KEY, ...p } });
const esURL = (p) => {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...p }).forEach(([k,v])=>u.searchParams.set(k,String(v)));
  return u.toString();
};

async function esGET(params, { tag='', logOnce=false } = {}) {
  if (logOnce) console.log('[ESV2]', tag, esURL(params));
  const { data } = await httpES.get('', esParams(params));
  if (data?.status !== '1') {
    const msg = data?.result || data?.message || 'Unknown';
    throw new Error(`Etherscan v2 error: ${msg}`);
  }
  return data.result;
}

// ERC-20 Transfer(address,address,uint256)
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

async function getAllTransferLogs(token, { fromBlock=0, toBlock='latest', pageStart=1, maxPages=50, offset=1000 } = {}) {
  const all = [];
  for (let page = pageStart; page < pageStart + maxPages; page++) {
    const batch = await esGET({
      module: 'logs',
      action: 'getLogs',
      address: token,
      topic0: TOPIC_TRANSFER,
      fromBlock, toBlock, page, offset
    }, { tag:'[logs]', logOnce: page === pageStart });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < offset) break;
  }
  return all;
}

async function getTotalSupply(token) {
  return String(await esGET(
    { module:'stats', action:'tokensupply', contractaddress: token },
    { tag:'[supply]', logOnce:true }
  ));
}

async function getCreatorTokenBalance(token, creator) {
  if (!creator) return '0';
  return String(await esGET(
    { module:'account', action:'tokenbalance', contractaddress: token, address: creator, tag:'latest' },
    { tag:'[creatorBalance]', logOnce:true }
  ));
}

// ---------- on-chain maths ----------
function buildBalancesFromLogs(logs, { exclude = new Set() } = {}) {
  const balances = new Map(); // addr -> bigint
  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    const val  = toBig(lg.data);
    if (!DEAD.has(from)) balances.set(from, (balances.get(from) || 0n) - val);
    if (!DEAD.has(to))   balances.set(to,   (balances.get(to)   || 0n) + val);
  }
  // prune non-positives and excluded addresses (e.g., LP/pair)
  for (const [a, v] of balances) {
    if (v <= 0n || exclude.has(a)) balances.delete(a);
  }
  return balances;
}

function first20BuyersMatrix(logs, pairAddress, creatorAddr, balancesMap) {
  const buyers = [];
  const seen = new Set();

  // 0) creator is always "first buyer" per your definition
  if (creatorAddr) {
    // figure out creator's first received amount
    let firstBuy = 0n;
    for (const lg of logs) {
      const to = topicToAddr(lg.topics[2]);
      if (to === creatorAddr) { firstBuy = toBig(lg.data); break; }
    }
    const current = balancesMap?.get(creatorAddr) || 0n;
    let status = 'hold';
    if (current === 0n) status = 'sold all';
    else if (firstBuy && current > firstBuy) status = 'bought more';
    else if (firstBuy && current < firstBuy) status = 'sold some';
    buyers.push({ address: creatorAddr, status });
    seen.add(creatorAddr);
  }

  if (!pairAddress) return buyers; // deck may not be live yet

  const pair = String(pairAddress).toLowerCase();

  // 1) scan logs and collect first 19 unique wallets that bought from pair
  const temp = new Map(); // addr -> { firstBuy, buys, sells }
  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    const val  = toBig(lg.data);

    if (from === pair) {
      if (!temp.has(to)) temp.set(to, { firstBuy: val, buys: 0n, sells: 0n });
      temp.get(to).buys += val;
      if (temp.size >= 1000) break; // safety
    } else if (to === pair) {
      if (!temp.has(from)) continue;
      temp.get(from).sells += val;
    }
  }

  for (const [addr, { firstBuy, buys, sells }] of temp) {
    if (seen.has(addr)) continue;
    let status = 'hold';
    if (sells === 0n && buys > firstBuy) status = 'bought more';
    else if (sells > 0n && sells < buys) status = 'sold some';
    else if (sells >= buys) status = 'sold all';
    buyers.push({ address: addr, status });
    seen.add(addr);
    if (buyers.length >= 20) break;
  }

  return buyers.slice(0, 20);
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

    // 1) Dexscreener market + pair + socials + image + creator
    let market = null;
    try {
      market = await getDexTokenSnapshot(ca);
      console.log('[WORKER] Dex ok', ca, 'pair=', market?.pairAddress, 'cap=', market?.marketCap);
    } catch (e) {
      console.log('[WORKER] Dex failed:', e?.message || e);
    }

    // 2) Etherscan pulls
    let logs = [];
    let totalSupplyRaw = '0';
    let creatorAddr = market?.creator || null;
    let creatorBalRaw = '0';

    try {
      [logs, totalSupplyRaw] = await Promise.all([
        getAllTransferLogs(ca, { maxPages: 50, offset: 1000 }),
        getTotalSupply(ca),
      ]);
      if (creatorAddr) {
        creatorBalRaw = await getCreatorTokenBalance(ca, creatorAddr);
      }
      console.log('[WORKER] ESV2 ok', ca, 'logs=', logs.length, 'supply=', totalSupplyRaw, 'creator=', creatorAddr, 'creatorBal=', creatorBalRaw);
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e?.message || e);
    }

    // 3) Compute (exclude LP/pair from holders AND from top10%)
    let holdersTop20 = [];
    let holdersCount = null;
    let top10CombinedPct = 0;
    let burnedPct = 0;
    let first20Buyers = [];
    let creatorPercent = 0;

    try {
      const pair = market?.pairAddress ? String(market.pairAddress).toLowerCase() : null;
      const excludeSet = new Set(pair ? [pair] : []);
      const balances = buildBalancesFromLogs(logs, { exclude: excludeSet });

      // burned = sum of transfers to dead addresses (not excluded)
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

      // creator %
      let creatorBal = 0n;
      try { creatorBal = toBig(creatorBalRaw || '0'); } catch {}
      if (creatorBal === 0n && creatorAddr) {
        // fall back to current balance from our map
        creatorBal = balances.get(creatorAddr) || 0n;
      }
      creatorPercent = supply > 0n ? Number((creatorBal * 1000000n) / supply) / 10000 : 0;

      // buyers (creator is always first), then first 19 DEX buyers via pairAddress
      first20Buyers = first20BuyersMatrix(logs, market?.pairAddress, creatorAddr, balances);
    } catch (e) {
      console.log('[WORKER] compute failed:', e?.message || e);
    }

    // 4) Final payload for renderers
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market, // includes price, volume, change, cap/fdv, liquidity, pairAddress, socials, imageUrl, name/symbol

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
