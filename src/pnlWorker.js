// src/pnlWorker.js
// Wallet PnL for Abstract chain (ETH + WETH).
//
// What’s new vs previous version:
// • Always keep tokens in output, even when remaining < 5 tokens. We mark them as `isDust`.
//   -> Renderer can treat (remaining == 0 || isDust) as "closed" for Profits/Losses.
// • Track buy/sell unit+ETH sums (buyUnits, buyWeiSum, sellUnits, sellWeiSum).
// • Keep robust cash-leg matching (±180s or ±3 blocks), handle bonding/forwarders.
// • Inventory & realized PnL unchanged (average-cost).
// • ETH + WETH balances are returned for header.
//
// Public API:
//   refreshPnl(wallet, window) -> { wallet, sinceTs, totals, tokens[], derived }

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain constants (Abstract) ----------
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();
const KNOWN_FORWARDERS = new Set([
  // Moonshot forwarder seen frequently
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'
]);

const JOIN_SEC = 180;
const JOIN_BLOCKS = 3;

// ---------- Etherscan v2 client + throttle ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45000 });

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
function esParams(params){ return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } }; }
function esURL(params){ const u=new URL(ES_BASE); Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v])=>u.searchParams.set(k,String(v))); return u.toString(); }
async function esGET(params, { logOnce=false, tag='' }={}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  const tries = 3;
  for (let a=1; a<=tries; a++){
    try{
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (a === tries) throw new Error(`Etherscan v2 error: ${msg}`);
    }catch(e){ if (a === tries) throw e; }
    await new Promise(r => setTimeout(r, 400*a));
  }
}

// ---------- Dexscreener quotes ----------
async function getUsdQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 15000 });
    if (Array.isArray(data) && data.length > 0) return { priceUsd: Number(data[0]?.priceUsd || 0) || 0 };
    return { priceUsd: Number(data?.priceUsd || 0) || 0 };
  } catch { return { priceUsd: 0 }; }
}
async function getWethQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 15000 });
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

// ---------- Wallet histories ----------
async function getWalletERC20Txs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 1000;
  const out = [];
  while (true) {
    const res = await esGET({
      module:'account', action:'tokentx', address: wallet,
      page, offset: PAGE, sort:'asc', startblock:0, endblock: 999999999
    }, { logOnce: page===1, tag:'[PNL tokentx]' });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) if (Number(r.timeStamp||0) >= fromTs) out.push(r);
    if (res.length < PAGE) break;
    page++; if (page > 50) { console.warn('[PNL] tokentx page cap hit'); break; }
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
      module:'account', action:'txlist', address: wallet,
      page, offset: PAGE, sort:'asc', startblock:0, endblock: 999999999
    }, { logOnce: page===1, tag:'[PNL txlist]' });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) if (Number(r.timeStamp||0) >= fromTs) out.push(r);
    if (res.length < PAGE) break;
    page++; if (page > 5) { console.warn('[PNL] txlist page cap hit'); break; }
  }
  return out;
}

// ---------- Balances ----------
async function getNativeEthBalance(wallet) {
  try {
    const res = await esGET({ module:'account', action:'balance', address: wallet, tag:'latest' }, { tag:'[balance]' });
    return BigInt(String(res||'0'));
  } catch { return 0n; }
}
async function getWethWalletBalance(wallet) {
  try {
    const res = await esGET({ module:'account', action:'tokenbalance', contractaddress: WETH, address: wallet, tag:'latest' }, { tag:'[wethBalance]' });
    return BigInt(String(res||'0'));
  } catch { return 0n; }
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x || '0'));
const add   = (a,b) => (a||0n) + (b||0n);
const ONE   = 1_000_000_000_000_000_000n;

function withinJoinWindow(a, b) {
  const dt = Math.abs(Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
  const db = Math.abs(Number(a.blockNumber || 0) - Number(b.blockNumber || 0));
  return (dt <= JOIN_SEC) || (db <= JOIN_BLOCKS);
}
function bestCashCandidate(transfer, candidates, used) {
  let bestSameBlock = null;
  let bestSameScore = Infinity;
  let bestTime = null;
  let bestTimeScore = Infinity;
  for (let i=0; i<candidates.length; i++) {
    if (used.has(i)) continue;
    const c = candidates[i];
    if (!withinJoinWindow(transfer, c)) continue;
    const sameBlock = (Number(c.blockNumber||0) === Number(transfer.blockNumber||0));
    const score = Math.abs(Number(transfer.timeStamp||0) - Number(c.timeStamp||0));
    if (sameBlock) {
      if (score < bestSameScore) { bestSameScore = score; bestSameBlock = i; }
    } else {
      if (score < bestTimeScore) { bestTimeScore = score; bestTime = i; }
    }
  }
  return (bestSameBlock !== null ? bestSameBlock : bestTime);
}

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  const [erc20, normal] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs })
  ]);

  const wethDeltaByHash = new Map();
  const ethDeltaByHash  = new Map();
  const cashOut = [];
  const cashIn  = [];

  // ETH legs
  for (const tx of normal) {
    const hash = String(tx.hash);
    const from = String(tx.from||'').toLowerCase();
    const to   = String(tx.to||'').toLowerCase();
    const val  = toBig(tx.value||'0');
    const rec = { hash, blockNumber:Number(tx.blockNumber||0), timeStamp:Number(tx.timeStamp||0), wei: val };
    if (to === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), val));
      cashIn.push(rec);
    } else if (from === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), -val));
      cashOut.push({ ...rec, wei: -val });
    }
  }

  const tokenTxsByToken = new Map();

  // WETH + tokens
  for (const r of erc20) {
    const hash  = String(r.hash);
    const token = String(r.contractAddress||'').toLowerCase();
    const to    = String(r.to||'').toLowerCase();
    const from  = String(r.from||'').toLowerCase();
    const v     = toBig(r.value||'0');

    if (token === WETH) {
      const rec = { hash, blockNumber:Number(r.blockNumber||0), timeStamp:Number(r.timeStamp||0), wei: v };
      if (to === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), v));
        cashIn.push(rec);
      } else if (from === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), -v));
        cashOut.push({ ...rec, wei: -v });
      }
      continue;
    }

    if (to !== wallet && from !== wallet) continue;
    const ev = {
      token, hash,
      blockNumber: Number(r.blockNumber||0),
      timeStamp:   Number(r.timeStamp||0),
      to, from,
      amount: toBig(r.value||'0'),
      decimals: Math.max(0, Number(r.tokenDecimal||18)),
      symbol: r.tokenSymbol || ''
    };
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(ev);
  }

  cashOut.sort((a,b)=> (a.blockNumber-b.blockNumber) || (a.timeStamp-b.timeStamp));
  cashIn.sort ((a,b)=> (a.blockNumber-b.blockNumber) || (a.timeStamp-b.timeStamp));
  const usedOut = new Set();
  const usedIn  = new Set();

  const perToken = [];

  for (const [token, txsRaw] of tokenTxsByToken.entries()) {
    txsRaw.sort((a,b)=> a.blockNumber-b.blockNumber || a.timeStamp-b.timeStamp);

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // units held now
    let costWeth = 0n;         // wei
    let realizedWeth = 0n;     // wei
    let buys = 0n, sells = 0n; // unit counters
    const airdrops = [];

    // NEW: sums for averages
    let buyUnits = 0n, buyWeiSum = 0n;
    let sellUnits = 0n, sellWeiSum = 0n;

    const decimals = txsRaw[0]?.decimals ?? 18;
    const scale = 10n ** BigInt(decimals);
    const sym = txsRaw[0]?.symbol || '';

    for (const ev of txsRaw) {
      const { hash, to, from, amount } = ev;

      const wethΔ = wethDeltaByHash.get(hash) || 0n;
      const ethΔ  = ethDeltaByHash.get(hash)  || 0n;
      const paidWei = (ethΔ < 0n ? -ethΔ : 0n) + (wethΔ < 0n ? -wethΔ : 0n);
      const recvWei = (ethΔ > 0n ?  ethΔ : 0n) + (wethΔ > 0n ?  wethΔ : 0n);

      let isBuy=false, isSell=false, buyWei=0n, sellWei=0n;

      // same-hash first
      if (to === wallet && paidWei > 0n) { isBuy = true; buyWei = paidWei; }
      if (from === wallet && recvWei > 0n){ isSell = true; sellWei = recvWei; }

      // nearby join
      if (!isBuy && to === wallet && paidWei === 0n) {
        if (from === token || KNOWN_FORWARDERS.has(from) || true) {
          const idx = bestCashCandidate(ev, cashOut, usedOut);
          if (idx !== null) { isBuy = true; buyWei = (-cashOut[idx].wei); usedOut.add(idx); }
        }
      }
      if (!isSell && from === wallet && recvWei === 0n) {
        const idx = bestCashCandidate(ev, cashIn, usedIn);
        if (idx !== null) { isSell = true; sellWei = cashIn[idx].wei; usedIn.add(idx); }
      }

      if (isBuy) {
        buys += amount;
        buyUnits += amount;
        buyWeiSum += buyWei;

        qty  += amount;
        costWeth += buyWei; // may be 0 if unmatched leg
        continue;
      }

      if (isSell) {
        sells += amount;
        sellUnits += amount;
        sellWeiSum += sellWei;

        const avgCostWeiPerUnit = qty > 0n ? (costWeth * ONE) / qty : 0n;
        const useAmt = amount > qty ? qty : amount;
        const costOfSold = (avgCostWeiPerUnit * useAmt) / ONE;
        realizedWeth += (sellWei - costOfSold);
        const newQty = qty > useAmt ? (qty - useAmt) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / ONE : 0n;
        qty = newQty;
        continue;
      }

      // Gifts/internal outs: reduce inventory + cost basis, no realized
      if (from === wallet) {
        if (qty > 0n) {
          const avgCostWeiPerUnit = (costWeth * ONE) / (qty || 1n);
          const useAmt = amount > qty ? qty : amount;
          const costReduction = (avgCostWeiPerUnit * useAmt) / ONE;
          qty -= useAmt;
          costWeth = costWeth > costReduction ? (costWeth - costReduction) : 0n;
        }
        continue;
      }

      // Airdrop: inbound w/o cash (and not bonding-from-token)
      if (to === wallet) {
        airdrops.push({ hash, amount });
        qty += amount; // at 0 cost
      }
    }

    // MTM & USD
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const invCostFloatWeth = Number(costWeth) / 1e18;
    const mtmValueWeth = qtyFloat * Number(priceWeth || 0);
    const unrealizedWeth = mtmValueWeth - invCostFloatWeth;
    const usdValueRemaining = qtyFloat * Number(priceUsd || 0);

    // DUST FLAG (≤5 tokens left => treat as closed for profits/losses view)
    const symUp = String(sym || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(decimals));
    const isDust = (!isEthLike && qty > 0n && qty < MIN_UNITS);

    // Airdrop summary
    let airdropUnits = 0n;
    for (const a of airdrops) airdropUnits += a.amount;
    const airdropQtyFloat = Number(airdropUnits) / Number(scale || 1n);
    const airdropUsd = airdropQtyFloat * Number(priceUsd || 0);

    perToken.push({
      token,
      symbol: sym,
      decimals,
      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),
      realizedWeth: Number(realizedWeth) / 1e18,
      inventoryCostWeth: Number(costWeth) / 1e18,
      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth,
      usdValueRemaining,
      isDust,                 // <-- NEW
      // buy/sell sums for averages if you want to show later
      buyUnits: buyUnits.toString(),
      buyWeiSum: buyWeiSum.toString(),
      sellUnits: sellUnits.toString(),
      sellWeiSum: sellWeiSum.toString(),
      airdrops: {
        count: airdrops.length,
        units: airdropUnits.toString(),
        estUsd: airdropUsd
      }
    });
  }

  // Totals
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

  // Flows
  let wethIn = 0n, wethOut = 0n;
  for (const v of wethDeltaByHash.values()) { if (v > 0n) wethIn += v; else wethOut += (-v); }
  let ethIn = 0n, ethOut = 0n;
  for (const v of ethDeltaByHash.values()) { if (v > 0n) ethIn += v; else ethOut += (-v); }

  const wethInFloat  = Number(wethIn)  / 1e18;
  const wethOutFloat = Number(wethOut) / 1e18;
  const ethInFloat   = Number(ethIn)   / 1e18;
  const ethOutFloat  = Number(ethOut)  / 1e18;

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = wethOutFloat + ethOutFloat;
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Balances
  const [ethBalWei, wethBalWei] = await Promise.all([
    getNativeEthBalance(wallet),
    getWethWalletBalance(wallet)
  ]);
  const ethBalanceFloat  = Number(ethBalWei)  / 1e18;
  const wethBalanceFloat = Number(wethBalWei) / 1e18;
  const ethLikeBalanceFloat = ethBalanceFloat + wethBalanceFloat;

  // Derived views:
  const open = perToken.filter(t => {
    const rem = Number(t.remaining) / (10 ** Number(t.decimals||18));
    return rem > 0 && !t.isDust; // only meaningful open positions
  });

  const airdropsFlat = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({ token:t.token, symbol:t.symbol, decimals:t.decimals, units:t.airdrops.units, estUsd:t.airdrops.estUsd }));

  // Profits/losses should be CLOSED (remaining==0 or isDust)
  const closed = perToken.filter(t => {
    const rem = Number(t.remaining) / (10 ** Number(t.decimals||18));
    return rem === 0 || t.isDust;
  });

  const profitsClosed = closed
    .filter(t => (Number(t.realizedWeth)||0) > 0)
    .sort((a,b)=> Number(b.realizedWeth) - Number(a.realizedWeth));

  const lossesClosed = closed
    .filter(t => (Number(t.realizedWeth)||0) < 0)
    .sort((a,b)=> Number(a.realizedWeth) - Number(b.realizedWeth)); // most negative first

  // For overview top-3
  const top3Profits = profitsClosed.slice(0,3);
  const top3Losses  = lossesClosed.slice(0,3);

  return {
    wallet,
    sinceTs,
    totals: {
      // balances
      ethBalanceFloat,
      wethBalanceFloat,
      ethLikeBalanceFloat,
      // flows
      wethIn: wethIn.toString(),   wethOut: wethOut.toString(),
      ethIn:  ethIn.toString(),    ethOut:  ethOut.toString(),
      wethInFloat,  wethOutFloat,
      ethInFloat,   ethOutFloat,
      // PnL
      realizedWeth: totalRealizedWeth,
      unrealizedWeth: totalUnrealizedWeth,
      totalPnlWeth,
      pnlPct,
      airdropsUsd: totalAirdropUsd,
      holdingsUsd: totalHoldingsUsd
    },
    tokens: perToken,
    derived: {
      open,
      airdrops: airdropsFlat,
      profitsClosed,
      lossesClosed,
      top3Profits,
      top3Losses
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
    '90d':  60*60*24*90,
    'all':  0
  };
  const sinceSec = sinceMap[window] ?? sinceMap['30d'];
  const sinceTs = sinceSec ? Math.floor(Date.now()/1000) - sinceSec : 0;

  const key = `pnl:${wallet.toLowerCase()}:${window}`;
  return withLock(`lock:${key}`, 60, async () => {
    const cached = await getJSON(key);
    if (cached) return cached;
    const data = await computePnL(wallet, { sinceTs });
    await setJSON(key, data, 120);
    return data;
  });
}

// ---------- Worker ----------
new Worker(
  'tabs_pnl',
  async (job) => {
    const { wallet, window } = job.data || {};
    console.log('[PNL] job received', wallet, window);
    const res = await refreshPnl(String(wallet||''), String(window||'30d'));
    console.log('[PNL] job OK');
    return res;
  },
  { connection: bullRedis }
);