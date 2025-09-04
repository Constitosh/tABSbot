// src/pnlWorker.js
// Accurate wallet PnL on Abstract-style chains
// - Merges ETH + WETH legs and **internal** ETH transfers per tx-hash
// - Correctly matches bonding/router/proxy paths (same-hash first, block fallback)
// - FIFO-average cost per token; realized only when tokens leave wallet
// - Dedup + dust filters; no ETH/WETH in positions,
// - Public API: refreshPnl(wallet, window), pnlQueue, worker

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

// Abstract WETH (update if needed)
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Known routers/forwarders (same-block settlements)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // moonshot
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG proxy you gave
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
async function esGET(params) {
  await throttleES();
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Etherscan error';
      if (a === maxAttempts) throw new Error(msg);
    } catch (e) {
      if (a === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 400 * a));
    }
  }
}

// ---------- Quotes (Dexscreener) ----------
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

// ---------- Pull histories ----------
async function getWalletERC20Txs(address, { fromTs=0 } = {}) {
  address = address.toLowerCase();
  let page = 1;
  const PAGE = 1000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account', action: 'tokentx',
      address, page, offset: PAGE, sort: 'asc',
      startblock: 0, endblock: 999999999
    });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) if (Number(r.timeStamp || 0) >= fromTs) out.push(r);
    if (res.length < PAGE || page >= 50) break;
    page++;
  }
  return out;
}
async function getWalletNormalTxs(address, { fromTs=0 } = {}) {
  address = address.toLowerCase();
  let page = 1;
  const PAGE = 10000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account', action: 'txlist',
      address, page, offset: PAGE, sort: 'asc',
      startblock: 0, endblock: 999999999
    });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) if (Number(r.timeStamp || 0) >= fromTs) out.push(r);
    if (res.length < PAGE || page >= 5) break;
    page++;
  }
  return out;
}
// NEW: internal value transfers by address (one sweep, then indexed by hash)
async function getWalletInternalTxs(address, { fromTs=0 } = {}) {
  address = address.toLowerCase();
  let page = 1;
  const PAGE = 10000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account', action: 'txlistinternal',
      address, page, offset: PAGE, sort: 'asc',
      startblock: 0, endblock: 999999999
    });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) if (Number(r.timeStamp || 0) >= fromTs) out.push(r);
    if (res.length < PAGE || page >= 5) break;
    page++;
  }
  return out;
}
async function getEthBalance(address) {
  try {
    const r = await esGET({ module: 'account', action: 'balance', address, tag: 'latest' });
    const s = typeof r === 'string' ? r : (r?.result || '0');
    return s;
  } catch { return '0'; }
}

// ---------- Math ----------
const toBig = (x) => BigInt(String(x || '0'));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // Pull histories + balance in parallel
  const [erc20, normal, internal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getWalletInternalTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // Build per-hash deltas
  const ethByHash   = new Map(); // native value to/from wallet
  const wethByHash  = new Map(); // WETH to/from wallet
  const intrByHash  = new Map(); // internal native to/from wallet
  const blockNet    = new Map(); // blockNumber -> net native+WETH

  // 1) normal native movements
  for (const tx of normal) {
    const h = String(tx.hash); const bn = Number(tx.blockNumber||0);
    const from = String(tx.from||'').toLowerCase();
    const to   = String(tx.to||'').toLowerCase();
    const v    = toBig(tx.value||'0');
    let d = 0n;
    if (to === wallet && v > 0n) d = v; else if (from === wallet && v > 0n) d = -v;
    if (d !== 0n) {
      ethByHash.set(h, add(ethByHash.get(h), d));
      blockNet.set(bn, add(blockNet.get(bn), d));
    }
  }

  // 2) internal native movements (VERY important for precise PnL)
  for (const itx of internal) {
    const h = String(itx.hash); const bn = Number(itx.blockNumber||0);
    const from = String(itx.from||'').toLowerCase();
    const to   = String(itx.to||'').toLowerCase();
    const v    = toBig(itx.value||'0');
    let d = 0n;
    if (to === wallet && v > 0n) d = v; else if (from === wallet && v > 0n) d = -v;
    if (d !== 0n) {
      intrByHash.set(h, add(intrByHash.get(h), d));
      blockNet.set(bn, add(blockNet.get(bn), d));
    }
  }

  // 3) WETH movements and group token transfers by token
  const tokenTxsByToken = new Map();
  for (const r of erc20) {
    const h = String(r.hash); const bn = Number(r.blockNumber||0);
    const token = String(r.contractAddress||'').toLowerCase();
    const from = String(r.from||'').toLowerCase();
    const to   = String(r.to||'').toLowerCase();
    const v    = toBig(r.value||'0');

    if (token === WETH) {
      let d = 0n;
      if (to === wallet) d = v; else if (from === wallet) d = -v;
      if (d !== 0n) {
        wethByHash.set(h, add(wethByHash.get(h), d));
        blockNet.set(bn, add(blockNet.get(bn), d));
      }
      continue;
    }

    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken = [];

  // Iterate each token stream
  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);
    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    let qty = 0n;                 // units currently held
    let costWei = 0n;             // cost basis for remaining
    let realizedWei = 0n;
    let buyWei = 0n, sellWei = 0n;  // for reporting

    // Dedup helper per-hash side (avoid double counting multiple logs)
    const seenHashSide = new Set();

    for (const r of txs) {
      const h = String(r.hash);
      const bn = Number(r.blockNumber||0);
      const from = String(r.from||'').toLowerCase();
      const to   = String(r.to||'').toLowerCase();
      const amt  = toBig(r.value||'0');

      // hash-native (ETH + internal + WETH) net from wallet's POV
      const nativeDelta = add(add(ethByHash.get(h), intrByHash.get(h)), wethByHash.get(h)) || 0n;

      // BUY (token inbound)
      if (to === wallet && !seenHashSide.has(h+':in')) {
        seenHashSide.add(h+':in');
        // If wallet paid native in this tx, that's the cost
        const paid = nativeDelta < 0n ? (-nativeDelta) : 0n;

        // Bonding “mint” (from == token): treat as buy with zero paid if no native leg
        qty += amt;
        costWei += paid;
        buyWei += paid;
        continue;
      }

      // SELL (token outbound)
      if (from === wallet && !seenHashSide.has(h+':out')) {
        seenHashSide.add(h+':out');

        // Prefer same-hash native inflow as proceeds
        let proceeds = nativeDelta > 0n ? nativeDelta : 0n;

        // Router / proxy settle in same block: use block net inflow if present
        if (proceeds === 0n && (KNOWN_ROUTERS.has(to) || to === token)) {
          const blkNet = blockNet.get(bn) || 0n;
          if (blkNet > 0n) proceeds = blkNet;
        }

        // Fallback to price (WETH) if still zero and liquid
        if (proceeds === 0n && priceWeth > 0) {
          // amt tokens * priceWeth WETH per token, scaled to wei
          const amt1e18 = scale > 0n ? (amt * 1_000_000_000_000_000_000n) / scale : 0n;
          const approxWei = Number(amt1e18) * Number(priceWeth);
          proceeds = toBig(Math.floor(approxWei));
        }

        // Average cost per unit (in wei per token-unit)
        const avgCostWeiPerUnit = qty > 0n ? (costWei * 1_000_000_000_000_000_000n) / qty : 0n;
        const useAmt = amt > qty ? qty : amt;
        const costOfSold = (avgCostWeiPerUnit * useAmt) / 1_000_000_000_000_000_000n;

        realizedWei += (proceeds - costOfSold);
        sellWei += proceeds;

        // reduce inventory
        const newQty = qty > useAmt ? (qty - useAmt) : 0n;
        costWei = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }
    }

    // MTM + USD
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const valueUsd = qtyFloat * Number((await getUsdQuote(token)).priceUsd || priceUsd || 0);
    const invCostEth = Number(costWei) / 1e18;
    const mtmEth = qtyFloat * Number(priceWeth || 0);
    const unrealEth = mtmEth - invCostEth;

    // Dust: hide open positions under 5 units (except closed / or if value<1$ we’ll filter in renderer)
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    if (symUp === 'ETH' || symUp === 'WETH') continue; // never list ETH/WETH as tokens

    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,

      // inventory
      remaining: qty.toString(),

      // realized & cost in ETH
      realizedWeth: Number(realizedWei) / 1e18,
      inventoryCostWeth: Number(costWei) / 1e18,

      // totals for % calc in renderer
      totalBuysEth: Number(buyWei) / 1e18,
      totalSellsEth: Number(sellWei) / 1e18,

      // mtm (still used for totals/holdings filtering)
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth: unrealEth,
      usdValueRemaining: valueUsd,
    });
  }

  // Totals
  let totalRealized = 0, totalUnreal = 0, totalHoldUsd = 0;
  for (const r of perToken) {
    totalRealized += Number(r.realizedWeth) || 0;
    totalUnreal   += Number(r.unrealizedWeth) || 0;
    totalHoldUsd  += Number(r.usdValueRemaining) || 0;
  }

  // Native (ETH+WETH) in/out strictly from token trades
  let nativeIn = 0n, nativeOut = 0n;
  for (const [h, v] of ethByHash) {
    const w = (wethByHash.get(h) || 0n) + (intrByHash.get(h) || 0n) + v;
    if (w > 0n) nativeIn += w; else nativeOut += (-w);
  }

  const ethInFloat  = Number(nativeIn)  / 1e18;
  const ethOutFloat = Number(nativeOut) / 1e18;

  const totalPnlEth = totalRealized + totalUnreal;
  const spentBase   = ethOutFloat;
  const pnlPct      = spentBase > 0 ? (totalPnlEth / spentBase) * 100 : 0;

  // Derived lists
  const open = perToken.filter(t => Number(t.remaining) > 0);
  const realizedOnly = perToken.filter(t => Math.abs(Number(t.realizedWeth) || 0) > 1e-12);

  const best  = [...realizedOnly].filter(x => x.realizedWeth > 0)
    .sort((a,b)=> b.realizedWeth - a.realizedWeth);
  const worst = [...realizedOnly].filter(x => x.realizedWeth < 0)
    .sort((a,b)=> a.realizedWeth - b.realizedWeth);

  return {
    wallet, sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,    // live balance
      ethInFloat, ethOutFloat,        // combined ETH+WETH trade flows
      realizedWeth: totalRealized,
      unrealizedWeth: totalUnreal,
      totalPnlWeth: totalPnlEth,
      pnlPct,
      airdropsUsd: 0,                 // (unchanged; if you have airdrop calc keep/use it)
      holdingsUsd: totalHoldUsd
    },
    tokens: perToken,
    derived: { open, best, worst }
  };
}

// ---------- Public API / queue ----------
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const pnlQueueName = 'tabs_pnl';
export const pnlQueue = new Queue(pnlQueueName, { connection: bullRedis });

export async function refreshPnl(wallet, window) {
  const sinceMap = { '24h':86400, '7d':604800, '30d':2592000, '90d':7776000, 'all':0 };
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
    return await refreshPnl(String(wallet||''), String(window||'30d'));
  },
  { connection: bullRedis }
);
