// src/pnlWorker.js
// Wallet PnL for Abstract chain (ETH + WETH).
//
// Adds:
// • Native ETH balance fetch (account.balance) -> totals.ethBalanceFloat
// • Closed vs open positions tagging (closed if remaining <= 5 tokens)
// • Profits/Losses lists show only CLOSED positions (realized-only ranking)
// • Combine ETH+WETH cash legs for PnL% and totals.
// • Bonding-phase buys: treat inbound-from-token as BUY (no false airdrops)
// • Subtract any outbound token transfers from inventory (adjust cost proportionally)
// • NEW: Forwarder-aware + block-level cash pairing to catch Moonshot proxy flows
//        (e.g. 0x0d6848e3... forwarder). If no cash leg on same tx-hash, pair with
//        unmatched ETH/WETH delta in the same block.

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// ---- Forwarders / proxies (expandable)
const FORWARDERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba', // Moonshot forwarder (observed)
]);

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

// ---------- Wallet histories ----------
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
async function getEthBalanceWei(wallet) {
  try {
    const res = await esGET(
      { module:'account', action:'balance', address: wallet, tag:'latest' },
      { logOnce:true, tag:'[PNL balance]' }
    );
    const v = Array.isArray(res) ? res[0]?.balance : res?.balance ?? res;
    return BigInt(String(v || '0'));
  } catch { return 0n; }
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  const [erc20, normal, ethBalWei] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getEthBalanceWei(wallet)
  ]);

  // cash legs
  const wethDeltaByHash = new Map(); // txHash -> +in / -out (wei)
  const ethDeltaByHash  = new Map(); // txHash -> +in / -out (wei)
  const tokenTxsByToken = new Map(); // tokenCA -> txs[]

  // We'll also index ETH/WETH deltas by blockNumber so we can pair when
  // the cash leg is NOT in the same tx-hash (forwarder flows).
  const cashPosByBlock = new Map(); // block -> [{hash, amount>0, consumed:false}]
  const cashNegByBlock = new Map(); // block -> [{hash, amount<0 (store abs), consumed:false}]

  function addCash(blockNumber, hash, deltaWei) {
    if (deltaWei === 0n) return;
    if (deltaWei > 0n) {
      const arr = cashPosByBlock.get(blockNumber) || [];
      arr.push({ hash, amount: deltaWei, consumed: false });
      cashPosByBlock.set(blockNumber, arr);
    } else {
      const arr = cashNegByBlock.get(blockNumber) || [];
      arr.push({ hash, amount: (-deltaWei), consumed: false }); // store abs
      cashNegByBlock.set(blockNumber, arr);
    }
  }
  function takeCashFromBlock(blockNumber, sign /* 'pos'|'neg' */) {
    const arr = (sign === 'pos' ? cashPosByBlock.get(blockNumber) : cashNegByBlock.get(blockNumber)) || [];
    for (const item of arr) {
      if (!item.consumed && item.amount > 0n) {
        item.consumed = true;
        return item.amount; // wei (positive)
      }
    }
    return 0n;
  }

  // native ETH
  for (const tx of normal) {
    const hash = String(tx.hash);
    const bn   = Number(tx.blockNumber || 0);
    const from = String(tx.from || '').toLowerCase();
    const to   = String(tx.to   || '').toLowerCase();
    const val  = toBig(tx.value || '0');
    if (to === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), val));
      addCash(bn, hash, +val);
    } else if (from === wallet && val > 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), -val));
      addCash(bn, hash, -val);
    }
  }

  // WETH + group per token
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
        addCash(bn, hash, +v);
      } else if (from === wallet) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), -v));
        addCash(bn, hash, -v);
      }
      continue;
    }
    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken = [];
  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) => Number(a.timeStamp)-Number(b.timeStamp) || Number(a.logIndex||0)-Number(b.logIndex||0));

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWeth = 0n;         // total cost of current inventory (wei, ETH+WETH-equivalent)
    let realizedWeth = 0n;     // realized PnL (wei)
    let buys = 0n, sells = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    for (const r of txs) {
      const hash = String(r.hash);
      const bn   = Number(r.blockNumber || 0);
      const to   = String(r.to   || '').toLowerCase();
      const from = String(r.from || '').toLowerCase();
      const amt  = toBig(r.value || '0');

      const wethDelta = wethDeltaByHash.get(hash) || 0n;
      const ethDelta  = ethDeltaByHash.get(hash)  || 0n;
      let paidWei   = (ethDelta < 0n ? -ethDelta : 0n) + (wethDelta < 0n ? -wethDelta : 0n);
      let recvWei   = (ethDelta > 0n ?  ethDelta : 0n) + (wethDelta > 0n ?  wethDelta : 0n);

      const fromIsToken     = (from === token);
      const fromIsForwarder = FORWARDERS.has(from);
      const toIsForwarder   = FORWARDERS.has(to);

      // BUY (cash leg OR bonding pool == token OR forwarder with same-block pairing)
      if (to === wallet && (paidWei > 0n || fromIsToken || fromIsForwarder)) {
        if (paidWei === 0n && (fromIsToken || fromIsForwarder)) {
          // try to pair with unmatched cash OUT in the same block
          const paired = takeCashFromBlock(bn, 'neg'); // returns abs(wei) or 0n
          if (paired > 0n) paidWei = paired;
        }
        buys += amt;
        qty  += amt;
        costWeth += paidWei; // may be 0 if still unpaired; mark-to-market handles unrealized
        continue;
      }

      // SELL (cash leg OR forwarder with same-block pairing)
      if (from === wallet && (recvWei > 0n || toIsForwarder)) {
        if (recvWei === 0n && toIsForwarder) {
          // try to pair with unmatched cash IN in the same block
          const paired = takeCashFromBlock(bn, 'pos');
          if (paired > 0n) recvWei = paired;
        }

        sells += amt;
        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const proceeds  = recvWei;
        const costSold  = (avgCostWeiPerUnit * amt) / 1_000_000_000_000_000_000n;
        realizedWeth   += (proceeds - costSold);

        const newQty = qty > amt ? (qty - amt) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // OUT without cash (gift/internal): reduce inventory + proportional cost, no realized pnl
      if (from === wallet && recvWei === 0n) {
        if (qty > 0n) {
          const avgCost = (costWeth * 1_000_000_000_000_000_000n) / (qty || 1n);
          const useAmt = amt > qty ? qty : amt;
          const costRed = (avgCost * useAmt) / 1_000_000_000_000_000_000n;
          qty -= useAmt;
          costWeth = costWeth > costRed ? (costWeth - costRed) : 0n;
        }
        continue;
      }

      // AIRDROP: inbound with no cash leg and not from token/forwarder (avoid bonding/forwarders)
      if (to === wallet && paidWei === 0n && !fromIsToken && !fromIsForwarder) {
        airdrops.push({ hash, amount: amt });
        qty += amt; // 0 cost
        continue;
      }
    }

    // Hide dust (< 5 tokens)
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    // (We keep the position in perToken for PnL accounting; view logic will treat <=5 as closed.)

    const remainingUnitsFloat = Number(qty) / Number(scale || 1n);
    const invCostFloatWeth = Number(costWeth) / 1e18;
    const mtmValueWeth     = remainingUnitsFloat * Number(priceWeth || 0);
    const unrealizedWeth   = mtmValueWeth - invCostFloatWeth;
    const usdValueRemaining = remainingUnitsFloat * Number(priceUsd || 0);

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
      remaining: qty.toString(),         // raw units (string)
      remainingUnitsFloat,               // number
      realizedWeth: Number(realizedWeth) / 1e18,
      inventoryCostWeth: Number(costWeth) / 1e18,
      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth,                    // number (WETH-equiv)
      usdValueRemaining,                 // number

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

  // Wallet ETH/WETH net flows
  let wethIn = 0n, wethOut = 0n;
  for (const v of (function*(){ for (const x of new Map(wethDeltaByHash).values()) yield x; })()) {
    if (v > 0n) wethIn += v; else wethOut += (-v);
  }
  let ethIn = 0n, ethOut = 0n;
  for (const v of (function*(){ for (const x of new Map(ethDeltaByHash).values()) yield x; })()) {
    if (v > 0n) ethIn += v; else ethOut += (-v);
  }

  const wethInFloat  = Number(wethIn)  / 1e18;
  const wethOutFloat = Number(wethOut) / 1e18;
  const ethInFloat   = Number(ethIn)   / 1e18;
  const ethOutFloat  = Number(ethOut)  / 1e18;

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = wethOutFloat + ethOutFloat;
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Classification: open vs closed (closed if <= 5 tokens)
  const isClosed = (t) => (Number(t.remainingUnitsFloat || 0) <= 5);
  const closed   = perToken.filter(isClosed);
  const open     = perToken.filter(t => !isClosed(t) && Number(t.usdValueRemaining || 0) > 0);

  // Realized-only rankings on CLOSED positions
  const profitsClosed = [...closed]
    .filter(t => Number(t.realizedWeth) > 0)
    .sort((a,b) => Number(b.realizedWeth) - Number(a.realizedWeth))
    .slice(0, 15);

  const lossesClosed = [...closed]
    .filter(t => Number(t.realizedWeth) < 0)
    .sort((a,b) => Number(a.realizedWeth) - Number(b.realizedWeth))
    .slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      // Raw flows
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
      holdingsUsd: totalHoldingsUsd,
      // Current native ETH balance
      ethBalanceFloat: Number(ethBalWei) / 1e18
    },
    tokens: perToken,
    derived: {
      open,
      profitsClosed,
      lossesClosed,
      airdrops: perToken
        .filter(t => (t.airdrops?.count || 0) > 0)
        .map(t => ({
          token: t.token,
          symbol: t.symbol,
          decimals: t.decimals,
          units: t.airdrops.units,
          estUsd: t.airdrops.estUsd
        }))
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
