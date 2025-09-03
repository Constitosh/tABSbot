// src/pnlWorker.js
// Accurate wallet PnL for Abstract (ETH+WETH as ETH “base”).
// - Hash-level pairing first; block-level fallback (two-hash same-block router flows).
// - Counts ETH only for matched token trades (ETH IN/OUT are trade flows, not wallet transfers).
// - Bonding buys: token->wallet (from===token) counted as BUY with 0 cost (unrealized handles value).
// - Outbound transfers reduce inventory+cost basis proportionally (no realized PnL).
// - Open dust (<5 tokens) hidden (except ETH/WETH). Profits/Losses include closed-only rows.
// - Exports: refreshPnl(), pnlQueue, worker.

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain constants ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Known router/forwarders (extend if you find more)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router
]);

// ---------- Etherscan v2 client + throttle ----------
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

// ---------- History pulls ----------
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

  const [erc20, normal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // Per-hash ETH/WETH and per-block IN/OUT (not net) + “used” trackers for fallback pairing
  const wethDeltaByHash = new Map(); // hash -> +in/-out
  const ethDeltaByHash  = new Map();

  const blockEthIn  = new Map();  const blockEthOut  = new Map();
  const blockWethIn = new Map();  const blockWethOut = new Map();
  const blockInUsed = new Map();  const blockOutUsed = new Map();

  const tokenTxsByToken = new Map();

  // Normal ETH in/out
  for (const tx of normal) {
    const hash = String(tx.hash);
    const bn   = Number(tx.blockNumber || 0);
    const from = String(tx.from || '').toLowerCase();
    const to   = String(tx.to   || '').toLowerCase();
    const val  = toBig(tx.value || '0');

    if (to === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), val));
      blockEthIn.set(bn, add(blockEthIn.get(bn), val));
    } else if (from === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), -val));
      blockEthOut.set(bn, add(blockEthOut.get(bn), val));
    }
  }

  // WETH in/out; group token transfers
  for (const r of erc20) {
    const hash  = String(r.hash);
    const bn    = Number(r.blockNumber || 0);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

    if (token === WETH) {
      if (to === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), v));
        blockWethIn.set(bn, add(blockWethIn.get(bn), v));
      } else if (from === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), -v));
        blockWethOut.set(bn, add(blockWethOut.get(bn), v));
      }
      continue;
    }

    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken = [];
  let baseInTradeWei  = 0n; // only from matched sells
  let baseOutTradeWei = 0n; // only from matched buys

  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWei = 0n;          // cost basis for remaining (wei)
    let realizedWei = 0n;      // realized PnL (wei)
    let buysUnits = 0n, sellsUnits = 0n;

    let totalBuyWei  = 0n;     // sum paid on buys (wei)
    let totalSellWei = 0n;     // sum received on sells (wei)

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    for (const r of txs) {
      const hash   = String(r.hash);
      const bn     = Number(r.blockNumber || 0);
      const to     = String(r.to   || '').toLowerCase();
      const from   = String(r.from || '').toLowerCase();
      const amt    = toBig(r.value || '0');

      const wd = wethDeltaByHash.get(hash) || 0n;
      const ed = ethDeltaByHash.get(hash)  || 0n;
      const sameHashPaid  = (ed  < 0n ? -ed  : 0n) + (wd < 0n ? -wd : 0n);
      const sameHashRecv  = (ed  > 0n ?  ed  : 0n) + (wd > 0n ?  wd : 0n);

      // ---- BUY: token in ----
      if (to === wallet) {
        let paidWei = sameHashPaid;

        // block-level fallback (two-hash router flow): consume remaining block base-out
        if (paidWei === 0n && (KNOWN_ROUTERS.has(from) || true)) {
          const outAvail = add(blockEthOut.get(bn), blockWethOut.get(bn)) || 0n;
          const used     = blockOutUsed.get(bn) || 0n;
          const rem      = outAvail > used ? (outAvail - used) : 0n;
          if (rem > 0n) {
            paidWei = rem;
            blockOutUsed.set(bn, used + paidWei);
          }
        }

        // bonding (from == token) is a buy with zero cost
        if (from === token && paidWei === 0n) {
          buysUnits += amt;
          qty       += amt;
          // cost stays the same; unrealized will reflect value
          continue;
        }

        if (paidWei > 0n) {
          buysUnits += amt;
          qty       += amt;
          costWei   += paidWei;
          totalBuyWei += paidWei;
          baseOutTradeWei += paidWei; // counted as ETH OUT for trades
          continue;
        }

        // If we get here: inbound token with no matched base leg -> airdrop
        airdrops.push({ hash, amount: amt });
        qty += amt; // add at zero cost
        continue;
      }

      // ---- SELL: token out ----
      if (from === wallet) {
        let proceeds = sameHashRecv;

        // block-level fallback (two-hash router flow): consume remaining block base-in
        if (proceeds === 0n && (KNOWN_ROUTERS.has(to) || true)) {
          const inAvail = add(blockEthIn.get(bn), blockWethIn.get(bn)) || 0n;
          const used    = blockInUsed.get(bn) || 0n;
          const rem     = inAvail > used ? (inAvail - used) : 0n;
          if (rem > 0n) {
            proceeds = rem;
            blockInUsed.set(bn, used + proceeds);
          }
        }

        // If still 0, treat as gift/internal out: reduce qty+cost basis proportionally
        if (proceeds === 0n) {
          if (qty > 0n) {
            const avgCostWeiPerUnit = (costWei * 1_000_000_000_000_000_000n) / (qty || 1n);
            const amtUsed = amt > qty ? qty : amt;
            const reduce  = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;
            qty -= amtUsed;
            costWei = costWei > reduce ? (costWei - reduce) : 0n;
          }
          continue;
        }

        // Real sell
        sellsUnits += amt;

        const sellUnits = amt > qty ? qty : amt; // cap if out-of-sync
        const avgCostWeiPerUnit = qty > 0n ? (costWei * 1_000_000_000_000_000_000n) / qty : 0n;
        const costOfSold = (avgCostWeiPerUnit * sellUnits) / 1_000_000_000_000_000_000n;

        realizedWei += (proceeds - costOfSold);

        const newQty = qty > sellUnits ? (qty - sellUnits) : 0n;
        costWei = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;

        totalSellWei += proceeds;
        baseInTradeWei += proceeds; // counted as ETH IN for trades
        continue;
      }
    }

    // Mark-to-market + USD
    const qtyFloat   = Number(qty) / Number(scale || 1n);
    const invCostW   = Number(costWei) / 1e18;
    const mtmW       = qtyFloat * Number((await getWethQuote(token)).priceWeth || 0);
    const unrealW    = mtmW - invCostW;
    const usdValue   = (await getUsdQuote(token)).priceUsd * qtyFloat;

    // Dust filter: hide OPEN positions <5 tokens (except ETH/WETH)
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen    = qty > 0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    if (!isDustOpen) {
      perToken.push({
        token,
        symbol: txs[0]?.tokenSymbol || '',
        decimals: tokenDecimals,

        buys: buysUnits.toString(),
        sells: sellsUnits.toString(),
        remaining: qty.toString(),

        totalBuyBase: Number(totalBuyWei)  / 1e18,
        totalSellBase: Number(totalSellWei) / 1e18,

        realizedBase: Number(realizedWei) / 1e18,
        unrealizedBase: unrealW,

        usdValueRemaining: usdValue,

        airdrops: {
          count: airdrops.length,
          units: airdrops.reduce((a,b)=> a + Number(b.amount||0n), 0),
          estUsd: 0 // per-token airdrop $ not needed in lists; totals below handle USD
        }
      });
    }
  }

  // Totals across tokens
  let totalRealizedBase   = 0;
  let totalUnrealizedBase = 0;
  let totalHoldingsUsd    = 0;
  for (const r of perToken) {
    totalRealizedBase   += Number(r.realizedBase) || 0;
    totalUnrealizedBase += Number(r.unrealizedBase) || 0;
    totalHoldingsUsd    += Number(r.usdValueRemaining || 0);
  }

  // ETH IN/OUT (only trades)
  const baseInFloat  = Number(baseInTradeWei)  / 1e18;
  const baseOutFloat = Number(baseOutTradeWei) / 1e18;

  const totalPnlBase = totalRealizedBase + totalUnrealizedBase;
  const spentBase    = baseOutFloat;
  const pnlPct       = spentBase > 0 ? (totalPnlBase / spentBase) * 100 : 0;

  // Derived lists
  const MIN_UNITS_CLOSED = (r) => {
    const q = BigInt(r.remaining || '0');
    const dec = Number(r.decimals || 18);
    const min = 5n * (10n ** BigInt(dec));
    const isEthLike = (String(r.symbol||'').toUpperCase() === 'ETH' || String(r.symbol||'').toUpperCase() === 'WETH');
    return (q === 0n) || ( (!isEthLike) && (q < min) ); // closed or only dust left
  };

  const closed = perToken.filter(MIN_UNITS_CLOSED);
  const profits = closed.filter(r => Number(r.realizedBase) > 0)
                        .sort((a,b)=> Number(b.realizedBase)-Number(a.realizedBase))
                        .slice(0,15);
  const losses  = closed.filter(r => Number(r.realizedBase) < 0)
                        .sort((a,b)=> Number(a.realizedBase)-Number(b.realizedBase))
                        .slice(0,15);
  const open    = perToken.filter(r => BigInt(r.remaining||'0') > 0n);

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,

      baseIn:  baseInFloat,
      baseOut: baseOutFloat,

      realizedBase: totalRealizedBase,
      unrealizedBase: totalUnrealizedBase,
      totalPnlBase,
      pnlPct,
      holdingsUsd: totalHoldingsUsd,
      airdropsUsd: 0 // (optional) aggregate if you decide to price airdrops
    },
    tokens: perToken,
    derived: {
      open,
      best: profits,
      worst: losses
    }
  };
}

// ---------- Public API with caching + Worker ----------
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
    await setJSON(key, data, 120);
    return data;
  });
}

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