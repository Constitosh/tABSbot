// src/pnlWorker.js
// Precise wallet PnL (Abstract chain) with hash-level ETH+WETH netting.
// - Avoids ETH+WETH double counting in a single tx (wrap+swap)
// - Handles bonding-phase mints (from token contract) as buys
// - Only counts base flows attached to token activity for ETH IN/OUT
// - Realized PnL via average cost; profits/losses sorted; closed only
// - Open positions: no ETH/WETH, hide <$1, no MTM line
// - NFT (ERC-721) airdrops: collection name + count
// - Exports: refreshPnl(), pnlQueueName, pnlQueue, Worker

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

/* =========================
   Chain / API configuration
   ========================= */
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract
if (!ES_KEY) console.warn('[PNL] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

/** Routers / forwarders / telegram bot proxies frequently seen */
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot/forwarder
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG proxy (user supplied)
]);

/* ===== Etherscan client with throttle ===== */
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

async function esGET(params, { tag='' } = {}) {
  await throttleES();
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Etherscan error';
      if (a === maxAttempts) throw new Error(`Etherscan v2: ${msg}`);
    } catch (e) { if (a === maxAttempts) throw e; }
    await new Promise(r => setTimeout(r, 350 * a));
  }
  return [];
}

/* ==============
   Quote helpers
   ============== */
async function getUsdQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 12_000 });
    if (Array.isArray(data) && data.length) return Number(data[0]?.priceUsd || 0) || 0;
    return Number(data?.priceUsd || 0) || 0;
  } catch { return 0; }
}
async function getWethQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 12_000 });
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    const abs = ps.filter(p => String(p?.chainId).toLowerCase() === 'abstract');
    abs.sort((a,b) =>
      (Number(b?.liquidity?.usd||0) - Number(a?.liquidity?.usd||0)) ||
      (Number(b?.volume?.h24||0)    - Number(a?.volume?.h24||0)));
    return Number(abs[0]?.priceNative || 0) || 0;
  } catch { return 0; }
}
async function getQuotes(ca) {
  const [usd, weth] = await Promise.all([getUsdQuote(ca), getWethQuote(ca)]);
  return { priceUsd: usd, priceWeth: weth };
}

/* ======================
   Etherscan pull helpers
   ====================== */
async function getWalletNormalTxs(wallet, { fromTs = 0 } = {}) {
  wallet = wallet.toLowerCase();
  const out = [];
  let page = 1;
  const PAGE = 10000;
  while (true) {
    const res = await esGET({
      module: 'account', action: 'txlist', address: wallet,
      startblock: 0, endblock: 999999999, page, offset: PAGE, sort: 'asc'
    });
    if (!Array.isArray(res) || !res.length) break;
    for (const r of res) {
      if (Number(r.timeStamp || 0) >= fromTs) out.push(r);
    }
    if (res.length < PAGE || page >= 5) break;
    page++;
  }
  return out;
}

async function getWalletERC20Txs(wallet, { fromTs = 0 } = {}) {
  wallet = wallet.toLowerCase();
  const out = [];
  let page = 1;
  const PAGE = 1000;
  while (true) {
    const res = await esGET({
      module: 'account', action: 'tokentx', address: wallet,
      startblock: 0, endblock: 999999999, page, offset: PAGE, sort: 'asc'
    });
    if (!Array.isArray(res) || !res.length) break;
    for (const r of res) {
      if (Number(r.timeStamp || 0) >= fromTs) out.push(r);
    }
    if (res.length < PAGE || page >= 50) break;
    page++;
  }
  return out;
}

async function getWalletERC721Txs(wallet, { fromTs = 0 } = {}) {
  wallet = wallet.toLowerCase();
  const out = [];
  let page = 1;
  const PAGE = 1000;
  while (true) {
    const res = await esGET({
      module: 'account', action: 'tokennfttx', address: wallet,
      startblock: 0, endblock: 999999999, page, offset: PAGE, sort: 'asc'
    });
    if (!Array.isArray(res) || !res.length) break;
    for (const r of res) {
      if (Number(r.timeStamp || 0) >= fromTs) out.push(r);
    }
    if (res.length < PAGE || page >= 20) break;
    page++;
  }
  return out;
}

async function getEthBalance(wallet) {
  try {
    const r = await esGET({ module: 'account', action: 'balance', address: wallet, tag: 'latest' });
    return typeof r === 'string' ? r : String(r?.result || '0');
  } catch { return '0'; }
}

/* =========
   Utilities
   ========= */
const toBig = (x) => BigInt(String(x || '0'));
const add   = (a,b) => (a||0n) + (b||0n);
const ZERO  = 0n;

function bnToFloatEth(wei) { return Number(wei) / 1e18; }
function clampBig(n) { return n < 0n ? 0n : n; }

/* ===========================
   Core: computePnL per wallet
   =========================== */
async function computePnL(wallet, { sinceTs = 0 }) {
  wallet = wallet.toLowerCase();

  const [normal, erc20, erc721, ethBalWeiStr] = await Promise.all([
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletERC721Txs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);

  const ethBalanceFloat = bnToFloatEth(toBig(ethBalWeiStr));

  // ---- Hash aggregators ----
  /** hash -> { bn, ts, eth: bigint, weth: bigint, baseNet: bigint, tokenMoves: Map(token => {in:bigint,out:bigint,froms:Set,tos:Set,decimals, symbol}) } */
  const byHash = new Map();
  function ensureHash(h, bn, ts) {
    if (!byHash.has(h)) byHash.set(h, {
      bn: Number(bn||0), ts: Number(ts||0),
      eth: ZERO, weth: ZERO, baseNet: ZERO,
      tokenMoves: new Map(),
    });
    return byHash.get(h);
  }

  // 1) Native ETH deltas
  for (const tx of normal) {
    const h  = String(tx.hash);
    const to = String(tx.to || '').toLowerCase();
    const fr = String(tx.from || '').toLowerCase();
    const v  = toBig(tx.value || '0');
    const bn = tx.blockNumber, ts = tx.timeStamp;

    const rec = ensureHash(h, bn, ts);
    if (to === wallet && v > 0n) rec.eth = add(rec.eth, v);
    else if (fr === wallet && v > 0n) rec.eth = add(rec.eth, -v);
  }

  // 2) ERC20 deltas (WETH & tokens)
  const seenLog = new Set();
  for (const r of erc20) {
    const key = `${r.hash}:${r.logIndex || r.transactionIndex || ''}`;
    if (seenLog.has(key)) continue;
    seenLog.add(key);

    const h  = String(r.hash);
    const bn = r.blockNumber, ts = r.timeStamp;
    const token = String(r.contractAddress || '').toLowerCase();
    const to = String(r.to || '').toLowerCase();
    const fr = String(r.from || '').toLowerCase();
    const v  = toBig(r.value || '0');

    const rec = ensureHash(h, bn, ts);

    if (token === WETH) {
      if (to === wallet) rec.weth = add(rec.weth, v);
      else if (fr === wallet) rec.weth = add(rec.weth, -v);
    } else {
      if (!rec.tokenMoves.has(token)) {
        rec.tokenMoves.set(token, {
          in: ZERO, out: ZERO, froms: new Set(), tos: new Set(),
          decimals: Math.max(0, Number(r.tokenDecimal || 18)),
          symbol: r.tokenSymbol || '',
        });
      }
      const tm = rec.tokenMoves.get(token);
      if (to === wallet) { tm.in = add(tm.in, v); tm.froms.add(fr); }
      if (fr === wallet) { tm.out = add(tm.out, v); tm.tos.add(to); }
    }
  }

  // Compute baseNet (ETH + WETH) per hash
  for (const rec of byHash.values()) {
    rec.baseNet = add(rec.eth, rec.weth); // >0 net in (sell), <0 net out (buy)
  }

  // 3) Block-level base net map (fallback for router-settled sells)
  const baseByBlock = new Map(); // blockNumber -> baseNet sum
  for (const rec of byHash.values()) {
    baseByBlock.set(rec.bn, add(baseByBlock.get(rec.bn), rec.baseNet));
  }

  // 4) Per-token running PnL
  const perToken = new Map(); // token -> state
  function getTokenState(token, symbol, decimals) {
    if (!perToken.has(token)) perToken.set(token, {
      token, symbol, decimals,
      qty: ZERO,         // units
      costWei: ZERO,     // remaining cost-basis in wei
      realizedWei: ZERO, // realized PnL in wei (can be <0)
      buyWei: ZERO,      // gross spent (for summaries)
      sellWei: ZERO,     // gross received (for summaries)
      airdropsUnits: ZERO,
      hasTrade: false,
    });
    return perToken.get(token);
  }

  // Iterate hashes in chronological order
  const hashes = [...byHash.entries()]
    .sort((a,b) => (a[1].ts - b[1].ts) || (a[1].bn - b[1].bn));

  for (const [hash, rec] of hashes) {
    if (!rec.tokenMoves.size) continue; // ignore pure base transfers

    // If exactly one token is involved, we can allocate the entire baseNet to it.
    const tokensHere = [...rec.tokenMoves.keys()];
    const singleToken = tokensHere.length === 1 ? tokensHere[0] : null;

    for (const [token, tm] of rec.tokenMoves.entries()) {
      const st = getTokenState(token, tm.symbol, tm.decimals);
      const scale = 10n ** BigInt(tm.decimals || 18);

      // Base flows for this token in this hash
      let paidWei = 0n, recvWei = 0n;

      // PRIMARY: hash-level base net + direction
      if (singleToken) {
        if (tm.in > 0n && rec.baseNet < 0n) paidWei = -rec.baseNet;      // BUY
        if (tm.out > 0n && rec.baseNet > 0n) recvWei = rec.baseNet;      // SELL
      }

      // SECONDARY: bonding/token mint or router settlement in same block
      if (paidWei === 0n && recvWei === 0n) {
        const fromIsToken = tm.froms.has(token);
        const toIsRouter  = [...tm.tos].some(a => KNOWN_ROUTERS.has(String(a)));
        if (tm.in > 0n && (fromIsToken || rec.baseNet < 0n)) {
          // mint / bonding buy or swap buy with missing base; use block net if positive outflow
          const blk = baseByBlock.get(rec.bn) || 0n;
          if (blk < 0n) paidWei = -blk;
        } else if (tm.out > 0n && (toIsRouter || rec.baseNet === 0n)) {
          const blk = baseByBlock.get(rec.bn) || 0n;
          if (blk > 0n) recvWei = blk;
        }
      }

      // FINAL FALLBACK: Dexscreener price (only when base is still zero)
      if ((tm.in > 0n && paidWei === 0n) || (tm.out > 0n && recvWei === 0n)) {
        const { priceWeth } = await getQuotes(token);
        if (priceWeth > 0) {
          // tokens * priceWeth (WETH per token) -> wei
          const amt = tm.in > 0n ? tm.in : tm.out;
          const amt_1e18 = (amt * 1_000_000_000_000_000_000n) / (scale || 1n);
          const estWei = toBig(Math.floor(Number(amt_1e18) * Number(priceWeth)));
          if (tm.in > 0n && paidWei === 0n)  paidWei = estWei;
          if (tm.out > 0n && recvWei === 0n) recvWei = estWei;
        }
      }

      // Classify actions and update running average-cost PnL
      if (tm.in > 0n && (paidWei > 0n || tm.froms.has(token))) {
        // BUY (swap or bonding mint). If mint with no cost, paidWei may be 0.
        st.qty = add(st.qty, tm.in);
        st.costWei = add(st.costWei, paidWei);
        st.buyWei = add(st.buyWei, paidWei);
        st.hasTrade = true;
      }

      if (tm.out > 0n && (recvWei > 0n || KNOWN_ROUTERS.has([...tm.tos][0] || ''))) {
        // SELL (swap or router settlement)
        const sellAmt = tm.out > st.qty ? st.qty : tm.out;
        const avgCostPerUnitWei = st.qty > 0n ? (st.costWei * 1_000_000_000_000_000_000n) / st.qty : 0n;
        const costOfSold = (avgCostPerUnitWei * sellAmt) / 1_000_000_000_000_000_000n;

        st.realizedWei = add(st.realizedWei, add(recvWei, -costOfSold));
        st.sellWei = add(st.sellWei, recvWei);

        const newQty = st.qty - sellAmt;
        st.qty = newQty < 0n ? 0n : newQty;
        st.costWei = st.qty > 0n ? (avgCostPerUnitWei * st.qty) / 1_000_000_000_000_000_000n : 0n;
        st.hasTrade = true;
      }

      // Token "airdrops": inbound with zero base & not from token? we’ll log as token airdrop units.
      if (tm.in > 0n && paidWei === 0n && !tm.froms.has(token)) {
        st.airdropsUnits = add(st.airdropsUnits, tm.in);
      }
    }
  }

  // Mark-to-market for open positions (USD)
  const tokensOut = [];
  let totalRealized = 0;
  let totalUnrealized = 0;
  let totalHoldUsd = 0;
  let totalAirdropUsd = 0;

  for (const st of perToken.values()) {
    const { priceUsd, priceWeth } = await getQuotes(st.token);
    const scale = 10n ** BigInt(st.decimals || 18);

    const qtyFloat = Number(st.qty) / Number(scale || 1n);
    const invCostW = bnToFloatEth(st.costWei);
    const mtmW = qtyFloat * (Number(priceWeth || 0));
    const unrealW = mtmW - invCostW;
    const usdValue = qtyFloat * (Number(priceUsd || 0));

    totalRealized += bnToFloatEth(st.realizedWei);
    totalUnrealized += unrealW;
    totalHoldUsd += usdValue;

    // Airdrops USD (ERC20)
    const adQty = Number(st.airdropsUnits) / Number(scale || 1n);
    totalAirdropUsd += adQty * (Number(priceUsd || 0));

    tokensOut.push({
      token: st.token,
      symbol: st.symbol,
      decimals: st.decimals,
      remainingUnits: st.qty.toString(),
      remainingUsd: usdValue,
      inventoryCostWeth: invCostW,
      unrealizedWeth: unrealW,
      realizedWeth: bnToFloatEth(st.realizedWei),
      totalBuyWeth: bnToFloatEth(st.buyWei),
      totalSellWeth: bnToFloatEth(st.sellWei),
      airdropsUnits: st.airdropsUnits.toString(),
    });
  }

  // ETH/WETH IN/OUT that are related to token activity only
  let baseIn = 0n, baseOut = 0n;
  for (const rec of byHash.values()) {
    if (!rec.tokenMoves.size) continue; // ignore pure base transfers
    if (rec.baseNet > 0n) baseIn = add(baseIn, rec.baseNet);
    if (rec.baseNet < 0n) baseOut = add(baseOut, -rec.baseNet);
  }

  const baseInF  = bnToFloatEth(baseIn);
  const baseOutF = bnToFloatEth(baseOut);

  const totalPnlWeth = totalRealized + totalUnrealized;
  const spentBase    = baseOutF;
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // ----- Build derived lists (robust) -----
  // A position counts as closed if remaining units are zero, or it's just dust (<$1).
  const realizedClosed = tokensOut
    .filter(t => {
      const isEthLike = (t.symbol || '').toUpperCase() === 'ETH' ||
                        (t.symbol || '').toUpperCase() === 'WETH' ||
                        t.token === WETH;
      if (isEthLike) return false;
      const remUnits = BigInt(t.remainingUnits || '0');
      const isClosed = remUnits === 0n || Number(t.remainingUsd || 0) < 1;
      const hasRealized = Math.abs(Number(t.realizedWeth || 0)) > 1e-9;
      return isClosed && hasRealized;
    });

  // Sort: profits high→low, losses low→high (most negative first)
  const profits = realizedClosed
    .filter(t => Number(t.realizedWeth) > 0)
    .sort((a,b) => Number(b.realizedWeth) - Number(a.realizedWeth));

  const losses = realizedClosed
    .filter(t => Number(t.realizedWeth) < 0)
    .sort((a,b) => Number(a.realizedWeth) - Number(b.realizedWeth));

  // Open positions: hide ETH/WETH, hide <$1, and do not show MTM in UI (renderer).
  const open = tokensOut.filter(t => {
    const isEthLike = (t.symbol || '').toUpperCase() === 'ETH' ||
                      (t.symbol || '').toUpperCase() === 'WETH' ||
                      t.token === WETH;
    const remUnits = BigInt(t.remainingUnits || '0');
    return !isEthLike && remUnits > 0n && Number(t.remainingUsd || 0) >= 1;
  });

  // NFT airdrops were already computed above as `nftDrops`.

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,
      ethInFloat: baseInF,    // token-related base only
      ethOutFloat: baseOutF,
      realizedWeth: totalRealized,
      unrealizedWeth: totalUnrealized,
      totalPnlWeth,
      pnlPct,
      holdingsUsd: totalHoldUsd,
      airdropsUsd: totalAirdropUsd,
    },
    tokens: tokensOut,
    derived: {
      open,
      profits,
      losses,
      nfts: nftDrops,
    }
  };


/* ================================
   Public API + cache + worker/queue
   ================================ */
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

export const pnlQueueName = 'tabs_pnl';
export const pnlQueue     = new Queue(pnlQueueName, { connection: bullRedis });

export async function refreshPnl(wallet, window) {
  const sinceMap = {
    '24h': 60*60*24,
    '7d':  60*60*24*7,
    '30d': 60*60*24*30,
    '90d': 60*60*24*90,
    'all': 0
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

// Worker to warm/recompute
new Worker(
  pnlQueueName,
  async (job) => {
    const { wallet, window } = job.data || {};
    const res = await refreshPnl(String(wallet||''), String(window||'30d'));
    return res;
  },
  { connection: bullRedis }
);
