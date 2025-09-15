import 'dotenv/config';
import axios from 'axios';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import * as cache from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import chains from '../chains.js';

// Etherscan V2 client
const ES_BASE = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract
if (!ES_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY is missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });
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
  Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k, v]) => u.searchParams.set(k, String(v)));
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
      if (attempt === maxAttempts) throw new Error(`Etherscan V2 error: ${msg}`);
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
}

// Constants
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead'
].map(s => s.toLowerCase()));

const BANNED = new Set(['0x0d6848e39114abe69054407452b8aab82f8a44ba'].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

// Dexscreener helpers
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

async function getDexPairAddresses(ca, chain) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
    const { data } = await axios.get(url, { timeout: 15_000 });
    const dsPairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const chainId = chains[chain]?.chainId?.toString() || 'abstract';
    const chainPairs = dsPairs.filter(p => p?.chainId === chainId);
    const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

    const ammCandidates = chainPairs.filter(p => !isMoon(p));
    ammCandidates.sort((a, b) => {
      const vA = Number(a?.volume?.h24 || 0), vB = Number(b?.volume?.h24 || 0);
      return vB !== vA ? vB - vA : Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0);
    });
    const bestAMM = ammCandidates[0] || null;
    const moon = chainPairs.find(isMoon) || null;
    return {
      ammPair: bestAMM?.pairAddress ? String(bestAMM.pairAddress).toLowerCase() : null,
      launchPadPair: moon?.pairAddress ? String(moon.pairAddress).toLowerCase() : null
    };
  } catch {
    return { ammPair: null, launchPadPair: null };
  }
}

// Etherscan helpers
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
  return 9223372036;
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

async function getTokenTotalSupply(token) {
  try {
    return String(await esGET(
      { module: 'stats', action: 'tokensupply', contractaddress: token },
      { logOnce: true, tag: '[supply]' }
    ));
  } catch {
    return '0';
  }
}

async function getCreatorTokenBalance(token, creator) {
  if (!creator) return '0';
  try {
    return String(await esGET(
      { module: 'account', action: 'tokenbalance', contractaddress: token, address: creator, tag: 'latest' },
      { logOnce: true, tag: '[creatorBalance]' }
    ));
  } catch {
    return '0';
  }
}

async function getAllTransferLogs(token, { fromBlock, toBlock, window = 200_000, offset = 1000, maxWindows = 300 } = {}) {
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
        offset
      };
      let batch = null;
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          batch = await esGET(params, { logOnce: page === 1 && attempt === 1, tag: `[logs ${start}-${end}]` });
          ok = true;
          break;
        } catch (e) {
          if (attempt === 3) console.warn(`[ESV2] window ${start}-${end} page ${page} failed: ${e.message}`);
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
      console.warn(`[ESV2] window cap hit (${maxWindows}); stopping at block ${end}`);
      break;
    }
  }
  if (failedWindows) console.warn(`[ESV2] getLogs had ${failedWindows} failed window(s)`);
  return all;
}

async function fetchEarliestTokentxAsc(token, { pages = 20, offset = 200 } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const params = {
      module: 'account',
      action: 'tokentx',
      contractaddress: token,
      page,
      offset,
      sort: 'asc'
    };
    let batch;
    try {
      batch = await esGET(params, { logOnce: page === 1, tag: '[tokentx-asc]' });
    } catch (e) {
      console.warn('[ESV2] tokentx page failed', page, e.message);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < offset) break;
  }
  return out;
}

function buildBalancesFromLogs(logs) {
  const balances = new Map();
  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to = topicToAddr(lg.topics[2]);
    const val = toBig(lg.data);
    if (!DEAD.has(from)) balances.set(from, (balances.get(from) || 0n) - val);
    if (!DEAD.has(to)) balances.set(to, (balances.get(to) || 0n) + val);
  }
  for (const [a, v] of balances) if (v <= 0n) balances.delete(a);
  return balances;
}

function computeTopHolders(balances, totalSupplyBigInt, { exclude = [] } = {}) {
  const ex = new Set((exclude || []).map(s => String(s || '').toLowerCase()));
  const rows = [];
  for (const [addr, bal] of balances.entries()) {
    const a = addr.toLowerCase();
    if (bal <= 0n || ex.has(a) || BANNED.has(a)) continue;
    rows.push([a, bal]);
  }
  rows.sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const top20 = rows.slice(0, 20).map(([address, bal]) => ({
    address,
    balance: bal.toString(),
    percent: totalSupplyBigInt > 0n ? Number((bal * 1000000n) / totalSupplyBigInt) / 10000 : 0
  }));
  const top10CombinedPct = top20.slice(0, 10).reduce((acc, h) => acc + (h.percent || 0), 0);
  return { holdersTop20: top20, top10CombinedPct, holdersCount: rows.length };
}

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
    if (!to || DEAD.has(to) || (pair && to === pair) || (excludeTokenAsPool && to === ca) || BANNED.has(to)) return false;
    if (!firstSeen.has(to)) {
      let amt = 0n;
      try { amt = toBig(tx.value || '0'); } catch {}
      firstSeen.set(to, {
        firstBuyAmt: amt,
        blockNumber: Number(tx.blockNumber || 0),
        logIndex: Number(tx.logIndex || 0)
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

  return ordered.slice(0, 20);
}

function first20BuyersFromLogs(logsAsc, { tokenAddress, creator, pairAddress, excludeTokenAsPool = false }, balances) {
  if (!Array.isArray(logsAsc) || logsAsc.length === 0 || !creator) return [];
  const ca = String(tokenAddress).toLowerCase();
  const creatorAddr = String(creator).toLowerCase();
  const pair = pairAddress ? String(pairAddress).toLowerCase() : null;

  let startIdx = -1;
  for (let i = 0; i < logsAsc.length; i++) {
    const to = topicToAddr(logsAsc[i].topics[2]);
    if (to === creatorAddr) { startIdx = i; break; }
  }
  if (startIdx < 0) return [];

  const firstSeen = new Map();
  const addIfEligible = (lg) => {
    const to = topicToAddr(lg.topics[2]);
    if (DEAD.has(to) || (pair && to === pair) || (excludeTokenAsPool && to === ca) || BANNED.has(to)) return false;
    if (!firstSeen.has(to)) {
      const amt = toBig(lg.data);
      firstSeen.set(to, {
        firstBuyAmt: amt,
        blockNumber: Number(lg.blockNumber || 0),
        logIndex: Number(lg.logIndex || 0)
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

  return ordered.slice(0, 20);
}

// Redis / BullMQ
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});
redis.on('connect', () => console.log('Worker: Redis connected'));
redis.on('error', (err) => console.error('Worker: Redis error:', err.message));

export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: redis });

export async function refreshToken(tokenAddress, chain = 'abstract') {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  const lockKey = `lock:refresh:${chain}:${ca}`;
  return cache.withLock(lockKey, 60, async () => {
    console.log('[WORKER] refreshToken start', ca, chain);

    let market = null;
    let ammPair = null;
    let launchPadPair = null;
    let creatorAddr = null;
    let isMoonshot = false;

    try {
      const { summary } = await getDexscreenerTokenStats(ca, chain);
      market = summary || null;
      const pairInfo = await getDexPairAddresses(ca, chain);
      ammPair = pairInfo.ammPair || null;
      launchPadPair = pairInfo.launchPadPair || null;
      if (market) {
        market.pairAddress = ammPair || market.pairAddress || null;
        market.launchPadPair = launchPadPair || null;
      }
      creatorAddr = await getDexCreator(ca);
      isMoonshot = !!market?.launchPadPair || String(market?.dexId || '').toLowerCase() === 'moonshot' || !!market?.moonshot;
      if (!creatorAddr && market?.moonshot?.creator && /^0x[a-fA-F0-9]{40}$/.test(market.moonshot.creator)) {
        creatorAddr = String(market.moonshot.creator).toLowerCase();
      }
      console.log('[WORKER] Dex ok', ca, 'ammPair=', ammPair, 'moonPair=', launchPadPair, 'creator=', creatorAddr || 'unknown');
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e.message);
    }

    let logs = [];
    let totalSupplyRaw = '0';
    let creatorBalRaw = '0';
    let earlyTokentx = [];
    try {
      if (chain !== 'abstract') throw new Error('Etherscan only used for Abstract (2741)');
      const [creationBlock, latestBlock] = await Promise.all([
        getCreationBlock(ca),
        getLatestBlock()
      ]);
      const fromB = Math.max(0, creationBlock - 1);
      const toB = latestBlock;
      console.log('[WORKER] range', ca, fromB, '→', toB);
      [logs, totalSupplyRaw, earlyTokentx] = await Promise.all([
        getAllTransferLogs(ca, { fromBlock: fromB, toBlock: toB, window: 200_000, offset: 1000 }),
        getTokenTotalSupply(ca),
        fetchEarliestTokentxAsc(ca, { pages: 20, offset: 200 })
      ]);
      if (creatorAddr) creatorBalRaw = await getCreatorTokenBalance(ca, creatorAddr);
      console.log('[WORKER] pulls ok', 'logs=', logs.length, 'tokentxEarly=', earlyTokentx.length, 'supply=', totalSupplyRaw);
    } catch (e) {
      console.log('[WORKER] ESV2 failed:', e.message);
      creatorAddr = creatorAddr || await getDexCreator(ca); // Fallback to Dexscreener
    }

    logs.sort((a, b) => {
      const ba = Number(a.blockNumber || 0), bb = Number(b.blockNumber || 0);
      if (ba !== bb) return ba - bb;
      return Number(a.logIndex || 0) - Number(b.logIndex || 0);
    });

    let holdersTop20 = [];
    let holdersCount = null;
    let top10CombinedPct = 0;
    let burnedPct = 0;
    let first20Buyers = [];
    let creatorPercent = 0;

    try {
      const balances = buildBalancesFromLogs(logs);
      const supply = toBig(totalSupplyRaw || '0');
      let burned = 0n;
      for (const lg of logs) {
        const to = topicToAddr(lg.topics[2]);
        if (DEAD.has(to)) burned += toBig(lg.data);
      }
      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      const excludeList = [];
      if (ammPair) excludeList.push(String(ammPair).toLowerCase());
      const moonProg = Number(market?.moonshot?.progress || 0);
      const excludeTokenAsPool = isMoonshot && moonProg > 0 && moonProg < 100;
      if (excludeTokenAsPool) excludeList.push(ca);

      const holders = computeTopHolders(balances, supply, { exclude: excludeList });
      holdersTop20 = holders.holdersTop20;
      top10CombinedPct = holders.top10CombinedPct;
      holdersCount = holders.holdersCount;

      let creatorBal = 0n;
      try { creatorBal = toBig(creatorBalRaw || '0'); } catch {}
      if (creatorBal === 0n && creatorAddr) creatorBal = balances.get(creatorAddr.toLowerCase()) || 0n;
      creatorPercent = supply > 0n ? Number((creatorBal * 1000000n) / supply) / 10000 : 0;

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

      console.log('[WORKER] compute sizes', 'balances=', balances.size, 'holdersTop20=', holdersTop20?.length || 0, 'buyers=', first20Buyers?.length || 0);
    } catch (e) {
      console.log('[WORKER] compute failed:', e.message);
    }

    const payload = {
      tokenAddress: ca,
      chain,
      updatedAt: Date.now(),
      market,
      holdersTop20,
      top10CombinedPct,
      burnedPct,
      holdersCount,
      first20Buyers,
      creator: { address: creatorAddr || '0x0', percent: creatorPercent }
    };

    const sumKey = `token:${chain}:${ca}:summary`;
    const gateKey = `token:${chain}:${ca}:last_refresh`;
    try {
      await cache.setJSON(sumKey, payload, 180);
      await cache.setJSON(gateKey, { ts: Date.now() }, 600);
      console.log('[WORKER] cached', sumKey, 'ttl=180s');
    } catch (e) {
      console.log('[WORKER] cache write failed:', e.message);
    }

    console.log('[WORKER] refreshToken done', ca, chain);
    return payload;
  });
}

new Worker('tabs_refresh', async (job) => {
  const { tokenAddress, chain = 'abstract' } = job.data;
  console.log('[WORKER] job received:', job.name, job.id, tokenAddress, chain);
  try {
    const res = await refreshToken(tokenAddress, chain);
    console.log('[WORKER] job OK:', job.id);
    return res;
  } catch (e) {
    console.log('[WORKER] job FAIL:', job.id, e.message);
    throw e;
  }
}, { connection: redis });

if (process.env.CRON === 'true' && process.env.DEFAULT_TOKENS) {
  const defaults = process.env.DEFAULT_TOKENS.split(',').map(s => {
    const parts = s.trim().split(':');
    return { chain: parts[0] || 'abstract', tokenAddress: parts[1] };
  }).filter(d => d.tokenAddress && chains[d.chain]);
  console.log('[CRON] Refreshing tokens every 120s:', defaults.map(d => `${d.chain}:${d.tokenAddress}`).join(', '));
  setInterval(async () => {
    for (const d of defaults) {
      try {
        await queue.add('refresh', d, { removeOnComplete: true, removeOnFail: true });
      } catch (e) {
        console.error('[CRON] Enqueue failed for', d.tokenAddress, d.chain, e.message);
      }
    }
  }, 120_000);
}

console.log('Worker started');