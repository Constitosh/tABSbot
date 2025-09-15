// src/indexWorker.js
import './configEnv.js';
import axios from 'axios';
import { getJSON, setJSON, withLock } from './cache.js';

/**
 * Keys:
 *   token:${ca}:index:data      -> the computed index snapshot (6h TTL)
 *   token:${ca}:index:queued    -> simple flag to avoid duplicate queues (short TTL)
 */

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[INDEX] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// ---- throttle (same as elsewhere) ----
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
async function esGET(params, { tag='' } = {}) {
  await throttleES();
  const tries = 3;
  for (let i = 1; i <= tries; i++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Etherscan v2 error';
      if (i === tries) throw new Error(msg);
    } catch (e) {
      if (i === tries) throw e;
    }
    await new Promise(r => setTimeout(r, 250*i));
  }
}

// ---- helpers ----
const TOPIC_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([ZERO, '0x000000000000000000000000000000000000dEaD', '0x000000000000000000000000000000000000dead'].map(s=>s.toLowerCase()));
const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

async function getCreationBlock(token) {
  try {
    const r = await esGET({ module:'contract', action:'getcontractcreation', contractaddresses: token }, { tag:'creatorBlock' });
    const first = Array.isArray(r) ? r[0] : r;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await esGET({ module:'account', action:'tokentx', contractaddress: token, page:1, offset:1, sort:'asc' }, { tag:'firstTx' });
    const n = Number((Array.isArray(r) && r[0]?.blockNumber) || r?.blockNumber);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 0;
}
async function getLatestBlock() {
  try {
    const ts = Math.floor(Date.now()/1000);
    const r = await esGET({ module:'block', action:'getblocknobytime', timestamp:ts, closest:'before' }, { tag:'latestBlock' });
    const n = Number(r?.blockNumber || r?.BlockNumber || r);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 9_223_372_036;
}
async function getAllTransferLogs(token, { fromBlock, toBlock, window=200_000, offset=1000 } = {}) {
  const all = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + window, toBlock);
    for (let page = 1; ; page++) {
      const params = {
        module:'logs', action:'getLogs', address:token,
        topic0: TOPIC_TRANSFER, fromBlock:start, toBlock:end, page, offset
      };
      let batch;
      try {
        batch = await esGET(params, { tag:`logs ${start}-${end}` });
      } catch (e) {
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < offset) break;
    }
    start = end + 1;
  }
  all.sort((a,b)=>{
    const ba = Number(a.blockNumber||0), bb = Number(b.blockNumber||0);
    if (ba !== bb) return ba - bb;
    const ia = Number(a.logIndex||0), ib = Number(b.logIndex||0);
    return ia - ib;
  });
  return all;
}
async function getTokenTotalSupply(token) {
  const r = await esGET({ module:'stats', action:'tokensupply', contractaddress: token }, { tag:'supply' });
  return String(r || '0');
}

// Build full balances map from logs
function balancesFromLogs(logs) {
  const m = new Map();
  for (const lg of logs) {
    const from = topicToAddr(lg.topics[1]);
    const to   = topicToAddr(lg.topics[2]);
    const val  = toBig(lg.data);
    if (!DEAD.has(from)) m.set(from, (m.get(from) || 0n) - val);
    if (!DEAD.has(to))   m.set(to,   (m.get(to)   || 0n) + val);
  }
  for (const [a,v] of m) if (v <= 0n) m.delete(a);
  return m;
}

// ---------- PUBLIC: queue + compute ----------
export async function ensureIndexSnapshot(ca) {
  const token = String(ca||'').toLowerCase();
  const dataKey   = `token:${token}:index:data`;
  const queuedKey = `token:${token}:index:queued`;

  const cached = await getJSON(dataKey);
  if (cached) return { ready:true, data: cached };

  // if already queued recently, don't re-queue
  const already = await getJSON(queuedKey);
  if (already) return { ready:false };

  await setJSON(queuedKey, { ts: Date.now() }, 300); // 5 min "queued" flag
  // fire and forget compute (don’t block bot)
  computeIndexSnapshot(token).catch(e => console.warn('[INDEX] compute failed', token, e?.message || e));
  return { ready:false };
}

export async function computeIndexSnapshot(token) {
  const ca = String(token||'').toLowerCase();
  const dataKey   = `token:${ca}:index:data`;
  const lockKey   = `lock:index:${ca}`;

  return withLock(lockKey, 120, async () => {
    // guard: maybe another worker filled it
    const cached = await getJSON(dataKey);
    if (cached) return cached;

    const t0 = Date.now();
    console.log('[INDEX] compute start', ca);

    // bounds
    const [fromBlock, toBlock] = await Promise.all([getCreationBlock(ca), getLatestBlock()]);
    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock<=0 || toBlock<=0 || toBlock<fromBlock) {
      throw new Error('bad block range');
    }

    // logs + supply
    const [logs, supplyRaw] = await Promise.all([
      getAllTransferLogs(ca, { fromBlock, toBlock, window:200_000, offset:1000 }),
      getTokenTotalSupply(ca),
    ]);

    const supply = toBig(supplyRaw || '0');
    const balances = balancesFromLogs(logs);
    const rows = [...balances.entries()]
      .map(([addr, bal]) => [addr, bal > 0n ? bal : 0n])
      .filter(([,bal]) => bal > 0n)
      .sort((A,B)=> (B[1] > A[1] ? 1 : (B[1] < A[1] ? -1 : 0)));

    const holdersCount = rows.length;

    // percent per holder
    const holdersAllPerc = supply > 0n
      ? rows.map(([,bal]) => Number((bal * 1000000n) / supply) / 10000) // 4 dp
      : [];

    // top20 + top10 combined
    const top20 = rows.slice(0,20).map(([address,bal]) => {
      const pct = supply > 0n ? Number((bal * 1000000n)/supply)/10000 : 0;
      return { address, balance: bal.toString(), percent: +pct.toFixed(4) };
    });
    const top10CombinedPct = +top20.slice(0,10).reduce((a,h)=>a+(h.percent||0),0).toFixed(4);

    // simple Gini
    const sorted = holdersAllPerc.slice().sort((a,b)=>a-b);
    const n = sorted.length;
    let gini = 0;
    if (n > 1) {
      let cum = 0;
      for (let i=0;i<n;i++) cum += (i+1) * sorted[i];
      const mean = sorted.reduce((a,b)=>a+b,0)/n;
      if (mean > 0) gini = (2*cum)/(n*sorted.reduce((a,b)=>a+b,0)) - (n+1)/n;
      gini = Math.max(0, Math.min(1, gini));
    }

    const payload = {
      tokenAddress: ca,
      computedAt: Date.now(),
      holdersCount,
      holdersTop20: top20,
      top10CombinedPct,
      holdersAllPerc,     // array of percents (0..100)
      totalSupply: supplyRaw,
      gini: +gini.toFixed(4),
      fromBlock,
      toBlock,
      ttlSeconds: 6*3600
    };

    await setJSON(dataKey, payload, 6*3600); // cache 6h
    console.log('[INDEX] compute done', ca, 'holders=', holdersCount, 'elapsed=', (Date.now()-t0)+'ms');
    return payload;
  });
}
