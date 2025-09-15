// src/indexer.js
import './configEnv.js';
import axios from 'axios';
import { getJSON, setJSON } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// ---- Etherscan v2 client (same as in refreshWorker) ----
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[INDEX] ETHERSCAN_API_KEY missing');

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
async function esGET(params) {
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
      await new Promise(r => setTimeout(r, 250 * i));
    }
  }
}

// ---- Small utils (share with refreshWorker style) ----
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([
  ZERO,
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
function topicToAddr(t) { return ('0x' + String(t).slice(-40)).toLowerCase(); }

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

async function getAllTransferLogs(token, {
  fromBlock, toBlock,
  window = 200_000, offset = 1000, maxWindows = 300,
  timeBudgetMs = 9000
} = {}) {
  const tStart = Date.now();
  const all = [];
  let start = fromBlock;
  while (start <= toBlock) {
    if (Date.now() - tStart > timeBudgetMs) break;
    const end = Math.min(start + window, toBlock);

    for (let page = 1; ; page++) {
      if (Date.now() - tStart > timeBudgetMs) break;
      let batch;
      try {
        batch = await esGET({
          module:'logs', action:'getLogs',
          address: token, topic0: TOPIC_TRANSFER,
          fromBlock:start, toBlock:end, page, offset
        });
      } catch { break; }
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < offset) break;
    }
    start = end + 1;
    if (--maxWindows <= 0) break;
  }
  return all;
}

async function getTokenTotalSupply(token) {
  return String(await esGET({ module:'stats', action:'tokensupply', contractaddress: token }));
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
  for (const [a,v] of balances) if (v <= 0n) balances.delete(a);
  return balances;
}

// ---- Buckets (auto choose 6 ranges by market cap) ----
function chooseDollarBuckets(capUsd) {
  const cap = Number(capUsd || 0);
  // heuristic tiers
  if (cap < 100_000) return [10, 25, 50, 100, 250, 500];
  if (cap < 300_000) return [10, 50, 100, 250, 500, 1000];
  if (cap < 1_000_000) return [25, 100, 250, 500, 1000, 2500];
  if (cap < 3_000_000) return [50, 250, 500, 1000, 2500, 5000];
  return [100, 500, 1000, 2500, 5000, 10000];
}

function gini(values) {
  const arr = values.map(Number).filter(v => v > 0).sort((a,b)=>a-b);
  const n = arr.length;
  if (!n) return 0;
  const sum = arr.reduce((a,b)=>a+b, 0);
  if (sum === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (2*(i+1) - n - 1) * arr[i];
  return Math.max(0, Math.min(1, cum / (n * sum)));
}

// ---- Cache helpers ----
const INDEX_TTL = 6 * 60 * 60; // 6h
const KEY = (ca) => `index:${ca}`;
const REG = 'index:requested'; // ca->ts map (for background refresh)

export async function getIndexSnapshot(tokenAddress) {
  const ca = String(tokenAddress || '').toLowerCase();
  const cached = await getJSON(KEY(ca));
  return cached || null;
}

export async function buildIndexSnapshot(tokenAddress) {
  const ca = String(tokenAddress || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error('bad CA');

  // 1) Market (for price + cap)
  const { summary: market } = await getDexscreenerTokenStats(ca);
  const priceUsd = Number(market?.priceUsd || 0);
  const capUsd   = Number(market?.marketCap || market?.fdv || 0);

  // 2) Crawl holders quickly (creation→latest)
  const [fromBlock, toBlock] = await Promise.all([ getCreationBlock(ca), getLatestBlock() ]);
  const logs = await getAllTransferLogs(ca, { fromBlock, toBlock, timeBudgetMs: 12_000 });
  const balances = buildBalancesFromLogs(logs);
  const totalSupplyRaw = await getTokenTotalSupply(ca);
  const totalSupply = toBig(totalSupplyRaw || '0');

  // 3) Build USD values & % supply
  const holders = [];
  let holdersCount = 0;
  for (const [addr, balRaw] of balances.entries()) {
    holdersCount++;
    const usd = priceUsd * Number(balRaw) / Number(totalSupply || 1n);
    // ^ proportion of supply * cap approximates USD value; or use priceUsd * (balRaw / 10^dec)
    holders.push({
      address: addr,
      balanceRaw: balRaw.toString(),
      usdValue: usd,
      pctSupply: totalSupply > 0n ? Number((balRaw * 1000000n) / totalSupply) / 10000 : 0
    });
  }

  // 4) Buckets
  const bins = chooseDollarBuckets(capUsd);
  const counts = new Array(bins.length + 1).fill(0); // last bin = > last
  const values = new Array(bins.length + 1).fill(0);
  let realHolders = 0; let microHolders = 0;
  const giniVal = gini(holders.map(h => h.usdValue));

  for (const h of holders) {
    if (h.usdValue >= 10) realHolders++; else microHolders++;
    let idx = bins.findIndex(b => h.usdValue < b);
    if (idx === -1) idx = bins.length;
    counts[idx] += 1;
    values[idx] += h.usdValue;
  }

  const pctSupplyBands = [
    { label: '<0.01%', max: 0.01, cnt: 0 },
    { label: '<0.05%', max: 0.05, cnt: 0 },
    { label: '<0.10%', max: 0.10, cnt: 0 },
    { label: '<0.50%', max: 0.50, cnt: 0 },
    { label: '≥1.00%', max: Infinity, cnt: 0 },
  ];
  for (const h of holders) {
    const p = h.pctSupply;
    if (p < 0.01) pctSupplyBands[0].cnt++;
    else if (p < 0.05) pctSupplyBands[1].cnt++;
    else if (p < 0.10) pctSupplyBands[2].cnt++;
    else if (p < 0.50) pctSupplyBands[3].cnt++;
    else if (p >= 1.00) pctSupplyBands[4].cnt++;
  }

  const snap = {
    tokenAddress: ca,
    updatedAt: Date.now(),
    market: {
      name: market?.name || 'Token',
      symbol: market?.symbol || '',
      priceUsd, capUsd,
    },
    holdersCount,
    bins, counts, values,
    realHolders, microHolders,
    pctSupplyBands,
    gini: Number(giniVal.toFixed(4)),
  };

  // cache + register for 6h background refresh
  await setJSON(KEY(ca), snap, INDEX_TTL);
  const reg = (await getJSON(REG)) || {};
  reg[ca] = Date.now();
  await setJSON(REG, reg, 30 * 24 * 3600); // 30d registry
  return snap;
}
