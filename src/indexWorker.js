// src/indexWorker.js
import './configEnv.js';
import axios from 'axios';
import { getJSON, setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// ---------- Etherscan V2 ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';

if (!ES_KEY) console.warn('[INDEX] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// throttle (default 5 rps)
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
async function esGET(params) {
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
    await new Promise(r => setTimeout(r, 250 * i));
  }
}

// ---------- Helpers ----------
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([
  ZERO,
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(x => x.toLowerCase()));

const toBig = (x) => {
  try { return BigInt(String(x)); } catch { return 0n; }
};
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

async function getCreationBlock(token) {
  try {
    const res = await esGET({ module:'contract', action:'getcontractcreation', contractaddresses: token });
    const first = Array.isArray(res) ? res[0] : res;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await esGET({ module:'account', action:'tokentx', contractaddress: token, page:1, offset:1, sort:'asc' });
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
async function getAllTransferLogs(token, { fromBlock, toBlock, window = 200_000, offset = 1000 } = {}) {
  const all = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + window, toBlock);
    for (let page = 1; ; page++) {
      let batch;
      try {
        batch = await esGET({
          module:'logs', action:'getLogs', address: token, topic0: TOPIC_TRANSFER,
          fromBlock:start, toBlock:end, page, offset
        });
      } catch { break; }
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < offset) break;
    }
    start = end + 1;
  }
  return all;
}
async function getTokenTotalSupply(token) {
  const r = await esGET({ module:'stats', action:'tokensupply', contractaddress: token });
  return String(r || '0');
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

// High-precision percent (avoid zeroing tiny holders)
// percent ≈ (bal / supply) * 100 with ~1e-6 resolution
const P_SCALE = 1_000_000_000n; // 1e9 (9 decimal places before converting to %)
function balToPercent(bal, supply) {
  if (supply <= 0n || bal <= 0n) return 0;
  // ((bal * P_SCALE) / supply) gives share in 1e9; convert to % keeping 6 decimals
  const share1e9 = (bal * P_SCALE) / supply;              // 0..1e9
  const pct1e6   = (share1e9 * 1000000000n) / 1000000000n; // keep full, will convert to % as Number below
  // convert to floating % with 6 decimals
  return Number(pct1e6) * 100 / 1_000_000_000; // % with ~6+ decimals
}

// Standard Gini from raw weights (use unrounded percents)
function giniFromWeights(weights) {
  const arr = weights.map(Number).filter(x => x > 0 && Number.isFinite(x));
  const n = arr.length;
  if (n <= 1) return 0;
  const sum = arr.reduce((a,b)=>a+b,0);
  if (sum <= 0) return 0;
  arr.sort((a,b)=>a-b);
  // G = (1/(n*sum)) * sum_i ( (2i-n-1) * x_i )
  let numer = 0;
  for (let i=0;i<n;i++) numer += ( (2*(i+1) - n - 1) * arr[i] );
  const g = numer / (n * sum);
  return +Math.abs(g).toFixed(4);
}

// Bins for value dist (adaptive)
function chooseDollarBins(mcap) {
  if (!Number.isFinite(mcap) || mcap <= 0) {
    return [
      { label: '$0–$10', min: 0, max: 10 },
      { label: '$10–$50', min: 10, max: 50 },
      { label: '$50–$100', min: 50, max: 100 },
      { label: '$100–$250', min: 100, max: 250 },
      { label: '$250–$1,000', min: 250, max: 1000 },
      { label: '$1,000+', min: 1000, max: null },
    ];
  }
  if (mcap < 100_000) {
    return [
      { label: '$0–$10', min: 0, max: 10 },
      { label: '$10–$50', min: 10, max: 50 },
      { label: '$50–$100', min: 50, max: 100 },
      { label: '$100–$250', min: 100, max: 250 },
      { label: '$250–$1,000', min: 250, max: 1000 },
      { label: '$1,000+', min: 1000, max: null },
    ];
  }
  if (mcap < 1_000_000) {
    return [
      { label: '$0–$25', min: 0, max: 25 },
      { label: '$25–$100', min: 25, max: 100 },
      { label: '$100–$250', min: 100, max: 250 },
      { label: '$250–$500', min: 250, max: 500 },
      { label: '$500–$2,000', min: 500, max: 2000 },
      { label: '$2,000+', min: 2000, max: null },
    ];
  }
  return [
    { label: '$0–$50', min: 0, max: 50 },
    { label: '$50–$250', min: 50, max: 250 },
    { label: '$250–$1,000', min: 250, max: 1000 },
    { label: '$1,000–$5,000', min: 1000, max: 5000 },
    { label: '$5,000–$25,000', min: 5000, max: 25000 },
    { label: '$25,000+', min: 25000, max: null },
  ];
}

// ---------- Core snapshot ----------
export async function refreshIndexSnapshot(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error('Bad contract');

  // 1) Dexscreener (LP/CA hints + mcap)
  let market = null;
  let ammPair = null;
  try {
    const { summary } = await getDexscreenerTokenStats(ca);
    market = summary || null;
    if (market?.pairs && Array.isArray(market.pairs)) {
      const abs = market.pairs.filter(p => p?.chainId === 'abstract');
      abs.sort((a,b)=>(
        (Number(b?.liquidity?.usd || 0) + Number(b?.volume?.h24 || 0))
        - (Number(a?.liquidity?.usd || 0) + Number(a?.volume?.h24 || 0))
      ));
      ammPair = (abs[0]?.pairAddress ? String(abs[0].pairAddress).toLowerCase() : null);
    }
  } catch {}

  // 2) Blocks + logs
  const [fromBlock, toBlock] = await Promise.all([
    getCreationBlock(ca),
    getLatestBlock(),
  ]);
  const logs = await getAllTransferLogs(
    ca,
    { fromBlock: Math.max(0, fromBlock - 1), toBlock, window: 200_000, offset: 1000 }
  );
  logs.sort((a,b)=>{
    const ab = Number(a.blockNumber||0) - Number(b.blockNumber||0);
    return ab !== 0 ? ab : (Number(a.logIndex||0) - Number(b.logIndex||0));
  });

  // 3) Balances + supply
  const balances = buildBalancesFromLogs(logs);
  const totalSupplyRaw = await getTokenTotalSupply(ca);
  const supply = toBig(totalSupplyRaw || '0');

  // 4) Exclusion set
  const exclude = new Set([ca]);      // token CA (covers Moonshot CA-pool)
  if (ammPair) exclude.add(String(ammPair).toLowerCase());  // LP
  for (const b of DEAD) exclude.add(b);                     // burn

  // 5) Build filtered percent list (high precision)
  const holdersPerc = [];
  for (const [addr, bal] of balances.entries()) {
    const a = String(addr).toLowerCase();
    if (bal <= 0n) continue;
    if (exclude.has(a)) continue;
    const p = balToPercent(bal, supply); // high-precision %
    if (p > 0) holdersPerc.push({ address: a, percent: p });
  }
  holdersPerc.sort((A,B)=>B.percent - A.percent);

  const holdersCount = holdersPerc.length;

  // 6) Top10, Gini from same filtered set
  const top10CombinedPct = +holdersPerc
    .slice(0,10)
    .reduce((acc,h)=>acc + h.percent, 0)
    .toFixed(2);

  const gini = giniFromWeights(holdersPerc.map(h=>h.percent)); // 0..1

  // 7) Distributions
  // By % of supply
  const pctBins = [
    { label: '<0.01%', maxPct: 0.01 },
    { label: '<0.05%', maxPct: 0.05 },
    { label: '<0.10%', maxPct: 0.10 },
    { label: '<0.50%', maxPct: 0.50 },
    { label: '<1.00%', maxPct: 1.00 },
    { label: '≥1.00%', maxPct: Infinity },
  ];
  const pctDist = pctBins.map(b => ({ label: b.label, count: 0 }));
  for (const h of holdersPerc) {
    let placed = false;
    for (let i=0;i<pctBins.length;i++) {
      if (h.percent < pctBins[i].maxPct) { pctDist[i].count++; placed = true; break; }
    }
    if (!placed) pctDist[pctDist.length-1].count++;
  }

  // By $ value (estimate via share * marketCap/FDV)
  let valueDist = [];
  try {
    const mcap = Number(market?.marketCap || market?.fdv || 0) || 0;
    const bins = chooseDollarBins(mcap);
    valueDist = bins.map(b => ({ label: b.label, count: 0 }));
    if (mcap > 0) {
      for (const h of holdersPerc) {
        const usd = (h.percent/100) * mcap;
        for (let i=0;i<bins.length;i++) {
          const b = bins[i];
          if (usd >= b.min && (b.max == null || usd < b.max)) { valueDist[i].count++; break; }
        }
      }
    }
  } catch {
    valueDist = [
      { label: '$0–$10', count: 0 },
      { label: '$10–$50', count: 0 },
      { label: '$50–$100', count: 0 },
      { label: '$100–$250', count: 0 },
      { label: '$250–$1,000', count: 0 },
      { label: '$1,000+', count: 0 },
    ];
  }

  const snapshot = {
    tokenAddress: ca,
    updatedAt: Date.now(),
    holdersCount,
    top10CombinedPct,
    gini,
    pctDist,
    valueDist,
    meta: { excluded: { token: ca, lp: ammPair || null, burn: true } }
  };

  await setJSON(`index:${ca}`, snapshot, 6 * 3600); // ~6h
  return snapshot;
}

export async function ensureIndexSnapshot(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  const key = `index:${ca}`;
  const cached = await getJSON(key);
  if (cached) return cached;

  const lockKey = `lock:index:${ca}`;
  return withLock(lockKey, 120, async () => {
    const again = await getJSON(key);
    if (again) return again;
    return await refreshIndexSnapshot(ca);
  });
}