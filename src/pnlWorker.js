// src/pnlWorker.js
// Wallet PnL for Abstract chain (ETH + WETH).
//
// What this version adds/changes:
// • Combines native ETH + WETH legs and exposes combined "base" (ETH) totals.
// • Classifies BUY/SELL using combined base (ETH+WETH) per tx-hash.
// • Treats bonding-phase receives (from == token) as BUY even if no base leg.
// • Subtracts ANY outbound token transfer from remaining qty (and cost basis proportionally).
// • Hides dust positions < 5 tokens (never hide ETH/WETH).
// • Computes per-position USD value, wallet-wide USD holdings.
// • Exposes derived buckets: open (≥ 5 tokens), closed ( < 5 tokens ), airdrops, best/worst.
// • Closed = remaining < 5 tokens; Profits/Losses use realized PnL only.
//
// renderers_pnl.js drives the views (overview/profits/losses/open/airdrops).

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain constants (Abstract) ----------
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// ---------- Etherscan v2 client + throttle ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

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
async function getUsdQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 15_000 });
    if (Array.isArray(data) && data.length > 0) return { priceUsd: Number(data[0]?.priceUsd || 0) || 0 };
    return { priceUsd: Number(data?.priceUsd || 0) || 0 };
  } catch { return { priceUsd: 0 }; }
}
async function getWethQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 15_000 });
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    const abs = ps.filter(p => p?.chainId === 'abstract');
    abs.sort((a,b) =>
      (Number(b?.liquidity?.usd||0) - Number(a?.liquidity?.usd||0)) ||
      (Number(b?.volume?.h24||0)    - Number(a?.volume?.h24||0))
    );
    const best = abs[0];
    return { priceWeth: Number(best?.priceNative || 0) || 0 };
  } catch { return { priceWeth: 0 }; }
}
async function getQuotes(ca) {
  const [{ priceUsd }, { priceWeth }] = await Promise.all([ getUsdQuote(ca), getWethQuote(ca) ]);
  return { priceUsd, priceWeth };
}

// ---------- Pull wallet histories ----------
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
    if (page > 50) { console.warn('[PNL] tokentx page cap hit'); break; }
  }
  return out;
}
async function getWalletNormalTxs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 10000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account',
      action: 'txlist',
      address: wallet,
      page,
      offset: PAGE,
      sort: 'asc',
      startblock: 0,
      endblock: 999999999
    }, { logOnce: page===1, tag:'[PNL txlist]' });

    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) {
      const t = Number(r.timeStamp || 0);
      if (t >= fromTs) out.push(r);
    }
    if (res.length < PAGE) break;
    page++;
    if (page > 5) { console.warn('[PNL] txlist page cap hit'); break; }
  }
  return out;
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // 1) Pull histories
  const [erc20, normal] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs })
  ]);

  // Build ETH & WETH deltas per tx-hash (wallet perspective)
  const wethDeltaByHash = new Map(); // txHash -> +in / -out (wei)
  const ethDeltaByHash  = new Map(); // txHash -> +in / -out (wei)
  const tokenTxsByToken = new Map(); // tokenCA -> txs[]

  // Native ETH deltas
  for (const tx of normal) {
    const hash = String(tx.hash);
    const from = String(tx.from || '').toLowerCase();
    const to   = String(tx.to   || '').toLowerCase();
    const val  = toBig(tx.value || '0');

    if (to === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), val));   // +in
    } else if (from === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), -val));  // -out
    }
  }

  // WETH deltas and token grouping
  for (const r of erc20) {
    const hash  = String(r.hash);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

    if (token === WETH) {
      if (to === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), v));   // +in
      } else if (from === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), -v));  // -out
      }
      continue;
    }

    if (to !== wallet && from !== wallet) continue; // unrelated to wallet
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken = [];
  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) => Number(a.timeStamp)-Number(b.timeStamp) || Number(a.logIndex||0)-Number(b.logIndex||0));
    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWeth = 0n;         // total WETH+ETH cost of current inventory (wei)
    let realizedWeth = 0n;     // realized PnL (in wei, WETH-equiv)
    let buys = 0n, sells = 0n; // units

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    for (const r of txs) {
      const hash = String(r.hash);
      const to   = String(r.to   || '').toLowerCase();
      const from = String(r.from || '').toLowerCase();
      const amt  = toBig(r.value || '0');

      const wethDelta = wethDeltaByHash.get(hash) || 0n;
      const ethDelta  = ethDeltaByHash.get(hash)  || 0n;
      const paidWei   = (ethDelta < 0n ? -ethDelta : 0n) + (wethDelta < 0n ? -wethDelta : 0n);
      const recvWei   = (ethDelta > 0n ?  ethDelta : 0n) + (wethDelta > 0n ?  wethDelta : 0n);

      // BUY (receive token and pay base OR bonding from token)
      if (to === wallet && (paidWei > 0n || from === token)) {
        buys += amt;
        qty  += amt;
        costWeth += paidWei; // can be 0 for bonding from token
        continue;
      }

      // SELL (send token and receive base)
      if (from === wallet && recvWei > 0n) {
        sells += amt;

        const avg = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const proceeds = recvWei;
        const costOfSold = (avg * amt) / 1_000_000_000_000_000_000n;

        realizedWeth += (proceeds - costOfSold);

        const newQty = qty > amt ? (qty - amt) : 0n;
        costWeth = newQty > 0n ? (avg * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // GIFT/INTERNAL OUT (no base received): reduce qty & cost proportionally
      if (from === wallet && recvWei === 0n) {
        if (qty > 0n) {
          const avg = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
          const used = amt > qty ? qty : amt;
          const cut  = (avg * used) / 1_000_000_000_000_000_000n;
          qty -= used;
          costWeth = costWeth > cut ? (costWeth - cut) : 0n;
        }
        continue;
      }

      // AIRDROP (no base paid and not bonding)
      if (to === wallet && paidWei === 0n && from !== token) {
        airdrops.push({ hash, amount: amt });
        qty += amt;
        continue;
      }
    }

    // Hide dust < 5 tokens (never hide ETH/WETH rows)
    const symUp     = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    // (We still keep them in totals internally; just don't show in views)
    const hideFromViews = (qty > 0n && !isEthLike && qty < MIN_UNITS);

    // Mark-to-market
    const qtyFloatTokens   = Number(qty) / Number(scale || 1n);
    const invCostFloatWeth = Number(costWeth) / 1e18;
    const mtmValueWeth     = qtyFloatTokens * Number(priceWeth || 0);
    const unrealizedWeth   = mtmValueWeth - invCostFloatWeth;
    const usdValueRemaining = qtyFloatTokens * Number(priceUsd || 0);

    // Airdrop USD estimate
    let airdropUnits = 0n;
    for (const a of airdrops) airdropUnits += a.amount;
    const airdropUsd = (Number(airdropUnits) / Number(scale || 1n)) * Number(priceUsd || 0);

    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,
      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),           // bigint string
      hideFromViews,                       // for renderer logic

      realizedWeth: Number(realizedWeth) / 1e18,  // float
      inventoryCostWeth: Number(costWeth) / 1e18, // float
      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth,                              // float
      usdValueRemaining,                           // float

      airdrops: {
        count: airdrops.length,
        units: airdropUnits.toString(),
        estUsd: airdropUsd
      }
    });
  }

  // Totals across tokens (USD)
  let totalRealizedWeth   = 0;
  let totalUnrealizedWeth = 0;
  let totalAirdropUsd     = 0;
  let totalHoldingsUsd    = 0;
  for (const r of perToken) {
    totalRealizedWeth   += Number(r.realizedWeth) || 0;
    totalUnrealizedWeth += Number(r.unrealizedWeth) || 0;
    totalAirdropUsd     += Number(r.airdrops?.estUsd || 0);
    totalHoldingsUsd    += Number(r.usdValueRemaining || 0);
  }

  // Wallet base (ETH+WETH) net flows
  let wethIn = 0n, wethOut = 0n;
  for (const v of wethDeltaByHash.values()) {
    if (v > 0n) wethIn += v; else wethOut += (-v);
  }
  let ethIn = 0n, ethOut = 0n;
  for (const v of ethDeltaByHash.values()) {
    if (v > 0n) ethIn += v; else ethOut += (-v);
  }

  const wethInFloat  = Number(wethIn)  / 1e18;
  const wethOutFloat = Number(wethOut) / 1e18;
  const ethInFloat   = Number(ethIn)   / 1e18;
  const ethOutFloat  = Number(ethOut)  / 1e18;

  const baseInFloat  = wethInFloat + ethInFloat;
  const baseOutFloat = wethOutFloat + ethOutFloat;

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = baseOutFloat; // denominator for PnL%
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Derived buckets for views
  const MIN_REMAIN_STRICT = (t) => {
    const d = Number(t.decimals||18);
    const minUnits = 5 * (10 ** d);
    const rem = Number(t.remaining || '0');
    return rem >= minUnits;
  };

  const open = perToken
    .filter(t => MIN_REMAIN_STRICT(t) && !t.hideFromViews && Number(t.usdValueRemaining) > 0);

  // closed = remaining < 5 tokens
  const closed = perToken.filter(t => !MIN_REMAIN_STRICT(t));

  // realized-only for profits/losses (ignore zero-value positions)
  const profits = closed
    .filter(t => Number(t.realizedWeth) > 0 && (Number(t.usdValueRemaining) === 0 || Number(t.usdValueRemaining) < 0.000001))
    .sort((a,b)=> Number(b.realizedWeth) - Number(a.realizedWeth))
    .slice(0, 100);

  const losses = closed
    .filter(t => Number(t.realizedWeth) < 0 && (Number(t.usdValueRemaining) === 0 || Number(t.usdValueRemaining) < 0.000001))
    .sort((a,b)=> Number(a.realizedWeth) - Number(b.realizedWeth))
    .slice(0, 100);

  // airdrops (only show with USD > 0)
  const airdropsFlat = perToken
    .filter(t => (t.airdrops?.count || 0) > 0 && Number(t.airdrops?.estUsd || 0) > 0)
    .map(t => ({
      token: t.token,
      symbol: t.symbol,
      decimals: t.decimals,
      units: t.airdrops.units,
      estUsd: t.airdrops.estUsd
    }));

  // best/worst by realized for quick overview
  const best  = profits.slice(0, 15);
  const worst = losses.slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      // Raw combined ETH-like picture
      baseInFloat,    // ETH+WETH in
      baseOutFloat,   // ETH+WETH out
      wethInFloat, wethOutFloat, ethInFloat, ethOutFloat,

      // PnL
      realizedWeth: totalRealizedWeth,
      unrealizedWeth: totalUnrealizedWeth,
      totalPnlWeth,
      pnlPct,

      // USD
      airdropsUsd: totalAirdropUsd,
      holdingsUsd: totalHoldingsUsd,
    },
    tokens: perToken,
    derived: {
      open,
      closed,     // available for debugging if needed
      profits,    // realized > 0, closed
      losses,     // realized < 0, closed
      airdrops: airdropsFlat,
      best,
      worst
    }
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
