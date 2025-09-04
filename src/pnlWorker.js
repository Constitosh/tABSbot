// src/pnlWorker.js
// Wallet PnL for Abstract (ETH + WETH combined to ETH in output).
// - Classifies buys/sells from ERC20 + normal TXs (ETH) + WETH transfers.
// - Handles bonding/proxy trades by using block-level ETH+WETH net flows and known router addresses.
// - Falls back to price-based proceeds only if no ETH/WETH leg found.
// - Any outbound token with no ETH/WETH leg and not via known routers -> transfer/gift (reduce inventory & cost basis, no realized).
// - Exposes per-token totals: totalBuysEth, totalSellsEth (for “Bought … / Sold …” in the UI).
// - Provides wallet ethBalance, aggregated ethIn/ethOut (only trade legs), realized/unrealized WETH-equiv, USD holdings & airdrops.

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain + Routers ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

// Abstract WETH
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Known routers / forwarders (expand as you discover more)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot bonding/forwarder
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG buy/sell forwarder (as reported)
]);

// ---------- Etherscan v2 client with throttle ----------
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

// ---------- Dexscreener (quotes) ----------
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

// ---------- Etherscan pulls ----------
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
    }, { logOnce: page===1, tag:'[tokentx]' });

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
    }, { logOnce: page===1, tag:'[txlist]' });

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

// Safe BigInt->number division by 1e18 (ETH)
const weiToEth = (weiBig) => Number(weiBig) / 1e18;

// ---------- Core ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  const [erc20, normal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // Build ETH & WETH deltas per tx-hash and per block
  const wethDeltaByHash = new Map(); // txHash -> +in / -out (wei)
  const ethDeltaByHash  = new Map(); // txHash -> +in / -out (wei)
  const blockEthNet     = new Map(); // blockNumber -> net +in/-out (wei)
  const blockWethNet    = new Map(); // blockNumber -> net +in/-out (wei)
  const tokenTxsByToken = new Map(); // tokenCA -> txs[]

  // Native ETH deltas (+ block net)
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

  // WETH deltas (+ block net) and group token txs
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

  // Totals across tokens
  let totalRealizedWeth   = 0;
  let totalUnrealizedWeth = 0;
  let totalAirdropUsd     = 0;
  let totalHoldingsUsd    = 0;

  // ETH/WETH totals strictly from trade legs (not arbitrary transfers)
  let tradedEthInWei  = 0n; // ETH received from token sells
  let tradedEthOutWei = 0n; // ETH paid for token buys

  const perToken = [];

  for (const [token, txs] of tokenTxsByToken.entries()) {
    // Sort robustly (ts, block, tx index, log index)
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    const sym = txs[0]?.tokenSymbol || '';
    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;          // units held
    let costW = 0n;        // cost basis for remaining (wei)
    let realizedW = 0n;    // realized PnL (wei)
    let buys = 0n, sells = 0n;

    // For UI
    let buyWeiSum  = 0n;   // total ETH/WETH spent
    let sellWeiSum = 0n;   // total ETH/WETH received

    const airdrops = [];

    for (const r of txs) {
      const hash   = String(r.hash);
      const bn     = Number(r.blockNumber || 0);
      const to     = String(r.to   || '').toLowerCase();
      const from   = String(r.from || '').toLowerCase();
      const amt    = toBig(r.value || '0');

      // Hash-level legs
      const wethHash = wethDeltaByHash.get(hash) || 0n;
      const ethHash  = ethDeltaByHash.get(hash)  || 0n;
      const paidWei  = (ethHash  < 0n ? -ethHash  : 0n) + (wethHash < 0n ? -wethHash : 0n);
      const recvWei  = (ethHash  > 0n ?  ethHash  : 0n) + (wethHash > 0n ?  wethHash : 0n);

      // BUY (same-hash ETH/WETH paid)
      if (to === wallet && paidWei > 0n) {
        buys += amt; qty += amt; costW += paidWei;
        tradedEthOutWei += paidWei; buyWeiSum += paidWei;
        continue;
      }

      // SELL (same-hash ETH/WETH received)
      if (from === wallet && recvWei > 0n) {
        sells += amt;

        const useAmt = amt > qty ? qty : amt;
        const avgCost = qty > 0n ? (costW * 1_000_000_000_000_000_000n) / qty : 0n;
        const costSold = (avgCost * useAmt) / 1_000_000_000_000_000_000n;

        realizedW += (recvWei - costSold);
        tradedEthInWei += recvWei; sellWeiSum += recvWei;

        // reduce inventory
        const newQty = qty > useAmt ? (qty - useAmt) : 0n;
        costW = newQty > 0n ? (avgCost * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // Router/bonding: token->wallet buys (from==token or KNOWN_ROUTERS)
      if (to === wallet && (from === token || KNOWN_ROUTERS.has(from))) {
        // Approximate ETH paid from block net ETH+WETH out
        const blkOut = add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n;
        const paid = blkOut < 0n ? (-blkOut) : 0n;

        if (paid > 0n) {
          buys += amt; qty += amt; costW += paid;
          tradedEthOutWei += paid; buyWeiSum += paid;
        } else {
          // No observed ETH out => treat as airdrop (0 cost) to avoid false paid legs
          airdrops.push({ hash, amount: amt });
          qty += amt;
        }
        continue;
      }

      // Router/proxy sells: wallet->token or wallet->router with no hash-level recv
      if (from === wallet && (KNOWN_ROUTERS.has(to) || to === token)) {
        const blkIn = add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n;
        let recv = blkIn > 0n ? blkIn : 0n;

        // Fallback: estimate from price if nothing else
        if (recv === 0n && priceWeth > 0) {
          // recvWei ≈ amt * priceWeth * 1e18 / scale
          const amtScaled1e18 = scale > 0n ? (amt * 1_000_000_000_000_000_000n) / scale : 0n;
          const approx = Math.floor(Number(amtScaled1e18) * Number(priceWeth));
          recv = toBig(approx);
        }

        sells += amt;
        const useAmt = amt > qty ? qty : amt;
        const avgCost = qty > 0n ? (costW * 1_000_000_000_000_000_000n) / qty : 0n;
        const costSold = (avgCost * useAmt) / 1_000_000_000_000_000_000n;

        realizedW += (recv - costSold);
        if (recv > 0n) { tradedEthInWei += recv; sellWeiSum += recv; }

        const newQty = qty > useAmt ? (qty - useAmt) : 0n;
        costW = newQty > 0n ? (avgCost * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // Gift/internal out (no ETH/WETH leg, not via router/token)
      if (from === wallet && recvWei === 0n) {
        if (qty > 0n) {
          const useAmt = amt > qty ? qty : amt;
          const avgCost = (costW * 1_000_000_000_000_000_000n) / (qty || 1n);
          const costRed = (avgCost * useAmt) / 1_000_000_000_000_000_000n;
          qty -= useAmt;
          costW = costW > costRed ? (costW - costRed) : 0n;
        }
        continue;
      }

      // Inbound airdrop (no ETH/WETH, and not from token)
      if (to === wallet && paidWei === 0n && from !== token) {
        airdrops.push({ hash, amount: amt });
        qty += amt; // zero cost
        continue;
      }

      // Otherwise: ignore neutral/noise
    }

    // Mark-to-market unrealized and USD valuation
    const qtyFloat   = Number(qty) / Number(scale || 1n);
    const invCostW   = Number(costW) / 1e18;
    const mtmW       = qtyFloat * Number(priceWeth || 0);
    const unrealW    = mtmW - invCostW;
    const usdValue   = qtyFloat * Number(priceUsd || 0);

    // Airdrops USD estimate
    let adUnits = 0n;
    for (const a of airdrops) adUnits += a.amount;
    const adQty = Number(adUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    // Per-token row
    perToken.push({
      token,
      symbol: sym || '',
      decimals: tokenDecimals,

      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),

      // realized/unrealized in ETH-equivalent (WETH)
      realizedWeth: Number(realizedW) / 1e18,
      inventoryCostWeth: Number(costW) / 1e18,

      // NEW: totals for display
      totalBuysEth:  Number(buyWeiSum)  / 1e18,
      totalSellsEth: Number(sellWeiSum) / 1e18,

      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth: unrealW,
      usdValueRemaining: usdValue,

      airdrops: {
        count: airdrops.length,
        units: adUnits.toString(),
        estUsd: adUsd
      }
    });

    // Accumulate totals
    totalRealizedWeth   += Number(realizedW) / 1e18;
    totalUnrealizedWeth += unrealW;
    totalAirdropUsd     += adUsd;
    totalHoldingsUsd    += usdValue;
  }

  // Convert traded ETH in/out to floats
  const ethInFloat  = weiToEth(tradedEthInWei);
  const ethOutFloat = weiToEth(tradedEthOutWei);

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = ethOutFloat; // denominator for % PnL (only outflow spent)
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Derived sets for UI
  const openPositions = perToken.filter(t => {
    try { return BigInt(String(t.remaining||'0')) > 0n; } catch { return false; }
  });

  const airdropsFlat  = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, units: t.airdrops.units, estUsd: t.airdrops.estUsd }));

  // Realized leaders are computed in the renderer using t.realizedWeth (and we exclude ETH/WETH there)

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,     // wallet ETH (float)

      // Combined ETH/WETH — but ONLY trade legs (not arbitrary transfers)
      ethInFloat,
      ethOutFloat,

      // PnL aggregates (ETH-equivalent)
      realizedWeth: totalRealizedWeth,
      unrealizedWeth: totalUnrealizedWeth,
      totalPnlWeth,
      pnlPct,

      // USD aggregates
      airdropsUsd: totalAirdropUsd,
      holdingsUsd: totalHoldingsUsd
    },
    tokens: perToken,
    derived: {
      open: openPositions,
      airdrops: airdropsFlat,
      // best/worst will be derived from realized in the renderer to enforce closed-only & filters
    }
  };
}

// ---------- Public API with caching + Worker/Queue ----------
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
    await setJSON(key, data, 120); // cache 2 min
    return data;
  });
}

// Worker to recompute on demand (warm cache)
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