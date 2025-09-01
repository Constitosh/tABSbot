// src/refreshWorker.js
// Sources:
//  • Market + creator: Dexscreener (pair + /tokens/v1/abstract/<CA> for creator)
//  • On-chain math: Etherscan V2 (chainid=2741) — logs.getLogs, stats.tokensupply, account.tokenbalance
// Queue: BullMQ

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// ---------- Dexscreener helpers ----------
async function getDexCreator(ca) {
  try {
    const url = `https://api.dexscreener.com/tokens/v1/abstract/${ca}`;
    const { data } = await axios.get(url, { timeout: 12_000 });
    if (data?.creator) return String(data.creator).toLowerCase();
    if (Array.isArray(data) && data[0]?.creator) return String(data[0].creator).toLowerCase();
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect both AMM pair (real on-chain 0x...) and Moonshot pair (pseudo ":moon")
 * without changing your existing dexscreener service. We fetch the token pairs
 * endpoint directly and choose the best AMM by h24 volume (then liquidity).
 */
async function getDexPairAddresses(ca) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
    const { data } = await axios.get(url, { timeout: 15_000 });

    const dsPairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const abstractPairs = dsPairs.filter(p => p?.chainId === 'abstract');

    const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

    // Best AMM candidate (not :moon)
    const ammCandidates = abstractPairs.filter(p => !isMoon(p));
    ammCandidates.sort((a, b) => {
      const vA = Number(a?.volume?.h24 || 0), vB = Number(b?.volume?.h24 || 0);
      if (vB !== vA) return vB - vA;
      const lA = Number(a?.liquidity?.usd || 0), lB = Number(b?.liquidity?.usd || 0);
      return lB - lA;
    });
    const bestAMM = ammCandidates[0] || null;

    const moon = abstractPairs.find(isMoon) || null;

    return {
      ammPair: bestAMM?.pairAddress ? String(bestAMM.pairAddress).toLowerCase() : null,
      launchPadPair: moon?.pairAddress ? String(moon.pairAddress) : null,
    };
  } catch {
    return { ammPair: null, launchPadPair: null };
  }
}

// ---------- Etherscan V2 client ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract

if (!ES_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY is missing');
const httpES = axios.create({ baseURL: ES_BASE, timeout: 25_000 });

// ---------- Etherscan rate limit (≤ 5 req/s by default) ----------
const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 5));
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS);

let esLastTs = 0;
let esChain = Promise.resolve();

async function throttleES() {
  await (esChain = esChain.then(async () => {
    const wait = Math.max(0, esLastTs + ES_MIN_INTERVAL - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    esLastTs = Date.now();
  }));
}

function esParams(params) {
  return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } };
}
function esURL(params) {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}
async function esGET(params, { logOnce = false, tag = '' } = {}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (attempt === maxAttempts) throw new Error(`Etherscan v2 error: ${msg}`);
    } catch (e) {
      if (attempt === maxAttempts) throw e;
    }
    await new Promise(r => setTimeout(r, 400 * attempt));
  }
}

// ---------- Constants & utils ----------
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

// ---------- Discover concrete block bounds (finite crawl) ----------
async function getCreationBlock(token) {
  // Try contract creation first (param name is plural)
  try {
    const res = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      { logOnce: true, tag: '[creatorBlock]' }
    );
    const first = Array.isArray(res) ? res[0] : res;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  // Fallback: earliest token tx
  try {
    const r = await esGET(
      { module: 'account', action: 'tokentx', contractaddress: token, page: 1, offset: 1, sort: 'asc' },
      { logOnce: true, tag: '[firstTx]' }
    );
    const n = Number((Array.isArray(r) && r[0]?.blockNumber) || r?.blockNumber);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 0;
}

async function getLatestBlock() {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const r = await esGET(
      { module: 'block', action: 'getblocknobytime', timestamp: ts, closest: 'before' },
      { logOnce: true, tag: '[latestBlock]' }
    );
    const n = Number(r?.blockNumber || r?.BlockNumber || r);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  // hard fallback (shouldn't be hit)
  return 9_223_372_036;
}

// ---------- Block-windowed Transfer log crawler (finite) ----------
async function getAllTransferLogs(token, {
  fromBlock,
  toBlock,
  window = 300_000,
  offset = 1000,
  maxWindows = 200,
} = {}) {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock > toBlock) {
    throw new Error(`bad block range ${fromBlock}..${toBlock}`);
  }

  const all = [];
  let start = fromBlock;
  let windows = 0;

  while (start <= toBlock) {
    const end = Math.min(start + window, toBlock);

    for (let page = 1; ; page++) {
      const params = {
        module: 'logs',
        action: 'getLogs',
        address: token,
        topic0: TOPIC_TRANSFER,
        fromBlock: start,
        toBlock: end,
        page,
        offset,
      };
      const batch = await esGET(params, { logOnce: page === 1, tag: `[logs ${start}-${end}]` });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < offset) break; // no more pages for this window
    }

    start = end + 1;
    windows++;
    if (windows >= maxWindows) {
      console.warn(`[ESV2] window cap hit (${maxWindows}); stopping early at block ${end}`);
      break;
    }
  }
  return all;
}

// ---------- Etherscan helpers ----------
async function getTokenTotalSupply(token) {
  return String(await esGET(
    { module: 'stats', action: 'tokensupply', contractaddress: token },
    { logOnce: true, tag: '[supply]' }
  ));
}

async function getCreatorTokenBalance(token, creator) {
  if (!creator) return '0';
  return String(await esGET(
    { module: 'account', action: 'tokenbalance', contractaddress: token, address: creator, tag: 'latest' },
    { logOnce: true, tag: '[creatorBalance]' }
  ));
}

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

// Compute holders & top10, excluding specified addresses (e.g., LP)
function computeTopHolders(balances, totalSupplyBigInt, { exclude = [] } = {}) {
  const ex = new Set((exclude || []).map(s => String(s || '').toLowerCase()));
  const rows = [];
  for (const [addr, bal] of balances.entries()) {
    const a = addr.toLowerCase();
    if (bal <= 0n) continue;
    if (ex.has(a)) continue;
    rows.push([a, bal]);
  }
  rows.sort((A, B) => (B[1] > A[1] ? 1 : (B[1] < A[1] ? -1 : 0)));

  const top20 = rows.slice(0, 20).map(([address, bal]) => {
    const pctTimes1e4 = totalSupplyBigInt > 0n
      ? Number((bal * 1000000n) / totalSupplyBigInt) / 10000
      : 0;
    return { address, balance: bal.toString(), percent: +pctTimes1e4.toFixed(4) };
  });

  const top10CombinedPct = +top20.slice(0, 10)
    .reduce((acc, h) => acc + (h.percent || 0), 0)
    .toFixed(4);

  return { holdersTop20: top20, top10CombinedPct, holdersCount: rows.length };
}

// Buyers: first 20 unique recipients (mint or AMM), status from final balance vs total bought
function first20BuyersMatrix(logs, pairAddress, balances) {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const pair = pairAddress ? String(pairAddress).toLowerCase() : null;

  // Ensure logs are chronological (ok if you already sort earlier)
  // logs.sort((a,b)=> (Number(a.blockNumber)-Number(b.blockNumber)) || (Number(a.logIndex)-Number(b.logIndex)));

  // 1) earliest 20 unique recipients (from mint OR from LP). Exclude LP/dead.
  const firstSeen = new Map(); // addr -> { firstBuyBlock, firstBuyAmt }
  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    if (DEAD.has(to)) continue;
    if (pair && to === pair) continue;              // never count LP itself
    const isMintIn = from === ZERO;
    const isLPIn   = pair && from === pair;
    if (!isMintIn && !isLPIn) continue;

    if (!firstSeen.has(to)) {
      firstSeen.set(to, {
        firstBuyBlock: Number(lg.blockNumber),
        firstBuyAmt: toBig(lg.data),
      });
      if (firstSeen.size >= 20) break;
    }
  }

  // 2) for those 20 wallets, sum all later receives from mint/LP = totalBought
  const target = new Set(firstSeen.keys());
  const totals = new Map(); // addr -> { totalBought, buysN }
  for (const a of target) totals.set(a, { totalBought: 0n, buysN: 0 });

  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    if (!target.has(to)) continue;
    const isMintIn = from === ZERO;
    const isLPIn   = pair && from === pair;
    if (!isMintIn && !isLPIn) continue;

    const t = totals.get(to);
    t.totalBought += toBig(lg.data);
    t.buysN += 1;
  }

  // 3) build ordered output (earliest first) + status from final balance vs totalBought
  const out = [...firstSeen.entries()]
    .sort((a,b)=> a[1].firstBuyBlock - b[1].firstBuyBlock)
    .map(([address, info]) => {
      const t = totals.get(address) || { totalBought: 0n, buysN: 0 };
      const balNow = balances.get(address.toLowerCase()) || 0n;

      let status = 'hold';
      if (balNow === 0n) {
        status = 'sold all';
      } else if (balNow < t.totalBought) {
        status = 'sold some';
      } else if (t.buysN > 1 || t.totalBought > info.firstBuyAmt) {
        status = 'bought more';
      } // else keep 'hold'

      return {
        address,
        status,
        // uncomment if you want to display amounts later
        // firstBuy: info.firstBuyAmt.toString(),
        // totalBought: t.totalBought.toString(),
        // balanceNow: balNow.toString(),
      };
    });

  return out;
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

    // 1) Dexscreener (market + pair + creator)
    let market = null;
    let ammPair = null;        // real on-chain LP (0x…)
    let launchPadPair = null;  // ":moon" pseudo-id (for UI only)
    let creatorAddr = null;

    try {
      const { summary } = await getDexscreenerTokenStats(ca);
      market = summary || null;

      // Detect pairs robustly (AMM vs Moonshot)
      const pairInfo = await getDexPairAddresses(ca);
      ammPair = pairInfo.ammPair || null;
      launchPadPair = pairInfo.launchPadPair || null;

      // Keep market as-is but annotate discovered pairs
      if (market) {
        market.pairAddress = ammPair || market.pairAddress || null;  // prefer AMM
        market.launchPadPair = launchPadPair || null;
      }

      console.log('[WORKER] Dexscreener ok', ca, 'ammPair=', ammPair, 'moonPair=', launchPadPair, 'cap=', market?.marketCap ?? market?.fdv ?? 0);

      // fetch creator from Dexscreener tokens/v1
      creatorAddr = await getDexCreator(ca);
      console.log('[WORKER] Dex creator', creatorAddr || 'unknown');
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan V2 pulls (finite windowed logs + totals)
    let logs = [];
    let totalSupplyRaw = '0';
    let creatorBalRaw = '0';
    try {
      const [creationBlock, latestBlock] = await Promise.all([
        getCreationBlock(ca),
        getLatestBlock(),
      ]);

      const fromB = Math.max(0, creationBlock - 1); // include mint
      const toB   = latestBlock;

      console.log('[WORKER] range', ca, fromB, '→', toB);

      [logs, totalSupplyRaw] = await Promise.all([
        getAllTransferLogs(ca, { fromBlock: fromB, toBlock: toB, window: 300_000, offset: 1000 }),
        getTokenTotalSupply(ca),
      ]);

      if (creatorAddr) {
        creatorBalRaw = await getCreatorTokenBalance(ca, creatorAddr);
      }
      console.log('[WORKER] ESV2 ok', ca, 'logs=', logs.length, 'supply=', totalSupplyRaw, 'creatorBal=', creatorBalRaw);
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e?.message || e);
    }

// sort logs to strict chronological order
logs.sort((a,b) => {
  const ba = Number(a.blockNumber||0), bb = Number(b.blockNumber||0);
  if (ba !== bb) return ba - bb;
  const ia = Number(a.logIndex||0), ib = Number(b.logIndex||0);
  return ia - ib;
});

    
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

      // Exclude AMM pair from holders/top10 (DO NOT exclude ":moon")
      const excludeList = [];
      if (ammPair) excludeList.push(String(ammPair).toLowerCase());

      const holders = computeTopHolders(balances, supply, { exclude: excludeList });
      holdersTop20 = holders.holdersTop20;
      top10CombinedPct = holders.top10CombinedPct;
      holdersCount = holders.holdersCount;

      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      // creator percent: prefer direct tokenbalance; fallback to computed balance
      let creatorBal = 0n;
      try { creatorBal = toBig(creatorBalRaw || '0'); } catch {}
      if (creatorBal === 0n && creatorAddr) {
        creatorBal = balances.get(creatorAddr.toLowerCase()) || 0n;
      }
      creatorPercent = (supply > 0n) ? Number((creatorBal * 1000000n) / supply) / 10000 : 0;

      // Buyers only if we have a real AMM pair
      first20Buyers = ammPair ? first20BuyersMatrix(logs, ammPair, balances) : [];
    } catch (e) {
      console.log('[WORKER] compute failed:', e?.message || e);
    }

    // 4) Final payload for your renderers
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),

      market, // includes price/volume/change/cap/socials AND now { pairAddress, launchPadPair }

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
