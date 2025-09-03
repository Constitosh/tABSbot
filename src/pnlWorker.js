// src/pnlWorker.js
// Wallet PnL for Abstract chain.
// Goals:
//  • Classify only TOKEN<->(ETH|WETH) trades (hash-level; router/token fallbacks at block-level)
//  • Average-cost inventory per token
//  • Realized PnL = proceeds − proportional cost when position is (partially) sold
//  • "Closed trades" = remaining < 5 tokens (dust threshold) → counted in Profits/Losses
//  • Open positions = remaining >= 5 tokens
//  • ETH/WETH combined as "base" (still export the separate breakdown if you want to show it)
//  • Ignore bare transfers in ETH-IN/OUT totals (only include swaps)
//  • Handle bonding-phase buys (from === token) as BUY (not airdrop)
//  • Gifts/internal moves of tokens: reduce qty + cost basis proportionally; do NOT touch ETH totals
//  • Airdrops = inbound token with no base leg and not from token; tracked but not in trade totals

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain constants (Abstract) ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Router/forwarders used on Abstract (add to this list if you discover more)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router/forwarder
]);

// ---------- Etherscan v2 client + throttle ----------
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
async function getEthBalance(wallet) {
  try {
    const r = await esGET({ module: 'account', action: 'balance', address: wallet, tag: 'latest' }, { tag:'[balance]' });
    const s = typeof r === 'string' ? r : (r?.result || '0');
    return s;
  } catch { return '0'; }
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // 1) Pull histories + live ETH balance
  const [erc20, normal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // 2) Build base deltas per tx-hash and block (only for classification — totals are computed from trades)
  const wethDeltaByHash = new Map(); // txHash -> +in/-out (wei)
  const ethDeltaByHash  = new Map(); // txHash -> +in/-out (wei)
  const blockEthNet     = new Map(); // blockNumber -> +in/-out (wei)
  const blockWethNet    = new Map(); // blockNumber -> +in/-out (wei)
  const tokenTxsByToken = new Map(); // tokenCA -> txs[]

  // Native ETH (+ block net)
  for (const tx of normal) {
    const hash  = String(tx.hash);
    const bn    = Number(tx.blockNumber || 0);
    const from  = String(tx.from || '').toLowerCase();
    const to    = String(tx.to   || '').toLowerCase();
    const val   = toBig(tx.value || '0');

    let d = 0n;
    if (to === wallet && val > 0n) d = val;        // +in
    else if (from === wallet && val > 0n) d = -val; // -out

    if (d !== 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), d));
      blockEthNet.set(bn, add(blockEthNet.get(bn), d));
    }
  }

  // WETH (+ block net) and group token txs
  for (const r of erc20) {
    const hash  = String(r.hash);
    const bn    = Number(r.blockNumber || 0);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

    if (token === WETH) {
      let d = 0n;
      if (to === wallet) d = v; else if (from === wallet) d = -v;
      if (d !== 0n) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), d));
        blockWethNet.set(bn, add(blockWethNet.get(bn), d));
      }
      continue;
    }

    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken = [];
  // Totals (ONLY from trades)
  let totalBaseInWei  = 0n; // ETH+WETH IN from trades
  let totalBaseOutWei = 0n; // ETH+WETH OUT for trades

  for (const [token, txs] of tokenTxsByToken.entries()) {
    // sort chronologically (stable)
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // units held
    let costBase = 0n;         // wei (ETH-equivalent) cost basis of remaining
    let realizedBase = 0n;     // realized PnL in wei
    let buysUnits = 0n, sellsUnits = 0n;

    // Also keep total buy/sell base to compute per-token realized % and to decide closed winners/losers
    let totalBuyBase = 0n;  // sum of wei spent on buys for this token (only trade legs)
    let totalSellBase = 0n; // sum of wei received on sells for this token (only trade legs)

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    for (const r of txs) {
      const hash = String(r.hash);
      const bn   = Number(r.blockNumber || 0);
      const to   = String(r.to   || '').toLowerCase();
      const from = String(r.from || '').toLowerCase();
      const amt  = toBig(r.value || '0');

      const dW = wethDeltaByHash.get(hash) || 0n;
      const dE = ethDeltaByHash.get(hash)  || 0n;

      const paidWei = (dE < 0n ? -dE : 0n) + (dW < 0n ? -dW : 0n);
      const recvWei = (dE > 0n ?  dE : 0n) + (dW > 0n ?  dW : 0n);

      // -------- BUY: token to wallet with base spent OR from token (bonding pool) --------
      if (to === wallet && (paidWei > 0n || from === token)) {
        buysUnits += amt;
        qty += amt;

        // Only increment "trade totals" if we actually spent base in this tx
        if (paidWei > 0n) {
          costBase += paidWei;
          totalBuyBase += paidWei;
          totalBaseOutWei += paidWei; // global ETH OUT for trades
        } else {
          // bonding from token: treat as zero-cost inventory; MTM will value it
        }
        continue;
      }

      // -------- SELL: token from wallet and base received in the SAME tx --------
      if (from === wallet && recvWei > 0n) {
        sellsUnits += amt;

        const avgCostWeiPerUnit = qty > 0n ? (costBase * 1_000_000_000_000_000_000n) / qty : 0n;
        const amtUsed  = amt > qty ? qty : amt;
        const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

        realizedBase += (recvWei - costOfSold);

        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costBase = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;

        totalSellBase += recvWei;
        totalBaseInWei += recvWei; // global ETH IN for trades
        continue;
      }

      // -------- ROUTER/TOKEN SETTLEMENT sell: no base in hash but present at block level --------
      if (from === wallet && recvWei === 0n && (KNOWN_ROUTERS.has(to) || to === token)) {
        // try block-level net as proceeds
        const blkIn = add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n;
        let proceeds = blkIn > 0n ? blkIn : 0n;

        // fallback to priceWeth if still 0 and we have liquidity
        if (proceeds === 0n && priceWeth > 0) {
          // estProceedsWei ≈ amt * priceWeth * 1e18 / scale
          const amtScaled1e18 = scale > 0n ? (amt * 1_000_000_000_000_000_000n) / scale : 0n;
          // Number(amtScaled1e18) safe because <= 1e18; priceWeth is ~double
          proceeds = toBig(Math.floor(Number(amtScaled1e18) * Number(priceWeth)));
        }

        sellsUnits += amt;
        const avgCostWeiPerUnit = qty > 0n ? (costBase * 1_000_000_000_000_000_000n) / qty : 0n;
        const amtUsed  = amt > qty ? qty : amt;
        const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

        realizedBase += (proceeds - costOfSold);

        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costBase = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;

        totalSellBase += proceeds;
        if (proceeds > 0n) totalBaseInWei += proceeds;
        continue;
      }

      // -------- GIFT/INTERNAL OUT: reduce inventory + cost basis proportionally, no trade totals --------
      if (from === wallet && recvWei === 0n) {
        if (qty > 0n) {
          const avgCostWeiPerUnit = (costBase * 1_000_000_000_000_000_000n) / (qty || 1n);
          const amtUsed = amt > qty ? qty : amt;
          const costReduction = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;
          qty -= amtUsed;
          costBase = costBase > costReduction ? (costBase - costReduction) : 0n;
        }
        continue;
      }

      // -------- AIRDROP: in without base and not from token --------
      if (to === wallet && paidWei === 0n && from !== token) {
        airdrops.push({ hash, amount: amt });
        qty += amt; // zero cost
        continue;
      }
    }

    // Mark-to-market for remaining
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const invCostFloat = Number(costBase) / 1e18;
    const mtmValueBase = qtyFloat * Number(priceWeth || 0);
    const unrealizedBase = mtmValueBase - invCostFloat;
    const usdValue = qtyFloat * Number(priceUsd || 0);

    // Airdrop USD
    let adUnits = 0n; for (const a of airdrops) adUnits += a.amount;
    const adQty = Number(adUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    // Dust threshold for "open" visibility (but keep closed positions for realized reporting)
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen = qty > 0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    // Per-token record
    const row = {
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,

      buysUnits: buysUnits.toString(),   // token units
      sellsUnits: sellsUnits.toString(), // token units
      remaining: qty.toString(),         // token units

      totalBuyBase: Number(totalBuyBase) / 1e18,     // ETH float
      totalSellBase: Number(totalSellBase) / 1e18,   // ETH float

      realizedBase: Number(realizedBase) / 1e18,     // ETH float
      inventoryCostBase: Number(costBase) / 1e18,    // ETH float
      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),

      unrealizedBase,                                   // ETH float
      usdValueRemaining: usdValue,                      // USD float

      airdrops: {
        count: airdrops.length,
        units: adUnits.toString(),
        estUsd: adUsd
      },

      // convenience flags for UI logic
      _isOpenVisible: !isDustOpen,                      // you can filter in renderer
      _isClosed: !isOpen || isDustOpen
    };

    perToken.push(row);
  }

  // 3) Totals (only from trades)
  const baseInFloat  = Number(totalBaseInWei)  / 1e18;
  const baseOutFloat = Number(totalBaseOutWei) / 1e18;

  // Aggregate across tokens
  let totalRealized = 0;
  let totalUnreal   = 0;
  let totalAirdropUsd = 0;
  let totalHoldingsUsd = 0;

  for (const r of perToken) {
    totalRealized   += Number(r.realizedBase) || 0;
    totalUnreal     += Number(r.unrealizedBase) || 0;
    totalAirdropUsd += Number(r.airdrops?.estUsd || 0);
    totalHoldingsUsd+= Number(r.usdValueRemaining || 0);
  }

  const totalPnlBase = totalRealized + totalUnreal;
  const spentBase    = baseOutFloat; // what we paid for trades
  const pnlPct       = spentBase > 0 ? (totalPnlBase / spentBase) * 100 : 0;

  // 4) Derived lists for UI:
  // Open positions = remaining ≥ 5 tokens (or ETH/WETH) and >0
  const openPositions = perToken.filter(t => Number(t.remaining) > 0 && t._isOpenVisible);

  // Closed trades for leaderboards = positions with remaining < 5 tokens (dust) OR exactly 0
  const closed = perToken.filter(t => t._isClosed);

  // “Realized PnL per token” = totalSellBase − proportional cost of sold units.
  // We already computed realizedBase using average-cost; expose top winners/losers using realizedBase.
  const closedWithRealized = closed.filter(t => Math.abs(Number(t.realizedBase)||0) > 0);

  const best = [...closedWithRealized]
    .sort((a,b)=> (Number(b.realizedBase)||0) - (Number(a.realizedBase)||0))
    .slice(0, 15);

  const worst = [...closedWithRealized]
    .sort((a,b)=> (Number(a.realizedBase)||0) - (Number(b.realizedBase)||0))
    .slice(0, 15);

  return {
    wallet,
    sinceTs,

    totals: {
      // live wallet balance for header
      ethBalance: ethBalanceFloat,

      // Base (ETH+WETH) actually used in trades
      baseIn:  baseInFloat,
      baseOut: baseOutFloat,

      // If you still want the raw per-asset deltas, you can compute them elsewhere from trades.
      // (We don’t export ethIn/ethOut/wethIn/wethOut anymore to avoid confusion with non-trade transfers.)

      realizedBase:  totalRealized,
      unrealizedBase: totalUnreal,
      totalPnlBase: totalPnlBase,
      pnlPct,

      holdingsUsd: totalHoldingsUsd,
      airdropsUsd: totalAirdropUsd
    },

    tokens: perToken,

    derived: {
      open: openPositions,
      best,
      worst,
    }
  };
}

// ---------- Public API with caching + Worker/Queue exports ----------
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

  const key = `pnl:${String(wallet).toLowerCase()}:${window}`;
  return withLock(`lock:${key}`, 60, async () => {
    const cached = await getJSON(key);
    if (cached) return cached;
    const data = await computePnL(wallet, { sinceTs });
    await setJSON(key, data, 120); // 2 min cache
    return data;
  });
}

// Worker to warm/recompute on demand (pm2-friendly)
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