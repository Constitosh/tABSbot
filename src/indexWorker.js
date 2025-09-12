// src/indexWorker.js
import './configEnv.js';
import axios from 'axios';
import { getJSON, setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

/**
 * This worker:
 *  - pulls all Transfer logs for a token
 *  - builds balances (holders)
 *  - EXCLUDES LP/CA pools and burn addresses from ALL stats
 *  - computes: holdersCount, top10CombinedPct, gini, two distributions
 *  - caches snapshot for 6h
 *
 * It does not touch /stats logic and only runs when the Index tab is clicked (or via refresh).
 */

// ---------- Etherscan V2 ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract chainId

if (!ES_KEY) console.warn('[INDEX] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// Simple throttle (5 rps default)
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
    const res = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      { tag: '[creatorBlock]' }
    );
    const first = Array.isArray(res) ? res[0] : res;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  // fallback by first tokentx
  try {
    const r = await esGET(
      { module: 'account', action: 'tokentx', contractaddress: token, page: 1, offset: 1, sort: 'asc' },
      { tag: '[firstTx]' }
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
      { tag: '[latestBlock]' }
    );
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
          module: 'logs',
          action: 'getLogs',
          address: token,
          topic0: TOPIC_TRANSFER,
          fromBlock: start,
          toBlock: end,
          page,
          offset,
        }, { tag: `[logs ${start}-${end}]` });
      } catch (e) {
        break; // stop this window after retries in esGET
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < offset) break;
    }
    start = end + 1;
  }
  return all;
}

async function getTokenTotalSupply(token) {
  const r = await esGET(
    { module: 'stats', action: 'tokensupply', contractaddress: token },
    { tag: '[supply]' }
  );
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

function percent(num, den, digits = 4) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return +((num / den) * 100).toFixed(digits);
}

function giniFromPerc(percs) {
  const arr = (percs || []).map(Number).filter(x => x > 0);
  if (arr.length <= 1) return 0;
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const w = arr.map(x => x / total).sort((a, b) => a - b);
  let cum = 0, area = 0;
  for (const v of w) {
    const prev = cum;
    cum += v;
    area += (prev + cum) / 2;
  }
  area /= w.length;
  const g = 1 - 2 * area;
  return +g.toFixed(4);
}

function makeBars(count, total, slots = 10) {
  const n = Math.max(0, Math.min(slots, Math.round((total > 0 ? (count / total) : 0) * slots)));
  return `[${'█'.repeat(n)}${'░'.repeat(slots - n)}]`;
}

// ---------- Core snapshot ----------
export async function refreshIndexSnapshot(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error('Bad contract');

  // 1) Market (for LP/CA hints + price)
  let market = null;
  let ammPair = null;       // LP address, if any
  let launchPadPair = null; // Moonshot pool id, if any
  try {
    const { summary } = await getDexscreenerTokenStats(ca);
    market = summary || null;

    // Best AMM pair (Abstract only)
    if (market?.pairs && Array.isArray(market.pairs)) {
      const abs = market.pairs.filter(p => p?.chainId === 'abstract');
      abs.sort((a, b) =>
        (Number(b?.liquidity?.usd || 0) + Number(b?.volume?.h24 || 0))
        - (Number(a?.liquidity?.usd || 0) + Number(a?.volume?.h24 || 0))
      );
      ammPair = String(abs[0]?.pairAddress || '').toLowerCase() || null;
    }
    if (market?.launchPadPair) {
      launchPadPair = String(market.launchPadPair).toLowerCase();
    }
  } catch (e) {
    // ignore
  }

  // 2) Blocks & logs
  const [fromBlock, toBlock] = await Promise.all([
    getCreationBlock(ca),
    getLatestBlock(),
  ]);
  const logs = await getAllTransferLogs(ca, { fromBlock: Math.max(0, fromBlock - 1), toBlock, window: 200_000, offset: 1000 });
  logs.sort((a, b) => {
    const ab = Number(a.blockNumber || 0) - Number(b.blockNumber || 0);
    return ab !== 0 ? ab : Number(a.logIndex || 0) - Number(b.logIndex || 0);
  });

  // 3) Build balances
  const balances = buildBalancesFromLogs(logs);
  const totalSupplyRaw = await getTokenTotalSupply(ca);
  const supply = toBig(totalSupplyRaw || '0');

  // 3a) Exclusion set (LP/CA/burn)
  const exclude = new Set([ca]);
  if (ammPair) exclude.add(String(ammPair).toLowerCase());
  // Some Moonshot launches record pool under token address — excluding CA already covers it
  for (const b of DEAD) exclude.add(b);

  // 4) Build filtered rows (address, balanceBig)
  const rows = [];
  for (const [addr, bal] of balances.entries()) {
    const a = String(addr).toLowerCase();
    if (bal <= 0n) continue;
    if (exclude.has(a)) continue;
    rows.push([a, bal]);
  }

  // 5) Convert to percents & sort (desc)
  const holdersPerc = rows.map(([address, bal]) => ({
    address,
    percent: supply > 0n ? Number(((bal * 1000000n) / supply)) / 10000 : 0
  })).filter(x => x.percent > 0);

  holdersPerc.sort((A, B) => B.percent - A.percent);

  // 6) Stats
  const holdersCount = holdersPerc.length;
  const top10CombinedPct = +holdersPerc.slice(0, 10).reduce((acc, h) => acc + (h.percent || 0), 0).toFixed(4);
  const gini = giniFromPerc(holdersPerc.map(h => h.percent));

  // 7) Distributions
  // By % of supply (fixed bins)
  const pctBins = [
    { label: '<0.01%', maxPct: 0.01 },
    { label: '<0.05%', maxPct: 0.05 },
    { label: '<0.10%', maxPct: 0.10 },
    { label: '<0.50%', maxPct: 0.50 },
    { label: '<1.00%', maxPct: 1.00 },
    { label: '≥1.00%', maxPct: Infinity },
  ];
  const pctDist = pctBins.map(b => ({
    label: b.label,
    count: holdersPerc.filter(h => h.percent < b.maxPct).length
  }));
  // Fix last bin (≥1%) to include only those not counted in earlier bins
  const countedBefore = pctBins.slice(0, -1)
    .reduce((acc, b) => acc + holdersPerc.filter(h => h.percent < b.maxPct).length, 0);
  pctDist[pctDist.length - 1].count = Math.max(0, holdersCount - countedBefore);

  // By $ value — use FDV/priceUsd if available; otherwise work with relative bars only
  let valueDist = [];
  try {
    const mcap = Number(market?.marketCap || market?.fdv || 0) || 0;
    const priceUsd = Number(market?.priceUsd || 0) || 0;

    // If price is available we can translate % to USD estimate per holder:
    // holder_value ≈ holder_% * FDV (NOT perfect, but a consistent proxy across supply)
    const values = holdersPerc.map(h => ({
      address: h.address,
      usd: (mcap > 0 ? (h.percent / 100) * mcap : 0)
    }));

    // Choose 6 bins adapting to MC
    const bins = chooseDollarBins(mcap); // returns [{label, min, max}] with last being 1000+ style
    valueDist = bins.map(b => ({
      label: b.label,
      count: values.filter(v => v.usd >= b.min && (b.max == null || v.usd < b.max)).length
    }));
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

  // 8) Pack snapshot
  const snapshot = {
    tokenAddress: ca,
    updatedAt: Date.now(),
    holdersCount,
    top10CombinedPct,
    gini,
    pctDist,      // [{label,count}]
    valueDist,    // [{label,count}]
    meta: {
      excluded: {
        lp: ammPair || null,
        token: ca,
        burn: true
      }
    }
  };

  // 9) Cache ~6h
  const key = `index:${ca}`;
  await setJSON(key, snapshot, 6 * 3600);

  return snapshot;
}

export async function ensureIndexSnapshot(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  const key = `index:${ca}`;
  const cached = await getJSON(key);
  if (cached) return cached;

  // lock to avoid thundering herd
  const lockKey = `lock:index:${ca}`;
  return withLock(lockKey, 120, async () => {
    const again = await getJSON(key);
    if (again) return again;
    return await refreshIndexSnapshot(ca);
  });
}

// ---------- Bins helper ----------
function chooseDollarBins(mcap) {
  // adapt bins to market cap scale
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

  // Heuristic scaling
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
  // ≥ $1m
  return [
    { label: '$0–$50', min: 0, max: 50 },
    { label: '$50–$250', min: 50, max: 250 },
    { label: '$250–$1,000', min: 250, max: 1000 },
    { label: '$1,000–$5,000', min: 1000, max: 5000 },
    { label: '$5,000–$25,000', min: 5000, max: 25000 },
    { label: '$25,000+', min: 25000, max: null },
  ];
}