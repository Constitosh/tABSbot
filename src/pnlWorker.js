// src/pnlWorker.js
// Wallet PnL for Abstract chain (ETH + WETH).
// - ETH/WETH deltas at tx-hash level + block-level net (to catch router/proxy settlements)
// - Bonding-phase buys: token->wallet (from === token) counted as BUY (not airdrop)
// - Any outbound token reduces inventory & cost basis (proportional) even without ETH/WETH leg
// - Quotes from Dexscreener (priceUsd + priceNative=WETH per token)
// - Dust filter: hide open positions < 5 tokens (except ETH/WETH), but keep closed positions for realized PnL
// - Exports: refreshPnl(), pnlQueue (BullMQ), worker

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

// Router/forwarders treated as swaps/settlement in bonding/proxy flows
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router seen in bonding
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
async function getEthBalanceWei(address) {
  try {
    const res = await esGET({ module: 'account', action: 'balance', address, tag: 'latest' }, { tag:'[PNL eth balance]' });
    const weiStr = typeof res === 'string' ? res : (res?.result || '0');
    return BigInt(weiStr);
  } catch { return 0n; }
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // 1) Pull histories + current ETH balance
  const [erc20, normal, ethBalWei] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getEthBalanceWei(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWei) / 1e18;

  // Build ETH & WETH deltas per tx-hash (+block net) and group token txs
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
    theToken: {
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
        break theToken;
      }

      if (to !== wallet && from !== wallet) break theToken;
      if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
      tokenTxsByToken.get(token).push(r);
    }
  }

  const perToken = [];

  for (const [token, txs] of tokenTxsByToken.entries()) {
    // Chrono sort within token
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    // One-shot quotes used for MTM + fallback
    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWeth = 0n;         // cost basis for remaining (wei)
    let realizedWeth = 0n;     // realized PnL (wei)
    let buys = 0n, sells = 0n; // token units

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    for (const r of txs) {
      const hash   = String(r.hash);
      const bn     = Number(r.blockNumber || 0);
      const to     = String(r.to   || '').toLowerCase();
      const from   = String(r.from || '').toLowerCase();
      const amt    = toBig(r.value || '0');

      const wethHash = wethDeltaByHash.get(hash) || 0n;
      const ethHash  = ethDeltaByHash.get(hash)  || 0n;
      const paidWei  = (ethHash  < 0n ? -ethHash  : 0n) + (wethHash < 0n ? -wethHash : 0n);
      const recvWei  = (ethHash  > 0n ?  ethHash  : 0n) + (wethHash > 0n ?  wethHash : 0n);

      // BUY: wallet receives token and either pays ETH/WETH OR comes from token contract (bonding leg)
      if (to === wallet && (paidWei > 0n || from === token)) {
        buys += amt;
        qty  += amt;
        costWeth += paidWei; // if bonding-from-token and paidWei==0, cost stays; MTM handles valuation
        continue;
      }

      // SELL (same-hash): wallet sends token and receives ETH/WETH in same tx
      if (from === wallet && recvWei > 0n) {
        sells += amt;

        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const proceeds = recvWei;
        const amtUsed  = amt > qty ? qty : amt;
        const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

        realizedWeth += (proceeds - costOfSold);

        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // PROXY / ROUTER SELL (different-hash settlement):
      // If token leaves wallet, but hash-level recvWei==0, look for block-level ETH/WETH net inflow.
      if (from === wallet && recvWei === 0n && (KNOWN_ROUTERS.has(to) || to === token)) {
        const blkInWei = add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n;
        let proceeds = blkInWei > 0n ? blkInWei : 0n;

        // Fallback to price if still zero and we have liquidity
        if (proceeds === 0n && priceWeth > 0) {
          // estProceedsWei = amt * priceWeth * 1e18 / scale
          const amtScaled1e18 = scale > 0n ? (amt * 1_000_000_000_000_000_000n) / scale : 0n;
          // Convert 1e18 "tokens" * priceWeth (WETH) => wei
          proceeds = toBig(Math.floor(Number(amtScaled1e18) * Number(priceWeth)));
        }

        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const amtUsed  = amt > qty ? qty : amt;
        const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

        realizedWeth += (proceeds - costOfSold);

        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        sells += amt;
        continue;
      }

      // GIFT / INTERNAL OUT (no ETH/WETH proceeds and not a router/token): reduce qty + cost basis proportionally
      if (from === wallet && recvWei === 0n) {
        if (qty > 0n) {
          const avgCostWeiPerUnit = (costWeth * 1_000_000_000_000_000_000n) / (qty || 1n);
          const amtUsed = amt > qty ? qty : amt;
          const costReduction = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;
          qty -= amtUsed;
          costWeth = costWeth > costReduction ? (costWeth - costReduction) : 0n;
        }
        continue;
      }

      // AIRDROP: inbound token with no ETH/WETH leg and not from token (avoid bonding false positives)
      if (to === wallet && paidWei === 0n && from !== token) {
        airdrops.push({ hash, amount: amt });
        qty += amt; // at zero cost
        continue;
      }
    }

    // Mark-to-market + USD
    const qtyFloat   = Number(qty) / Number(scale || 1n);
    const invCostW   = Number(costWeth) / 1e18;
    const mtmW       = qtyFloat * Number(priceWeth || 0);
    const unrealW    = mtmW - invCostW;
    const usdValue   = qtyFloat * Number(priceUsd || 0);

    // Airdrops USD
    let adUnits = 0n;
    for (const a of airdrops) adUnits += a.amount;
    const adQty = Number(adUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    // Dust filter: hide open positions < 5 tokens (except ETH/WETH)
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen = qty > 0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    if (!isDustOpen) {
      perToken.push({
        token,
        symbol: txs[0]?.tokenSymbol || '',
        decimals: tokenDecimals,

        buys: buys.toString(),
        sells: sells.toString(),
        remaining: qty.toString(),

        realizedWeth: Number(realizedWeth) / 1e18,  // float (WETH/ETH)
        inventoryCostWeth: Number(costWeth) / 1e18, // float (WETH/ETH)
        priceUsd: Number(priceUsd || 0),
        priceWeth: Number(priceWeth || 0),
        unrealizedWeth: unrealW,                     // float (WETH/ETH)
        usdValueRemaining: usdValue,                 // float (USD)

        airdrops: {
          count: airdrops.length,
          units: adUnits.toString(),
          estUsd: adUsd
        }
      });
    }
  }

  // Totals across tokens
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
  for (const v of wethDeltaByHash.values()) { if (v > 0n) wethIn += v; else wethOut += (-v); }
  let ethIn = 0n, ethOut = 0n;
  for (const v of ethDeltaByHash.values())  { if (v > 0n)  ethIn += v; else  ethOut += (-v); }

  const wethInFloat  = Number(wethIn)  / 1e18;
  const wethOutFloat = Number(wethOut) / 1e18;
  const ethInFloat   = Number(ethIn)   / 1e18;
  const ethOutFloat  = Number(ethOut)  / 1e18;

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = wethOutFloat + ethOutFloat;
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Derived sets for UI
  const openPositions = perToken.filter(t => Number(t.remaining) > 0);
  const airdropsFlat  = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, units: t.airdrops.units, estUsd: t.airdrops.estUsd }));

  // Realized (by realized PnL only) — renderer will filter to closed-only lists
  const realizedOnly = perToken.filter(t => Math.abs(Number(t.realizedWeth) || 0) > 0);
  const best  = [...realizedOnly].sort((a,b)=> (Number(b.realizedWeth)||0) - (Number(a.realizedWeth)||0)).slice(0, 15);
  const worst = [...realizedOnly].sort((a,b)=> (Number(a.realizedWeth)||0) - (Number(b.realizedWeth)||0)).slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      // Wallet ETH balance (native)
      ethBalanceFloat,

      // Raw in/out
      wethIn: wethIn.toString(),   wethOut: wethOut.toString(),
      ethIn:  ethIn.toString(),    ethOut:  ethOut.toString(),

      // Floats in/out
      wethInFloat,  wethOutFloat,
      ethInFloat,   ethOutFloat,

      // PnL aggregates (WETH-equivalent)
      realizedWeth: totalRealizedWeth,
      unrealizedWeth: totalUnrealizedWeth,
      totalPnlWeth,
      pnlPct,

      // USD views
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

// Worker to warm/recompute on demand
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