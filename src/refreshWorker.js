// src/refreshWorker.js
// Queue-backed refresher for token summaries (holders, creator, market)
// Chain-aware: pass dsChain (dexscreener slug) + esChain (etherscan chain id)
// Caches partial payloads so /tabs doesn't get stuck on "Initializing…"

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { chainKey } from './chains.js';

/* -------------------- BullMQ connection -------------------- */
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const refreshQueueName = 'tabs_refresh';
export const refreshQueue = new Queue(refreshQueueName, { connection: bullRedis });
// 👇 Make a compat export that queueCore.js expects:
export const queue = refreshQueue;

/* -------------------- Etherscan v2 client -------------------- */
const ESV2_BASE = process.env.ETHERSCAN_V2_BASE || process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ESV2_KEY  = process.env.ETHERSCAN_API_KEY || '';
if (!ESV2_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY is missing');

const httpES = axios.create({ baseURL: ESV2_BASE, timeout: 45_000 });

// RPS throttle
const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 5));
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS);
let esLastTs = 0;
let esChainGate = Promise.resolve();
async function throttleES() {
  await (esChainGate = esChainGate.then(async () => {
    const wait = Math.max(0, esLastTs + ES_MIN_INTERVAL - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    esLastTs = Date.now();
  }));
}

function esParams(params, esChainId) {
  return { params: { chainid: esChainId, apikey: ESV2_KEY, ...params } };
}
function esURL(params, esChainId) {
  const u = new URL(ESV2_BASE);
  Object.entries({ chainid: esChainId, apikey: ESV2_KEY, ...params }).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

async function esGET(params, esChainId, { logOnce = false, tag = '' } = {}) {
  await throttleES();
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params, esChainId)}`);
      const { data } = await httpES.get('', esParams(params, esChainId));
      if (data?.status === '1') return data.result;

      const msg = (data?.result || data?.message || '').toString().toLowerCase();
      // Treat “no records found” as empty, not an error
      if (msg.includes('no records') || msg.includes('not found')) {
        return [];
      }
      if (attempt === maxAttempts) throw new Error(data?.result || data?.message || 'Etherscan v2 error');
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  return [];
}

/* -------------------- Dexscreener helpers -------------------- */

async function getDexCreator(ca, dsChain) {
  // Best-effort: /tokens/v1/<chain>/<CA> sometimes returns creator
  try {
    const url = `https://api.dexscreener.com/tokens/v1/${dsChain}/${ca}`;
    const { data } = await axios.get(url, { timeout: 12_000 });
    if (data?.creator) return String(data.creator).toLowerCase();
    if (Array.isArray(data) && data[0]?.creator) return String(data[0].creator).toLowerCase();
  } catch {}
  return null;
}

async function getDexPairAddresses(ca, dsChain) {
  // Pick best AMM pair by (liquidity + h24 volume); detect Moonshot (pairAddress contains ':moon')
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
    const { data } = await axios.get(url, { timeout: 15_000 });

    const dsPairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const chainPairs = dsPairs.filter(p => String(p?.chainId) === String(dsChain));
    const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

    const ammCandidates = chainPairs.filter(p => !isMoon(p));
    ammCandidates.sort((a, b) => {
      const vA = Number(a?.volume?.h24 || 0), vB = Number(b?.volume?.h24 || 0);
      if (vB !== vA) return vB - vA;
      const lA = Number(a?.liquidity?.usd || 0), lB = Number(b?.liquidity?.usd || 0);
      return lB - lA;
    });

    const bestAMM = ammCandidates[0] || null;
    const moon = chainPairs.find(isMoon) || null;

    return {
      ammPair: bestAMM?.pairAddress ? String(bestAMM.pairAddress).toLowerCase() : null,
      launchPadPair: moon?.pairAddress ? String(moon.pairAddress) : null,
    };
  } catch {
    return { ammPair: null, launchPadPair: null };
  }
}

/* -------------------- Etherscan helpers -------------------- */

const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([ZERO, '0x000000000000000000000000000000000000dEaD', '0x000000000000000000000000000000000000dead'].map(s => s.toLowerCase()));
const BANNED = new Set([
  // add addresses to ignore in holder distribution here if needed
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

async function getCreationBlock(token, esChainId) {
  try {
    const res = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      esChainId, { logOnce: true, tag: '[creatorBlock]' }
    );
    const first = Array.isArray(res) ? res[0] : res;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await esGET(
      { module: 'account', action: 'tokentx', contractaddress: token, page: 1, offset: 1, sort: 'asc' },
      esChainId, { logOnce: true, tag: '[firstTx]' }
    );
    const n = Number((Array.isArray(r) && r[0]?.blockNumber) || r?.blockNumber);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 0;
}
async function getLatestBlock(esChainId) {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const r = await esGET(
      { module: 'block', action: 'getblocknobytime', timestamp: ts, closest: 'before' },
      esChainId, { logOnce: true, tag: '[latestBlock]' }
    );
    const n = Number(r?.blockNumber || r?.BlockNumber || r);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 9_223_372_036; // fallback big number
}

async function getAllTransferLogs(token, esChainId, {
  fromBlock,
  toBlock,
  window = 75_000,
  offset = 1000,
  maxWindows = 400,
} = {}) {
  const all = [];
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock > toBlock) return all;

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

      let batch = null;
      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          batch = await esGET(params, esChainId, { logOnce: page === 1 && attempt === 1, tag: `[logs ${start}-${end}]` });
          ok = true; break;
        } catch (e) {
          if (attempt === 2) {
            console.warn(`[ESV2] window ${start}-${end} page ${page} failed: ${e.message || e}`);
          } else {
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
      }
      if (!ok) break;
      if (!Array.isArray(batch) || batch.length === 0) break;

      all.push(...batch);
      if (batch.length < offset) break;
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

async function getTokenTotalSupply(token, esChainId) {
  try {
    const r = await esGET(
      { module: 'stats', action: 'tokensupply', contractaddress: token },
      esChainId, { logOnce: true, tag: '[supply]' }
    );
    return String(r || '0');
  } catch {
    return '0';
  }
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
function computeTopHolders(balances, totalSupplyBigInt, { exclude = [] } = {}) {
  const ex = new Set((exclude || []).map(s => String(s || '').toLowerCase()));
  const rows = [];
  for (const [addr, bal] of balances.entries()) {
    const a = addr.toLowerCase();
    if (bal <= 0n) continue;
    if (ex.has(a)) continue;
    if (BANNED.has(a)) continue;
    rows.push([a, bal]);
  }
  // sort desc by balance
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

/* -------------------- Main refresh -------------------- */

export async function refreshToken(tokenAddress, dsChain = 'abstract', esChainId = '2741') {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);
  const ck = chainKey(dsChain);

  const lockKey = `lock:refresh:${ck}:${ca}`;
  return withLock(lockKey, 60, async () => {
    const t0 = Date.now();
    console.log('[WORKER] refreshToken start', dsChain, esChainId, ca);

    // 1) Dexscreener (market + pairs + creator if available)
    let market = null;
    let ammPair = null;
    let launchPadPair = null;
    let creatorAddr = null;
    let isMoonshot = false;

    try {
      const { summary } = await getDexscreenerTokenStats(ca, dsChain);
      market = summary || null;

      const pairInfo = await getDexPairAddresses(ca, dsChain);
      ammPair = pairInfo.ammPair || null;
      launchPadPair = pairInfo.launchPadPair || null;

      if (market) {
        market.pairAddress   = ammPair || market.pairAddress || null;
        market.launchPadPair = launchPadPair || null;
      }

      creatorAddr = await getDexCreator(ca, dsChain);

      isMoonshot =
        !!market?.launchPadPair ||
        String(market?.dexId || '').toLowerCase() === 'moonshot' ||
        !!market?.moonshot;

      console.log('[WORKER] Dex ok', ca, 'ammPair=', ammPair, 'moonPair=', launchPadPair, 'creator=', creatorAddr || 'unknown');
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan pulls (best-effort)
    let logs = [];
    let totalSupplyRaw = '0';
    let holdersTop20 = [];
    let holdersCount = 0;
    let top10CombinedPct = 0;
    let burnedPct = 0;

    try {
      const [creationBlock, latestBlock] = await Promise.all([
        getCreationBlock(ca, esChainId),
        getLatestBlock(esChainId),
      ]);

      const fromB = Math.max(0, creationBlock - 1);
      const toB   = latestBlock;

      console.log('[WORKER] range', ca, fromB, '→', toB);

      [logs, totalSupplyRaw] = await Promise.all([
        getAllTransferLogs(ca, esChainId, { fromBlock: fromB, toBlock: toB, window: 75_000, offset: 1000 }),
        getTokenTotalSupply(ca, esChainId),
      ]);

      // sort chronological
      logs.sort((a, b) => {
        const ba = Number(a.blockNumber || 0), bb = Number(b.blockNumber || 0);
        if (ba !== bb) return ba - bb;
        const ia = Number(a.logIndex || 0), ib = Number(b.logIndex || 0);
        return ia - ib;
      });

      const balances = buildBalancesFromLogs(logs);
      const supply = toBig(totalSupplyRaw || '0');

      // burned %
      let burned = 0n;
      for (const lg of logs) {
        const to = topicToAddr(lg.topics[2]);
        if (DEAD.has(to)) burned += toBig(lg.data);
      }
      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      // Exclusions for holders: AMM pool and (during moonshot) token CA as pool
      const excludeList = [];
      if (ammPair) excludeList.push(String(ammPair).toLowerCase());
      const moonProg = Number(market?.moonshot?.progress || 0);
      const excludeTokenAsPool = isMoonshot && moonProg > 0 && moonProg < 100;
      if (excludeTokenAsPool) excludeList.push(ca);

      const holders = computeTopHolders(balances, supply, { exclude: excludeList });
      holdersTop20 = holders.holdersTop20;
      top10CombinedPct = holders.top10CombinedPct;
      holdersCount = holders.holdersCount;

    } catch (e) {
      console.warn('[WORKER] Etherscan section degraded:', e?.message || e);
      // Leave defaults; we still cache a partial payload
    }

    // 3) Final payload (always cache something so bot isn't stuck)
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market,
      holdersTop20,
      top10CombinedPct,
      burnedPct,
      holdersCount,
      creator: { address: creatorAddr || null },
    };

    const sumKey  = `token:${ck}:${ca}:summary`;
    const gateKey = `token:${ck}:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180); // 3 minutes summary cache
      await setJSON(gateKey, { ts: Date.now() }, 600); // 10 minutes refresh gate
      console.log('[WORKER] cached', sumKey, 'ttl=180s', 'elapsed', (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('[WORKER] cache write failed:', e?.message || e);
    }

    console.log('[WORKER] refreshToken done', dsChain, ca);
    return payload;
  });
}

/* -------------------- Worker (consumer) -------------------- */
new Worker(
  refreshQueueName,
  async (job) => {
    const ca = job.data?.tokenAddress;
    const dsChain = job.data?.dsChain || 'abstract';
    const esChain = job.data?.esChain || '2741';
    console.log('[WORKER] job received:', job.name, job.id, dsChain, esChain, ca);
    try {
      const res = await refreshToken(ca, dsChain, esChain);
      console.log('[WORKER] job OK:', job.id);
      return res;
    } catch (e) {
      console.log('[WORKER] job FAIL:', job.id, e?.message || e);
      throw e;
    }
  },
  { connection: bullRedis }
);

/* -------------------- Optional cron refresher -------------------- */
// If you want a periodic warm-cache for specific tokens per chain, set DEFAULT_TOKENS like:
// DEFAULT_TOKENS="abstract:0xabc,base:0xdef,hyper:0x123"
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const items = process.env.DEFAULT_TOKENS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [dsChain, caRaw] = s.split(':');
      return { dsChain: (dsChain || 'abstract').trim(), ca: (caRaw || '').trim().toLowerCase() };
    })
    .filter(x => /^0x[a-f0-9]{40}$/.test(x.ca));

  if (items.length) {
    console.log('[CRON] Refreshing tokens every 120s:', items.map(x => `${x.dsChain}:${x.ca}`).join(', '));
    setInterval(async () => {
      for (const it of items) {
        const es = (it.dsChain === 'base') ? '8453'
                 : (it.dsChain === 'hyperevm' || it.dsChain === 'hyper') ? '999'
                 : '2741';
        try {
          await refreshQueue.add('refresh', { tokenAddress: it.ca, dsChain: it.dsChain, esChain: es }, { removeOnComplete: true, removeOnFail: true });
        } catch (e) {
          console.error('[CRON] Enqueue failed for', it.dsChain, it.ca, e?.message || e);
        }
      }
    }, 120_000);
  }
}
