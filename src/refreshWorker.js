// src/refreshWorker.js
// Sources:
//  • Market + creator: Dexscreener
//  • On-chain math: Etherscan V2 — logs.getLogs (holders math), account.tokentx (first buyers),
//    stats.tokensupply, account.tokenbalance
// Queue: BullMQ

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, getJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { chainKey } from './chains.js';

// ---------- Dexscreener helpers ----------
async function getDexCreator(ca, dsChain = 'abstract') {
  try {
    // NOTE: the tokens/v1 path needs the chain segment
    const url = `https://api.dexscreener.com/tokens/v1/${dsChain}/${ca}`;
    const { data } = await axios.get(url, { timeout: 12_000 });
    if (data?.creator) return String(data.creator).toLowerCase();
    if (Array.isArray(data) && data[0]?.creator) return String(data[0].creator).toLowerCase();
    return null;
  } catch {
    return null;
  }
}

async function getDexPairAddresses(ca, dsChain = 'abstract') {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
    const { data } = await axios.get(url, { timeout: 15_000 });

    const dsPairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const sameChain = (p) => String(p?.chainId || '').toLowerCase() === String(dsChain).toLowerCase();
    const chainPairs = dsPairs.filter(sameChain);
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

// ---------- Etherscan V2 client ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN_DEFAULT = process.env.ETHERSCAN_CHAIN_ID || '2741'; // default Abstract

if (!ES_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY is missing');
const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// per-worker in-memory chain override (queue concurrency is 1 by default)
let CURRENT_ES_CHAIN = ES_CHAIN_DEFAULT;

function setEsChain(chainId) {
  const cid = String(chainId || ES_CHAIN_DEFAULT);
  CURRENT_ES_CHAIN = cid;
}

// ---------- Etherscan rate limit ----------
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
  return { params: { chainid: CURRENT_ES_CHAIN, apikey: ES_KEY, ...params } };
}
function esURL(params) {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: CURRENT_ES_CHAIN, apikey: ES_KEY, ...params })
    .forEach(([k,v]) => u.searchParams.set(k, String(v)));
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
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([
  ZERO,
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const BANNED = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'  // example banned wallet
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

// ---------- Discover block bounds ----------
async function getCreationBlock(token) {
  try {
    const res = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      { logOnce: true, tag: '[creatorBlock]' }
    );
    const first = Array.isArray(res) ? res[0] : res;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
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
  return 9_223_372_036;
}
async function getContractCreator(token) {
  try {
    const res = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      { logOnce: false, tag: '' }
    );
    const first = Array.isArray(res) ? res[0] : res;
    const addr = first?.contractCreator || first?.creatorAddress || first?.contractCreatorAddress;
    return addr ? String(addr).toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------- Windowed Transfer log crawler (holders math) ----------
async function getAllTransferLogs(token, {
  fromBlock,
  toBlock,
  window = 200_000,
  offset = 1000,
  maxWindows = 300,
} = {}) {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock > toBlock) {
    throw new Error(`bad block range ${fromBlock}..${toBlock}`);
  }

  const all = [];
  let start = fromBlock;
  let windows = 0;
  let failedWindows = 0;

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
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          batch = await esGET(params, { logOnce: page === 1 && attempt === 1, tag: `[logs ${start}-${end}]` });
          ok = true; break;
        } catch (e) {
          if (attempt === 3) {
            console.warn(`[ESV2] window ${start}-${end} page ${page} failed after retries: ${e.message || e}`);
          } else {
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
      }
      if (!ok) { failedWindows++; break; }

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

  if (failedWindows) {
    console.warn(`[ESV2] getLogs had ${failedWindows} failed window(s).`);
  }
  return all;
}

function buildBalancesFromLogs(logs) {
  const balances = new Map(); // addr -> bigint
  for (const lg of logs) {
    const from = ('0x' + String(lg.topics?.[1] || '').slice(-40)).toLowerCase();
    const to   = ('0x' + String(lg.topics?.[2] || '').slice(-40)).toLowerCase();
    const val  = toBig(lg.data || '0');
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

/** ---------- First buyers helpers (unchanged) ---------- */
function first20BuyersFromTokentx(txsAsc, { tokenAddress, creator, pairAddress, excludeTokenAsPool = false }, balances) {
  if (!Array.isArray(txsAsc) || txsAsc.length === 0 || !creator) return [];
  const ca = String(tokenAddress).toLowerCase();
  const creatorAddr = String(creator).toLowerCase();
  const pair = pairAddress ? String(pairAddress).toLowerCase() : null;

  let startIdx = -1;
  for (let i = 0; i < txsAsc.length; i++) {
    const to = String(txsAsc[i]?.to || '').toLowerCase();
    if (to === creatorAddr) { startIdx = i; break; }
  }
  if (startIdx < 0) return [];

  const firstSeen = new Map();
  const addIfEligible = (tx) => {
    const to = String(tx?.to || '').toLowerCase();
    if (!to) return false;
    if (DEAD.has(to)) return false;
    if (pair && to === pair) return false;
    if (excludeTokenAsPool && to === ca) return false;
    if (BANNED.has(to)) return false;
    if (!firstSeen.has(to)) {
      let amt = 0n;
      try { amt = toBig(tx.value || '0'); } catch {}
      firstSeen.set(to, {
        firstBuyAmt: amt,
        blockNumber: Number(tx.blockNumber || 0),
        logIndex: Number(tx.logIndex || 0),
      });
      return true;
    }
    return false;
  };

  addIfEligible(txsAsc[startIdx]);
  for (let i = startIdx + 1; i < txsAsc.length && firstSeen.size < 20; i++) {
    addIfEligible(txsAsc[i]);
  }

  const ordered = [...firstSeen.entries()]
    .sort((a, b) => {
      if (a[1].blockNumber !== b[1].blockNumber) return a[1].blockNumber - b[1].blockNumber;
      return a[1].logIndex - b[1].logIndex;
    })
    .map(([address, info]) => {
      const balNow = balances.get(address.toLowerCase()) || 0n;
      let status = 'hold';
      if (balNow === 0n) status = 'sold all';
      else if (balNow < info.firstBuyAmt) status = 'sold some';
      else if (balNow > info.firstBuyAmt) status = 'bought more';
      return { address, status };
    });

  return ordered.slice(0, Math.min(20, ordered.length));
}

function first20BuyersFromLogs(logsAsc, { tokenAddress, creator, pairAddress, excludeTokenAsPool = false }, balances) {
  if (!Array.isArray(logsAsc) || logsAsc.length === 0 || !creator) return [];
  const ca = String(tokenAddress).toLowerCase();
  const creatorAddr = String(creator).toLowerCase();
  const pair = pairAddress ? String(pairAddress).toLowerCase() : null;

  let startIdx = -1;
  for (let i = 0; i < logsAsc.length; i++) {
    const to = ('0x' + String(logsAsc[i].topics?.[2] || '').slice(-40)).toLowerCase();
    if (to === creatorAddr) { startIdx = i; break; }
  }
  if (startIdx < 0) return [];

  const firstSeen = new Map();
  const addIfEligible = (lg) => {
    const to = ('0x' + String(lg.topics?.[2] || '').slice(-40)).toLowerCase();
    if (DEAD.has(to)) return false;
    if (pair && to === pair) return false;
    if (excludeTokenAsPool && to === ca) return false;
    if (BANNED.has(to)) return false;
    if (!firstSeen.has(to)) {
      const amt = toBig(lg.data || '0');
      firstSeen.set(to, {
        firstBuyAmt: amt,
        blockNumber: Number(lg.blockNumber || 0),
        logIndex: Number(lg.logIndex || 0),
      });
      return true;
    }
    return false;
  };

  addIfEligible(logsAsc[startIdx]);
  for (let i = startIdx + 1; i < logsAsc.length && firstSeen.size < 20; i++) {
    addIfEligible(logsAsc[i]);
  }

  const ordered = [...firstSeen.entries()]
    .sort((a, b) => {
      if (a[1].blockNumber !== b[1].blockNumber) return a[1].blockNumber - b[1].blockNumber;
      return a[1].logIndex - b[1].logIndex;
    })
    .map(([address, info]) => {
      const balNow = balances.get(address.toLowerCase()) || 0n;
      let status = 'hold';
      if (balNow === 0n) status = 'sold all';
      else if (balNow < info.firstBuyAmt) status = 'sold some';
      else if (balNow > info.firstBuyAmt) status = 'bought more';
      return { address, status };
    });

  return ordered.slice(0, Math.min(20, ordered.length));
}

// ---------- Redis / BullMQ ----------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

// ---------- Main refresh ----------
export async function refreshToken(tokenAddress, { dsChain = 'abstract', esChain = ES_CHAIN_DEFAULT } = {}) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  // set per-call chain context
  setEsChain(esChain);
  const ck = chainKey(dsChain);
  const sumKey  = `token:${ck}:${ca}:summary`;
  const gateKey = `token:${ck}:${ca}:last_refresh`;

  const lockKey = `lock:refresh:${ck}:${ca}`;
  return withLock(lockKey, 60, async () => {
    const t0 = Date.now();
    console.log('[WORKER] refreshToken start', ca, 'ds=', dsChain, 'es=', esChain);

    // 1) Dexscreener (market + pair + creator)
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

      if (!creatorAddr) {
        const dsMoonCreator = market?.moonshot?.creator;
        if (dsMoonCreator && /^0x[a-fA-F0-9]{40}$/.test(dsMoonCreator)) {
          creatorAddr = String(dsMoonCreator).toLowerCase();
        }
      }
      if (!creatorAddr) creatorAddr = await getContractCreator(ca);

      console.log('[WORKER] Dex ok', ca, 'ammPair=', ammPair, 'moonPair=', launchPadPair, 'creator=', creatorAddr || 'unknown');
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan pulls
    let logs = [];
    let totalSupplyRaw = '0';
    let creatorBalRaw = '0';
    let earlyTokentx = [];
    try {
      const [creationBlock, latestBlock] = await Promise.all([
        getCreationBlock(ca),
        getLatestBlock(),
      ]);

      const fromB = Math.max(0, creationBlock - 1);
      const toB   = latestBlock;

      console.log('[WORKER] range', ca, fromB, '→', toB);

      [logs, totalSupplyRaw, earlyTokentx] = await Promise.all([
        getAllTransferLogs(ca, { fromBlock: fromB, toBlock: toB, window: 200_000, offset: 1000 }),
        getTokenTotalSupply(ca),
        fetchEarliestTokentxAsc(ca, { pages: 20, offset: 200 }),
      ]);

      if (creatorAddr) {
        creatorBalRaw = await getCreatorTokenBalance(ca, creatorAddr);
      }
      console.log('[WORKER] pulls ok', 'logs=', logs.length, 'tokentxEarly=', earlyTokentx.length, 'supply=', totalSupplyRaw);
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e?.message || e);
    }

    // sort logs chronological
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
      const supply = toBig(totalSupplyRaw || '0');

      // burned
      let burned = 0n;
      for (const lg of logs) {
        const to = ('0x' + String(lg.topics?.[2] || '').slice(-40)).toLowerCase();
        if (DEAD.has(to)) try { burned += toBig(lg.data || '0'); } catch {}
      }
      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      // excludes
      const excludeList = [];
      if (ammPair) excludeList.push(String(ammPair).toLowerCase());
      const moonProg = Number(market?.moonshot?.progress || 0);
      const excludeTokenAsPool = (!!market?.launchPadPair || String(market?.dexId || '').toLowerCase() === 'moonshot') && moonProg > 0 && moonProg < 100;
      if (excludeTokenAsPool) excludeList.push(ca);

      const holders = computeTopHolders(balances, supply, { exclude: excludeList });
      holdersTop20 = holders.holdersTop20;
      top10CombinedPct = holders.top10CombinedPct;
      holdersCount = holders.holdersCount;

      // creator %
      let creatorBal = 0n;
      try { creatorBal = toBig(creatorBalRaw || '0'); } catch {}
      if (creatorBal === 0n && creatorAddr) {
        creatorBal = balances.get(creatorAddr.toLowerCase()) || 0n;
      }
      creatorPercent = (supply > 0n) ? Number((creatorBal * 1000000n) / supply) / 10000 : 0;

      // FIRST BUYERS
      first20Buyers = first20BuyersFromTokentx(
        earlyTokentx,
        { tokenAddress: ca, creator: creatorAddr, pairAddress: ammPair, excludeTokenAsPool },
        balances
      );
      if (!first20Buyers.length) {
        first20Buyers = first20BuyersFromLogs(
          logs,
          { tokenAddress: ca, creator: creatorAddr, pairAddress: ammPair, excludeTokenAsPool },
          balances
        );
      }

      console.log(
        '[WORKER] compute sizes',
        'balances=', balances.size,
        'holdersTop20=', holdersTop20?.length || 0,
        'buyers=', first20Buyers?.length || 0
      );
    } catch (e) {
      console.log('[WORKER] compute failed:', e?.message || e);
    }

    // 4) Final payload
    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      market,
      holdersTop20,
      top10CombinedPct,
      burnedPct,
      holdersCount,
      first20Buyers,
      creator: { address: creatorAddr, percent: creatorPercent },
      // carry chain in payload for UI if you ever want to show it
      _chain: { ds: dsChain, es: esChain }
    };

    // 5) Cache
    try {
      await setJSON(sumKey, payload, 180);
      await setJSON(gateKey, { ts: Date.now() }, 600);
      console.log('[WORKER] cached', sumKey, 'ttl=180s', 'elapsed', (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('[WORKER] cache write failed:', e?.message || e);
    }

    console.log('[WORKER] refreshToken done', ca, 'ds=', dsChain);
    return payload;
  });
}

// ---------- Worker (consumer) ----------
new Worker(
  'tabs_refresh',
  async (job) => {
    const ca = job.data?.tokenAddress;
    const dsChain = job.data?.dsChain || 'abstract';
    const esChain = job.data?.esChain || ES_CHAIN_DEFAULT;
    console.log('[WORKER] job received:', job.name, job.id, ca, 'ds=', dsChain, 'es=', esChain);
    try {
      const res = await refreshToken(ca, { dsChain, esChain });
      console.log('[WORKER] job OK:', job.id);
      return res;
    } catch (e) {
      console.log('[WORKER] job FAIL:', job.id, e?.message || e);
      throw e;
    }
  },
  { connection: bullRedis }
);