// src/pnlWorker.js
// Wallet PnL for Abstract chain, inspired by Solana-PNL-Bot mechanics:
// - Pull ERC20 transfers for wallet
// - Classify trades by matching counterparty to known DEX pairs (Dexscreener)
// - Match WETH deltas by tx hash to price the swap leg
// - Inventory model (average cost) -> realized PnL; mark remaining by current price
// - Airdrops: inbound, no WETH out, non-pair counterparty
//
// Caches per (wallet, window). Respects ETHERSCAN_RPS like your refresh worker.

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain constants (Abstract) ----------
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// ---------- Etherscan v2 client + throttle (reused pattern) ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');
const httpES = axios.create({ baseURL: ES_BASE, timeout: 25_000 });

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
function esParams(params) { return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } }; }
function esURL(params) { const u=new URL(ES_BASE); Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v])=>u.searchParams.set(k,String(v))); return u.toString(); }
async function esGET(params, { logOnce=false, tag='' }={}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  const maxAttempts = 3;
  for (let a=1; a<=maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (a === maxAttempts) throw new Error(`Etherscan v2 error: ${msg}`);
    } catch (e) { if (a === maxAttempts) throw e; }
    await new Promise(r => setTimeout(r, 400*a));
  }
}

// ---------- Dexscreener helpers ----------
async function getPairsForToken(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 15_000 });
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    return ps.filter(p => p?.chainId === 'abstract');
  } catch { return []; }
}
function chooseBestPair(pairs) {
  return [...pairs].sort((a,b) =>
    (Number(b?.liquidity?.usd||0) - Number(a?.liquidity?.usd||0)) ||
    (Number(b?.volume?.h24||0)    - Number(a?.volume?.h24||0))
  )[0];
}
async function getCurrentTokenQuote(ca) {
  const ps = await getPairsForToken(ca);
  const best = chooseBestPair(ps);
  return {
    priceUsd:   Number(best?.priceUsd || 0) || 0,
    priceWeth:  Number(best?.priceNative || 0) || 0, // token price in WETH
    pairAddrs:  ps.map(p => String(p.pairAddress || '').toLowerCase()),
    isMoonshot: ps.some(p => String(p.pairAddress || '').includes(':moon')),
  };
}

// ---------- Pull wallet ERC20 histories ----------
async function getWalletERC20Txs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 1000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account',
      action: 'tokentx',
      address: wallet,
      page,
      offset: PAGE,
      sort: 'asc',
      startblock: 0,
      endblock: 999999999
    }, { logOnce: page===1, tag:'[PNL tokentx]' });

    if (!Array.isArray(res) || res.length === 0) break;

    for (const r of res) {
      const t = Number(r.timeStamp || 0);
      if (t >= fromTs) out.push(r);
    }
    if (res.length < PAGE) break;
    page++;
    if (page > 20) { console.warn('[PNL] tokentx page cap hit'); break; }
  }
  return out;
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute (average-cost inventory) ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // 1) Pull all ERC20 transfers sinceTs
  const erc20 = await getWalletERC20Txs(wallet, { fromTs: sinceTs });

  // Build quick lookup maps
  const wethDeltaByHash = new Map();              // txHash -> +wethIn/-wethOut (wei)
  const tokenTxsByToken = new Map();              // tokenCA -> txs[]
  for (const r of erc20) {
    const hash  = String(r.hash);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

    if (token === WETH) {
      const sign = (to===wallet ? +1n : (from===wallet ? -1n : 0n));
      if (sign !== 0n) wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), sign * v));
      continue;
    }

    if (to !== wallet && from !== wallet) continue; // unrelated
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  // 2) Per-token analysis
  const perToken = [];
  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) => Number(a.timeStamp)-Number(b.timeStamp) || Number(a.logIndex||0)-Number(b.logIndex||0));

    const { priceUsd, priceWeth, pairAddrs } = await getCurrentTokenQuote(token);
    const pairSet = new Set((pairAddrs || []).map(x => String(x).toLowerCase()));

    let qty = 0n;          // token units currently held
    let costWeth = 0n;     // total WETH cost of current inventory
    let realizedWeth = 0n; // realized PnL in WETH
    let buys = 0n, sells = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];
    for (const r of txs) {
      const hash = String(r.hash);
      const to   = String(r.to   || '').toLowerCase();
      const from = String(r.from || '').toLowerCase();
      const cp   = (to===wallet) ? from : to;  // counterparty
      const amt  = toBig(r.value || '0');
      const isPair = pairSet.has(String(cp).toLowerCase());
      const wethDelta = wethDeltaByHash.get(hash) || 0n; // wallet perspective

      if (isPair) {
        // Trade with AMM
        if (to === wallet) {
          // BUY: token in (amt), WETH out (wethDelta negative)
          buys += amt;
          qty  += amt;
          if (wethDelta < 0n) costWeth += (-wethDelta); // add the spent WETH to cost basis
        } else {
          // SELL: token out (amt), WETH in (wethDelta positive)
          sells += amt;
          const avgCost = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n; // 1e18 scale
          const wethIn  = (wethDelta > 0n) ? wethDelta : 0n;
          const costOfSold = (avgCost * amt) / 1_000_000_000_000_000_000n;
          realizedWeth += (wethIn - costOfSold);

          // update inventory
          const newQty = qty > amt ? (qty - amt) : 0n;
          costWeth = newQty > 0n ? (avgCost * newQty) / 1_000_000_000_000_000_000n : 0n;
          qty = newQty;
        }
      } else {
        // Non-pair counterparty -> treat inbound w/ no WETH out as airdrop (0-cost)
        if (to === wallet && wethDelta >= 0n) {
          airdrops.push({ hash, amount: amt });
          // include airdrops in inventory at 0 cost so unrealized value shows up
          qty += amt;
          // costWeth unchanged
        }
      }
    }

    // Mark-to-market unrealized
    // Dexscreener priceNative on Abstract is TOKEN price in WETH per 1 token
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const invCostFloat = Number(costWeth) / 1e18;
    const mtmValueWeth = qtyFloat * Number(priceWeth || 0);
    const unrealizedWeth = mtmValueWeth - invCostFloat;

    // Airdrop USD estimate
    let airdropUnits = 0n;
    for (const a of airdrops) airdropUnits += a.amount;
    const airdropQtyFloat = Number(airdropUnits) / Number(scale || 1n);
    const airdropUsd = airdropQtyFloat * Number(priceUsd || 0);

    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,
      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),
      realizedWeth: realizedWeth.toString(),  // wei
      inventoryCostWeth: costWeth.toString(), // wei
      priceUsd,
      priceWeth,
      unrealizedWeth,                          // float WETH
      airdrops: {
        count: airdrops.length,
        units: airdropUnits.toString(),
        estUsd: airdropUsd
      }
    });
  }

  // Totals across tokens
  let totalRealizedWeth = 0;
  let totalUnrealizedWeth = 0;
  let totalAirdropUsd = 0;
  for (const r of perToken) {
    totalRealizedWeth   += Number(r.realizedWeth) / 1e18;
    totalUnrealizedWeth += Number(r.unrealizedWeth || 0);
    totalAirdropUsd     += Number(r.airdrops?.estUsd || 0);
  }

  // Wallet WETH net flows (all hashes)
  let wethIn = 0n, wethOut = 0n;
  for (const v of wethDeltaByHash.values()) {
    if (v > 0n) wethIn += v; else wethOut += (-v);
  }

  return {
    wallet,
    sinceTs,
    totals: {
      wethIn: wethIn.toString(),
      wethOut: wethOut.toString(),
      realizedWeth: totalRealizedWeth,     // WETH float
      unrealizedWeth: totalUnrealizedWeth, // WETH float
      airdropsUsd: totalAirdropUsd         // USD float
    },
    tokens: perToken
  };
}

// ---------- Public API with caching ----------
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const pnlQueueName = 'tabs_pnl';
export const pnlQueue = new Queue(pnlQueueName, { connection: bullRedis });

export async function refreshPnl(wallet, window) {
  const sinceMap = {
    '24h':  60*60*24,
    '7d':   60*60*24*7,
    '30d':  60*60*24*30,
    '365d': 60*60*24*365,
    'all':  0
  };
  const sinceSec = sinceMap[window] ?? sinceMap['30d'];
  const sinceTs = sinceSec ? Math.floor(Date.now()/1000) - sinceSec : 0;

  const key = `pnl:${wallet.toLowerCase()}:${window}`;
  return withLock(`lock:${key}`, 60, async () => {
    const cached = await getJSON(key);
    if (cached) return cached;
    const data = await computePnL(wallet, { sinceTs });
    await setJSON(key, data, 120); // 2 min cache
    return data;
  });
}

// ---------- Worker ----------
new Worker(
  pnlQueueName,
  async (job) => {
    const { wallet, window } = job.data || {};
    console.log('[PNL] job received', wallet, window);
    const res = await refreshPnl(String(wallet||''), String(window||'30d'));
    console.log('[PNL] job OK');
    return res;
  },
  { connection: bullRedis }
);
