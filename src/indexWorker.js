// src/indexWorker.js
import './configEnv.js';
import axios from 'axios';
import { setJSON, getJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

/* -------------------- Config -------------------- */

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract

if (!ES_KEY) console.warn('[INDEX] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });
const httpDS = axios.create({ timeout: 15_000 });

/* ---- Etherscan throttling (RPS) ---- */
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
async function esGET(params, { tag = '' } = {}) {
  await throttleES();
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Etherscan v2 error';
      if (i === attempts) throw new Error(msg);
    } catch (e) {
      if (i === attempts) throw e;
    }
    await new Promise(r => setTimeout(r, 250 * i));
  }
}

/* -------------------- Helpers -------------------- */

const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

function toNum(raw, decimals = 18) {
  try {
    const bi = toBig(raw);
    const d  = BigInt(Math.max(0, Number(decimals || 18)));
    if (d === 0n) return Number(bi);
    const base  = 10n ** d;
    const whole = bi / base;
    const frac  = Number(bi % base) / Number(base);
    return Number(whole) + frac;
  } catch { return 0; }
}

function giniFromArray(values) {
  const arr = values.filter(v => Number(v) > 0).slice().sort((a,b)=>a-b);
  const n = arr.length;
  if (!n) return 0;
  const sum = arr.reduce((a,b)=>a+b,0);
  if (sum === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i+1) * arr[i];
  const mean = sum / n;
  const g = 1 + (1/n) - (2 * cum) / (n * n * mean);
  return Math.max(0, Math.min(1, g));
}
function bar10(fraction) {
  const p = Math.max(0, Math.min(1, Number(fraction)));
  const filled = Math.round(p * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}

/* -------------------- Dexscreener helpers -------------------- */

async function getDexPairAddresses(ca) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
    const { data } = await httpDS.get(url);
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const abstractPairs = pairs.filter(p => p?.chainId === 'abstract');
    const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

    const ammCandidates = abstractPairs.filter(p => !isMoon(p));
    ammCandidates.sort((a, b) => {
      const vA = Number(a?.volume?.h24 || 0), vB = Number(b?.volume?.h24 || 0);
      if (vB !== vA) return vB - vA;
      const lA = Number(a?.liquidity?.usd || 0), lB = Number(b?.liquidity?.usd || 0);
      return lB - lA;
    });

    const bestAMM = ammCandidates[0] || null;
    const moon    = abstractPairs.find(isMoon) || null;

    return {
      ammPair: bestAMM?.pairAddress ? String(bestAMM.pairAddress).toLowerCase() : null,
      launchPadPair: moon?.pairAddress ? String(moon.pairAddress) : null,
    };
  } catch {
    return { ammPair: null, launchPadPair: null };
  }
}

/* -------------------- Etherscan bits we need -------------------- */

async function getCreationBlock(token) {
  // try contract creation, then fallback to first tokentx asc
  try {
    const r = await esGET({ module:'contract', action:'getcontractcreation', contractaddresses: token });
    const first = Array.isArray(r) ? r[0] : r;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await esGET({ module:'account', action:'tokentx', contractaddress: token, page: 1, offset: 1, sort: 'asc' });
    const n = Number((Array.isArray(r) && r[0]?.blockNumber) || r?.blockNumber);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 0;
}
async function getLatestBlock() {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const r = await esGET({ module:'block', action:'getblocknobytime', timestamp: ts, closest:'before' });
    const n = Number(r?.blockNumber || r?.BlockNumber || r);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 9_223_372_036;
}

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
      let batch;
      try {
        batch = await esGET(params);
      } catch (e) {
        break; // stop paging this window
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < offset) break;
    }

    start = end + 1;
    windows++;
    if (windows >= maxWindows) break;
  }
  return all;
}

function buildBalancesFromLogs(logs) {
  const balances = new Map();
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

/* -------------------- Snapshot builder (filtered) -------------------- */

const SUPPLY_BUCKETS = [
  { label: '<0.01%', lt: 0.01 },
  { label: '<0.05%', lt: 0.05 },
  { label: '<0.10%', lt: 0.10 },
  { label: '<0.50%', lt: 0.50 },
  { label: '<1.00%', lt: 1.00 },
  { label: '≥1.00%', gte: 1.00 },
];

const VALUE_BUCKETS = [
  { label: '$0–$10',      lt: 10 },
  { label: '$10–$50',     lt: 50 },
  { label: '$50–$100',    lt: 100 },
  { label: '$100–$250',   lt: 250 },
  { label: '$250–$1,000', lt: 1000 },
  { label: '$1,000+',     gte: 1000 },
];

function buildFilteredSnapshot({ balances, meta, priceUsd }) {
  const token = String(meta.tokenAddress).toLowerCase();
  const ex = new Set([...DEAD]);
  if (meta.ammPair) ex.add(String(meta.ammPair).toLowerCase());
  if (meta.isMoonshot && Number(meta.moonProgress||0) > 0 && Number(meta.moonProgress||0) < 100) {
    ex.add(token);
  }

  const rows = [];
  for (const [addr, balRaw] of balances.entries()) {
    const a = String(addr).toLowerCase();
    if (balRaw <= 0n) continue;
    if (ex.has(a)) continue;
    rows.push([a, balRaw]);
  }

  const holdersCount = rows.length;

  // Effective supply = sum of included balances
  let effRaw = 0n;
  for (const [, b] of rows) effRaw += b;
  const effNum = effRaw > 0n ? toNum(effRaw, meta.decimals || 18) : 0;

  // Fractions for each included holder
  const fracs = rows.map(([, b]) => {
    const q = toNum(b, meta.decimals || 18);
    return effNum > 0 ? (q / effNum) : 0;
  });

  // Top-10 combined %
  const top10 = fracs.slice().sort((a,b)=>b-a).slice(0,10).reduce((acc,x)=>acc+x,0);
  const top10Pct = Math.round(top10 * 10000) / 100; // percent with 2 dp

  // Gini
  const gini = Math.round(giniFromArray(fracs) * 10000) / 10000;

  // Supply distribution buckets
  const supplyDist = SUPPLY_BUCKETS.map(b => ({ ...b, count: 0 }));
  for (const f of fracs) {
    const pc = f * 100;
    let placed = false;
    for (let i = 0; i < supplyDist.length; i++) {
      const B = supplyDist[i];
      if (B.lt != null && pc < B.lt) { B.count++; placed = true; break; }
      if (B.gte != null && pc >= B.gte) { B.count++; placed = true; break; }
    }
    if (!placed && supplyDist.length) supplyDist[supplyDist.length - 1].count++;
  }

  // Value distribution buckets
  const valueDist = VALUE_BUCKETS.map(b => ({ ...b, count: 0 }));
  const px = Number(priceUsd || 0);
  if (px > 0) {
    for (const [, bal] of rows) {
      const qty = toNum(bal, meta.decimals || 18);
      const usd = qty * px;
      let placed = false;
      for (let i = 0; i < valueDist.length; i++) {
        const B = valueDist[i];
        if (B.lt != null && usd < B.lt) { B.count++; placed = true; break; }
        if (B.gte != null && usd >= B.gte) { B.count++; placed = true; break; }
      }
      if (!placed && valueDist.length) valueDist[valueDist.length - 1].count++;
    }
  } else {
    valueDist[0].count = holdersCount;
  }

  // Bars normalized to the included holder base
  const fill = (count) => bar10(holdersCount > 0 ? (count / holdersCount) : 0);

  const supplyOut = supplyDist.map(b => ({
    label: b.label, count: b.count, bar: fill(b.count)
  }));
  const valueOut = valueDist.map(b => ({
    label: b.label, count: b.count, bar: fill(b.count)
  }));

  return {
    holdersCount,
    top10CombinedPct: top10Pct,
    gini,
    supplyDist: supplyOut,
    valueDist: valueOut,
  };
}

/* -------------------- Public API -------------------- */

// Builds (or returns cached) Index for a token.
// Cache key: index:<ca>:v2  TTL: 6h
export async function refreshIndex(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  const cacheKey = `index:${ca}:v2`;
  const cached = await getJSON(cacheKey);
  if (cached && cached.data) return cached;

  // Lock to prevent duplicate heavy builds
  return withLock(`lock:index:${ca}`, 180, async () => {
    // Check cache again inside lock
    const again = await getJSON(cacheKey);
    if (again && again.data) return again;

    const t0 = Date.now();
    console.log('[INDEX] build start', ca);

    // 1) Market: Dexscreener (price + moonshot info)
    let priceUsd = 0;
    let isMoonshot = false;
    let moonProgress = 0;
    try {
      const { summary } = await getDexscreenerTokenStats(ca);
      priceUsd = Number(summary?.priceUsd || 0);
      isMoonshot = !!(summary?.launchPadPair || summary?.moonshot || String(summary?.dexId||'').toLowerCase() === 'moonshot');
      moonProgress = Number(summary?.moonshot?.progress || 0);
    } catch (e) {
      console.warn('[INDEX] Dexscreener fail:', e?.message || e);
    }

    // 2) Pairs (to exclude AMM LP)
    let ammPair = null;
    try {
      const pairInfo = await getDexPairAddresses(ca);
      ammPair = pairInfo.ammPair || null;
    } catch {}

    // 3) Blocks & logs
    let logs = [];
    let decimals = 18; // best-effort default for Abstract tokens
    try {
      const [fromB, toB] = await Promise.all([ getCreationBlock(ca), getLatestBlock() ]);
      logs = await getAllTransferLogs(ca, { fromBlock: Math.max(0, fromB - 1), toBlock: toB, window: 200_000, offset: 1000 });
      // sort
      logs.sort((a,b) => {
        const ba = Number(a.blockNumber||0), bb = Number(b.blockNumber||0);
        if (ba !== bb) return ba - bb;
        const ia = Number(a.logIndex||0), ib = Number(b.logIndex||0);
        return ia - ib;
      });
    } catch (e) {
      console.warn('[INDEX] logs fail:', e?.message || e);
    }

    // 4) Balances
    const balances = buildBalancesFromLogs(logs);

    // 5) Snapshot (filtered)
    const snap = buildFilteredSnapshot({
      balances,
      meta: {
        tokenAddress: ca,
        decimals,
        ammPair,
        isMoonshot,
        moonProgress,
      },
      priceUsd
    });

    const payload = {
      tokenAddress: ca,
      updatedAt: Date.now(),
      inputs: {
        priceUsd, ammPair, isMoonshot, moonProgress
      },
      data: snap
    };

    // Cache ~6h
    try {
      await setJSON(cacheKey, payload, 6 * 60 * 60);
      console.log('[INDEX] built & cached', ca, 'in', (Date.now() - t0) + 'ms');
    } catch (e) {
      console.warn('[INDEX] cache write fail:', e?.message || e);
    }

    return payload;
  });
}

// --- adapter so bot.js can import ensureIndexSnapshot ---
export async function ensureIndexSnapshot(tokenAddress, { force = false } = {}) {
  // If you already have caching inside refreshIndex, this simply forwards the call.
  // The `force` flag is here in case you later want to bypass cache.
  return await refreshIndex(tokenAddress, { force });
}

// Keep whatever else you export:
export { refreshIndex }; // if not already exported somewhere above




