// src/pnlWorker.js
// Wallet PnL for Abstract chain (ETH + WETH).
//
// Improvements for Moonshot bonding & bundles:
// • Combine WETH+ETH legs per tx-hash (wallet perspective).
// • If a token transfer has no cash leg in the same hash, try a NEARBY pairing:
//   - BUY pairing: token inbound (to=wallet) + nearest ETH/WETH OUT (unused) within ±60s / ±1 block
//   - SELL pairing: token outbound (from=wallet) + nearest ETH/WETH IN (unused) within ±60s / ±1 block
// • Treat inbound from token contract (bonding pool ≡ token) as BUY; try to pair; if no cash leg found, cost=0.
// • Subtract any outbound token transfer from inventory; reduce cost basis proportionally (no realized PnL if no cash in).
// • Hide dust < 5 tokens (except ETH/WETH).
//
// Public API (unchanged):
//   export async function refreshPnl(wallet, window)
//   -> returns { wallet, sinceTs, totals, tokens, derived{ open, airdrops, best, worst } }
//
// Notes:
// - KNOWN_FORWARDERS includes the Moonshot forwarder 0x0D6848… (extend as needed).
// - Time/Block windows are tunable via JOIN_SEC/JOIN_BLOCKS.

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain constants (Abstract) ----------
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Moonshot / routing helpers (extendable)
const KNOWN_FORWARDERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot forwarder observed
]);

// Loose-join tunables
const JOIN_SEC = 60;      // seconds around transfer timestamp
const JOIN_BLOCKS = 1;    // +/- blocks around transfer block

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

// Normal (native ETH) txs so we can detect ETH legs (bonding etc.)
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
const toBig = (x) => BigInt(String(x || '0'));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Nearby matching helpers ----------
function withinJoinWindow(a, b) {
  // a, b: { blockNumber, timeStamp }
  const dt = Math.abs(Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
  const db = Math.abs(Number(a.blockNumber || 0) - Number(b.blockNumber || 0));
  return (dt <= JOIN_SEC) || (db <= JOIN_BLOCKS);
}

// pick nearest unused cash leg by time distance
function pickNearestCash(transfer, candidates, used) {
  let best = null;
  let bestScore = Infinity;
  for (let i=0; i<candidates.length; i++) {
    const c = candidates[i];
    if (used.has(i)) continue;
    if (!withinJoinWindow(transfer, c)) continue;
    const score = Math.abs(Number(transfer.timeStamp || 0) - Number(c.timeStamp || 0));
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best; // index into candidates[] or null
}

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // 1) Pull histories
  const [erc20, normal] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs })
  ]);

  // 2) Build ETH & WETH deltas per tx-hash (wallet perspective) + cash leg arrays
  const wethDeltaByHash = new Map(); // txHash -> +in / -out (wei)
  const ethDeltaByHash  = new Map(); // txHash -> +in / -out (wei)

  const cashOut = []; // [{hash, blockNumber, timeStamp, wei}]
  const cashIn  = []; // [{hash, blockNumber, timeStamp, wei}]

  // Native ETH deltas
  for (const tx of normal) {
    const hash = String(tx.hash);
    const from = String(tx.from || '').toLowerCase();
    const to   = String(tx.to   || '').toLowerCase();
    const val  = toBig(tx.value || '0');

    const rec = {
      hash,
      blockNumber: Number(tx.blockNumber || 0),
      timeStamp:   Number(tx.timeStamp || 0),
      wei: val
    };

    if (to === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), val));   // +in
      cashIn.push(rec);
    } else if (from === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), -val));  // -out
      cashOut.push({ ...rec, wei: -val }); // store as negative for clarity
    }
  }

  // WETH deltas (ERC20)
  for (const r of erc20) {
    const hash  = String(r.hash);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

    if (token === WETH) {
      const rec = {
        hash,
        blockNumber: Number(r.blockNumber || 0),
        timeStamp:   Number(r.timeStamp   || 0),
        wei: v
      };
      if (to === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), v));   // +in
        cashIn.push(rec);
      } else if (from === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), -v));  // -out
        cashOut.push({ ...rec, wei: -v });
      }
    }
  }

  // Sort cash legs by time for nearest matching
  cashOut.sort((a,b)=> (a.timeStamp-b.timeStamp) || (a.blockNumber-b.blockNumber));
  cashIn.sort ((a,b)=> (a.timeStamp-b.timeStamp) || (a.blockNumber-b.blockNumber));

  const usedOut = new Set(); // indices consumed by joins
  const usedIn  = new Set();

  // 3) Group non-WETH token transfers per token + keep raw events to allow near-by matching
  const tokenTxsByToken = new Map(); // tokenCA -> array of normalized events
  for (const r of erc20) {
    const token = String(r.contractAddress || '').toLowerCase();
    if (token === WETH) continue;

    const ev = {
      token,
      hash:        String(r.hash),
      blockNumber: Number(r.blockNumber || 0),
      timeStamp:   Number(r.timeStamp || 0),
      to:   String(r.to   || '').toLowerCase(),
      from: String(r.from || '').toLowerCase(),
      amount: toBig(r.value || '0'),
      decimals: Math.max(0, Number(r.tokenDecimal || 18)),
      symbol: r.tokenSymbol || '',
    };

    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(ev);
  }

  // 4) For each token, sort events and classify buys/sells using:
  //    (A) same-hash cash legs if present
  //    (B) otherwise, nearby pairing (±60s / ±1 block) with unused cash legs
  const perToken = [];

  for (const [token, txsRaw] of tokenTxsByToken.entries()) {
    txsRaw.sort((a,b)=> a.timeStamp-b.timeStamp || a.blockNumber-b.blockNumber);

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWeth = 0n;         // total cost of current inventory (wei; ETH+WETH together)
    let realizedWeth = 0n;     // realized PnL in wei
    let buys = 0n, sells = 0n;
    const airdrops = [];

    const decimals = txsRaw[0]?.decimals ?? 18;
    const scale = 10n ** BigInt(decimals);
    const sym = txsRaw[0]?.symbol || '';

    for (const ev of txsRaw) {
      const { hash, to, from, amount } = ev;

      // Cash legs in same hash
      const wethΔ = wethDeltaByHash.get(hash) || 0n;
      const ethΔ  = ethDeltaByHash.get(hash)  || 0n;
      const paidWei = (ethΔ < 0n ? -ethΔ : 0n) + (wethΔ < 0n ? -wethΔ : 0n);
      const recvWei = (ethΔ > 0n ?  ethΔ : 0n) + (wethΔ > 0n ?  wethΔ : 0n);

      // Heuristics for "isBuy"/"isSell"
      let isBuy  = false;
      let isSell = false;
      let buyWei = 0n;
      let sellWei = 0n;

      // A) Same-hash legs
      if (to === wallet && paidWei > 0n) { isBuy = true;  buyWei  = paidWei; }
      if (from === wallet && recvWei > 0n){ isSell = true; sellWei = recvWei; }

      // B) No same-hash cash? Try nearby pairing
      if (!isBuy && to === wallet && paidWei === 0n) {
        // bonding/forwarder cases — prefer if from==token, or from in forwarders, or generic inbound
        if (from === token || KNOWN_FORWARDERS.has(from) || true) {
          const idx = pickNearestCash(ev, cashOut, usedOut);
          if (idx !== null) {
            isBuy = true; buyWei = (-cashOut[idx].wei); // cashOut stores negative
            usedOut.add(idx);
          }
        }
      }
      if (!isSell && from === wallet && recvWei === 0n) {
        const idx = pickNearestCash(ev, cashIn, usedIn);
        if (idx !== null) {
          isSell = true; sellWei = cashIn[idx].wei;
          usedIn.add(idx);
        }
      }

      if (isBuy) {
        buys += amount;
        qty  += amount;
        costWeth += buyWei;  // can be 0 in pure-bonding edge-case
        continue;
      }

      if (isSell) {
        sells += amount;

        // average cost per unit (wei per token) using 1e18 scaling to avoid precision loss
        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const proceeds = sellWei; // wei
        const amtUsed = amount > qty ? qty : amount;
        const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

        realizedWeth += (proceeds - costOfSold);

        // reduce inventory; recompute costWeth from avgCost (avoid drift)
        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // Gift / internal out (no cash in)
      if (from === wallet) {
        if (qty > 0n) {
          const avgCostWeiPerUnit = (costWeth * 1_000_000_000_000_000_000n) / (qty || 1n);
          const amtUsed = amount > qty ? qty : amount;
          const costReduction = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;
          qty -= amtUsed;
          costWeth = costWeth > costReduction ? (costWeth - costReduction) : 0n;
        }
        continue;
      }

      // Inbound with no cash leg after pairing — count as airdrop (but still add to inventory at 0 cost)
      if (to === wallet) {
        airdrops.push({ hash, amount });
        qty += amount;
      }
    }

    // Mark-to-market & USD valuation
    const qtyFloatTokens   = Number(qty) / Number(scale || 1n);
    const invCostFloatWeth = Number(costWeth) / 1e18;
    const mtmValueWeth     = qtyFloatTokens * Number(priceWeth || 0);
    const unrealizedWeth   = mtmValueWeth - invCostFloatWeth;
    const usdValueRemaining = qtyFloatTokens * Number(priceUsd || 0);

    // Hide dust < 5 tokens (except ETH/WETH symbols)
    const symUp = String(sym || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(decimals));
    const hideDust = (qty > 0n && !isEthLike && qty < MIN_UNITS);

    if (!hideDust) {
      // summarize airdrops
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
        airdrops: {
          count: airdrops.length,
          units: airdropUnits.toString(),
          estUsd: airdropUsd
        }
      });
    }
  }

  // 5) Totals across tokens
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

  // Wallet ETH/WETH net flows (all hashes)
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

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = wethOutFloat + ethOutFloat; // denominator for PnL%
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Derivatives for views
  const openPositions = perToken
    .filter(t => Number(t.remaining) > 0)
    .map(t => ({ ...t }));

  const airdropsFlat = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({
      token: t.token,
      symbol: t.symbol,
      decimals: t.decimals,
      units: t.airdrops.units,
      estUsd: t.airdrops.estUsd
    }));

  const ranked = perToken
    .map(t => ({ ...t, totalImpact: (Number(t.realizedWeth)||0) + (Number(t.unrealizedWeth)||0) }))
    .sort((a,b)=> Math.abs(b.totalImpact) - Math.abs(a.totalImpact));

  const best  = [...ranked].sort((a,b)=> b.totalImpact - a.totalImpact).slice(0, 15);
  const worst = [...ranked].sort((a,b)=> a.totalImpact - b.totalImpact).slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      // Raw
      wethIn: wethIn.toString(),   wethOut: wethOut.toString(),
      ethIn:  ethIn.toString(),    ethOut:  ethOut.toString(),
      // Floats
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
      open: openPositions,
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