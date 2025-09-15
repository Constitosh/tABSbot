// src/refreshWorker.js
// Sources:
//  • Market + creator: Dexscreener (pair + /tokens/v1/<chain>/<CA> for creator)
//  • On-chain math: Etherscan V2 (logs.getLogs, account.tokentx, stats.tokensupply, account.tokenbalance)
// Queue: BullMQ

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';

import { setJSON, withLock, getJSON } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { chainKey } from './chains.js';

// ---------- Redis / BullMQ ----------
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
export const queueName = 'tabs_refresh';
export const queue = new Queue(queueName, { connection: bullRedis });

// ---------- Etherscan V2 client ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || process.env.ETHERSCAN_V2_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY || '';
if (!ES_KEY) console.warn('[WORKER BOOT] ETHERSCAN_API_KEY is missing');
const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// ---------- Etherscan rate limit ----------
const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 5));
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS);
let esLastTs = 0;
let esChainPromise = Promise.resolve();
async function throttleES() {
  await (esChainPromise = esChainPromise.then(async () => {
    const wait = Math.max(0, esLastTs + ES_MIN_INTERVAL - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    esLastTs = Date.now();
  }));
}
function esParams(params, esChainId) {
  return { params: { chainid: String(esChainId), apikey: ES_KEY, ...params } };
}
function esURL(params, esChainId) {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: String(esChainId), apikey: ES_KEY, ...params }).forEach(([k,v]) => u.searchParams.set(k, String(v)));
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
      const msg = data?.result || data?.message || 'Etherscan v2 error:';
      if (attempt === maxAttempts) throw new Error(msg);
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

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

// ---------- Dexscreener helpers ----------
async function getDexCreator(ca, dsChain) {
  // Dexscreener has a token details endpoint on some chains; if not available, fall back to contract creation.
  try {
    const url = `https://api.dexscreener.com/tokens/v1/${dsChain}/${ca}`;
    const { data } = await axios.get(url, { timeout: 12_000 });
    if (data?.creator) return String(data.creator).toLowerCase();
    if (Array.isArray(data) && data[0]?.creator) return String(data[0].creator).toLowerCase();
  } catch {}
  return null;
}

// ---------- Discover block bounds ----------
async function getCreationBlock(token, esChainId) {
  try {
    const res = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      esChainId,
      { logOnce: true, tag: '[creatorBlock]' }
    );
    const first = Array.isArray(res) ? res[0] : res;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await esGET(
      { module: 'account', action: 'tokentx', contractaddress: token, page: 1, offset: 1, sort: 'asc' },
      esChainId,
      { logOnce: true, tag: '[firstTx]' }
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
      esChainId,
      { logOnce: true, tag: '[latestBlock]' }
    );
    const n = Number(r?.blockNumber || r?.BlockNumber || r);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 9_223_372_036;
}

// ---------- Windowed Transfer log crawler (holders math) ----------
async function getAllTransferLogs(token, esChainId, {
  fromBlock,
  toBlock,
  window = 200_000,
  offset = 1000,
  maxWindows = 300,
} = {}) {
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
          batch = await esGET(params, esChainId, { logOnce: page === 1 && attempt === 1, tag: `[logs ${start}-${end}]` });
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

// ---------- Etherscan helpers ----------
async function getTokenTotalSupply(token, esChainId) {
  return String(await esGET(
    { module: 'stats', action: 'tokensupply', contractaddress: token },
    esChainId,
    { logOnce: true, tag: '[supply]' }
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

// ---------- Main refresh ----------
export async function refreshToken(tokenAddress, dsChain = 'abstract', esChainId = '2741') {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);
  const ck = chainKey(dsChain);

  const lockKey = `lock:refresh:${ck}:${ca}`;
  return withLock(lockKey, 60, async () => {
    const t0 = Date.now();
    console.log('[WORKER] refreshToken start', dsChain, esChainId, ca);

    // 1) Dexscreener (market + pair + creator)
    let market = null;
    let ammPair = null;
    let launchPadPair = null;
    let creatorAddr = null;
    let isMoonshot = false;

    try {
      const { summary } = await getDexscreenerTokenStats(ca, dsChain);
      market = summary || null;

      // choose pair + classify "moonshot"
      if (market) {
        ammPair       = market.pairAddress || null;
        launchPadPair = market.launchPadPair || null;
        isMoonshot =
          !!market.launchPadPair ||
          String(market?.dexId || '').toLowerCase() === 'moonshot' ||
          !!market?.moonshot;

        // try get creator via DS token endpoint (fallback to contract creation if null later)
        creatorAddr = await getDexCreator(ca, dsChain);
      }
      console.log('[WORKER] Dex ok', ca, 'ammPair=', ammPair, 'moonPair=', launchPadPair, 'creator=', creatorAddr || 'unknown');
    } catch (e) {
      console.log('[WORKER] Dexscreener failed:', e?.message || e);
    }

    // 2) Etherscan pulls
    let logs = [];
    let totalSupplyRaw = '0';
    try {
      const [creationBlock, latestBlock] = await Promise.all([
        getCreationBlock(ca, esChainId),
        getLatestBlock(esChainId),
      ]);
      const fromB = Math.max(0, creationBlock - 1);
      const toB   = latestBlock;

      console.log('[WORKER] range', ca, fromB, '→', toB);

      [logs, totalSupplyRaw] = await Promise.all([
        getAllTransferLogs(ca, esChainId, { fromBlock: fromB, toBlock: toB, window: 200_000, offset: 1000 }),
        getTokenTotalSupply(ca, esChainId),
      ]);
      console.log('[WORKER] pulls ok', 'logs=', logs.length, 'supply=', totalSupplyRaw);
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

    try {
      const balances = buildBalancesFromLogs(logs);
      const supply = toBig(totalSupplyRaw || '0');

      // burned
      let burned = 0n;
      for (const lg of logs) {
        const to = topicToAddr(lg.topics[2]);
        if (DEAD.has(to)) burned += toBig(lg.data);
      }
      burnedPct = supply > 0n ? Number((burned * 1000000n) / supply) / 10000 : 0;

      // exclude AMM pool and token CA (during moonshot) from top holders
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
      creator: { address: creatorAddr || null }
    };

    // 5) Cache (per-chain key space)
    const sumKey  = `token:${ck}:${ca}:summary`;
    const gateKey = `token:${ck}:${ca}:last_refresh`;
    try {
      await setJSON(sumKey, payload, 180);
      await setJSON(gateKey, { ts: Date.now() }, 600);
      console.log('[WORKER] cached', sumKey, 'ttl=180s', 'elapsed', (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('[WORKER] cache write failed:', e?.message || e);
    }

    console.log('[WORKER] refreshToken done', dsChain, ca);
    return payload;
  });
}

// ---------- Worker (consumer) ----------
new Worker(
  queueName,
  async (job) => {
    const ca      = job.data?.tokenAddress;
    const dsChain = job.data?.dsChain || 'abstract';
    const esChain = job.data?.esChain || '2741';
    if (!ca) throw new Error('tokenAddress missing in job.data');
    console.log('[WORKER] job received:', job.name, job.id, dsChain, esChain, ca);
    const res = await refreshToken(ca, dsChain, esChain);
    console.log('[WORKER] job OK:', job.id);
    return res;
  },
  { connection: bullRedis }
);

// ---------- Optional cron refresher ----------
if (process.argv.includes('--cron') && process.env.DEFAULT_TOKENS) {
  const list = process.env.DEFAULT_TOKENS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) {
    console.log('[CRON] Refreshing tokens every 120s (Abstract):', list.join(', '));
    setInterval(async () => {
      for (const ca of list) {
        try {
          await queue.add('refresh', { tokenAddress: ca, dsChain: 'abstract', esChain: '2741' }, { removeOnComplete: true, removeOnFail: true });
        } catch (e) {
          console.error('[CRON] Enqueue failed for', ca, e?.message || e);
        }
      }
    }, 120_000);
  }
}