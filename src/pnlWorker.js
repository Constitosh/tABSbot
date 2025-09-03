// src/pnlWorker.js
// Accurate wallet PnL for Abstract (ETH+WETH combined as ETH “base”).
// Pairing order: HASH -> (BLOCK + COUNTERPARTY) -> (BLOCK POOL).
// Handles TG-bot/forwarder proxies, Moonshot router, bonding, gifts/internal moves.
// Profits/Losses = CLOSED (>= sold all or only dust <5 tokens), Open excludes dust <5 (except ETH/WETH).

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Routers / proxies (extend as you find more)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG bot proxy you provided
]);

// ---------- Etherscan client ----------
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
async function esGET(params,{logOnce=false,tag=''}={}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  for (let a=1; a<=3; a++){
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (a === 3) throw new Error(`Etherscan v2 error: ${msg}`);
    } catch(e){ if (a === 3) throw e; }
    await new Promise(r => setTimeout(r, 400*a));
  }
}

// ---------- Quotes ----------
async function getUsdQuote(ca){
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 15000 });
    if (Array.isArray(data) && data.length) return { priceUsd: Number(data[0]?.priceUsd || 0) || 0 };
    return { priceUsd: Number(data?.priceUsd || 0) || 0 };
  } catch { return { priceUsd: 0 }; }
}
async function getWethQuote(ca){
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 15000 });
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    const abs = ps.filter(p => p?.chainId === 'abstract');
    abs.sort((a,b)=>
      (Number(b?.liquidity?.usd||0)-Number(a?.liquidity?.usd||0)) ||
      (Number(b?.volume?.h24||0)   -Number(a?.volume?.h24||0))
    );
    const best = abs[0];
    return { priceWeth: Number(best?.priceNative || 0) || 0 };
  } catch { return { priceWeth: 0 }; }
}
async function getQuotes(ca){
  const [{ priceUsd }, { priceWeth }] = await Promise.all([getUsdQuote(ca), getWethQuote(ca)]);
  return { priceUsd, priceWeth };
}

// ---------- History ----------
async function getWalletERC20Txs(wallet,{fromTs=0}={}){
  wallet = wallet.toLowerCase();
  let page=1; const PAGE=1000; const out=[];
  while(true){
    const res = await esGET({
      module:'account', action:'tokentx', address:wallet,
      page, offset:PAGE, sort:'asc', startblock:0, endblock:999999999
    },{logOnce:page===1, tag:'[PNL tokentx]'});
    if(!Array.isArray(res) || !res.length) break;
    for(const r of res){ if(Number(r.timeStamp||0) >= fromTs) out.push(r); }
    if(res.length < PAGE) break;
    if(++page > 50){ console.warn('[PNL] tokentx page cap hit'); break; }
  }
  return out;
}
async function getWalletNormalTxs(wallet,{fromTs=0}={}){
  wallet = wallet.toLowerCase();
  let page=1; const PAGE=10000; const out=[];
  while(true){
    const res = await esGET({
      module:'account', action:'txlist', address:wallet,
      page, offset:PAGE, sort:'asc', startblock:0, endblock:999999999
    },{logOnce:page===1, tag:'[PNL txlist]'});
    if(!Array.isArray(res) || !res.length) break;
    for(const r of res){ if(Number(r.timeStamp||0) >= fromTs) out.push(r); }
    if(res.length < PAGE) break;
    if(++page > 5){ console.warn('[PNL] txlist page cap hit'); break; }
  }
  return out;
}
async function getEthBalance(wallet){
  try {
    const r = await esGET({ module:'account', action:'balance', address:wallet, tag:'latest' }, { tag:'[balance]' });
    const s = typeof r === 'string' ? r : (r?.result || '0');
    return s;
  } catch { return '0'; }
}

// ---------- Math ----------
const toBig = (x)=>BigInt(String(x));
const add   = (a,b)=> (a||0n) + (b||0n);

// ---------- Core ----------
async function computePnL(wallet,{sinceTs=0}={}){
  wallet = wallet.toLowerCase();
  const [erc20, normal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet,{fromTs:sinceTs}),
    getWalletNormalTxs(wallet,{fromTs:sinceTs}),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr)/1e18;

  // 1) Build base (ETH/WETH) deltas by hash and per-block by counterparty
  const wethDeltaByHash = new Map(); // hash -> +in/-out
  const ethDeltaByHash  = new Map();

  // Per-block, split by counterparty (for pairing)
  // out: wallet -> counterparty  ; in: counterparty -> wallet
  const blkOutByCP = new Map(); // bn -> Map(counterparty -> wei)
  const blkInByCP  = new Map(); // bn -> Map(counterparty -> wei)
  const blkOutUsedByCP = new Map(); // bn -> Map(counterparty -> usedWei)
  const blkInUsedByCP  = new Map();

  function inc(map, bn, addr, wei){
    const byCp = map.get(bn) || new Map();
    byCp.set(addr, (byCp.get(addr)||0n) + wei);
    map.set(bn, byCp);
  }
  function use(map, bn, addr, wei){
    const byCp = map.get(bn) || new Map();
    byCp.set(addr, (byCp.get(addr)||0n) + wei);
    map.set(bn, byCp);
  }
  function avail(map, usedMap, bn, addr){
    const byCp = map.get(bn) || new Map();
    const used = usedMap.get(bn) || new Map();
    const a = byCp.get(addr)||0n;
    const u = used.get(addr)||0n;
    return a>u ? (a-u) : 0n;
  }

  // ETH
  for(const tx of normal){
    const hash = String(tx.hash);
    const bn   = Number(tx.blockNumber||0);
    const from = String(tx.from||'').toLowerCase();
    const to   = String(tx.to  ||'').toLowerCase();
    const val  = toBig(tx.value||'0');

    if (to === wallet && val>0n){
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), val));
      inc(blkInByCP, bn, from, val);
    } else if (from === wallet && val>0n){
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), -val));
      inc(blkOutByCP, bn, to, val);
    }
  }

  // WETH
  const tokenTxsByToken = new Map();
  for(const r of erc20){
    const hash  = String(r.hash);
    const bn    = Number(r.blockNumber||0);
    const token = String(r.contractAddress||'').toLowerCase();
    const to    = String(r.to||'').toLowerCase();
    const from  = String(r.from||'').toLowerCase();
    const v     = toBig(r.value||'0');

    if (token === WETH){
      if (to === wallet){
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), v));
        inc(blkInByCP, bn, from, v);
      } else if (from === wallet){
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), -v));
        inc(blkOutByCP, bn, to, v);
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

  // 2) Per-token processing with pairing
  for (const [token, txs] of tokenTxsByToken.entries()){
    txs.sort((a,b)=>
      (Number(a.timeStamp)-Number(b.timeStamp)) ||
      (Number(a.blockNumber)-Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0)-Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0)-Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;
    let costWei = 0n;
    let realizedWei = 0n;
    let buysUnits = 0n, sellsUnits = 0n;
    let totalBuyWei = 0n, totalSellWei = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    for(const r of txs){
      const hash = String(r.hash);
      const bn   = Number(r.blockNumber||0);
      const to   = String(r.to||'').toLowerCase();
      const from = String(r.from||'').toLowerCase();
      const amt  = toBig(r.value||'0');

      const wd = wethDeltaByHash.get(hash) || 0n;
      const ed = ethDeltaByHash.get(hash)  || 0n;
      const sameHashPaid = (ed<0n?-ed:0n) + (wd<0n?-wd:0n);
      const sameHashRecv = (ed>0n? ed:0n) + (wd>0n? wd:0n);

      // ---- BUY (token -> wallet) ----
      if (to === wallet){
        let paidWei = sameHashPaid;

        // Counterparty pairing first (use wallet->counterparty base out in same block)
        if (paidWei === 0n){
          const cp = from; // the address that sent us the tokens
          const available = avail(blkOutByCP, blkOutUsedByCP, bn, cp);
          if (available > 0n) {
            paidWei = available;
            use(blkOutUsedByCP, bn, cp, paidWei);
          }
        }

        // Block pool fallback (any remaining out in this block)
        if (paidWei === 0n){
          let poolRem = 0n;
          for (const [cp,wei] of (blkOutByCP.get(bn)||new Map()).entries()){
            const rem = avail(blkOutByCP, blkOutUsedByCP, bn, cp);
            if (rem > 0n){ poolRem += rem; use(blkOutUsedByCP, bn, cp, rem); break; }
          }
          if (poolRem > 0n) paidWei = poolRem;
        }

        // Bonding (from==token) counts as buy with zero cost
        if (from === token && paidWei === 0n){
          buysUnits += amt; qty += amt;
          continue;
        }

        if (paidWei > 0n){
          buysUnits += amt; qty += amt;
          costWei   += paidWei;
          totalBuyWei += paidWei;
          baseOutTradeWei += paidWei;
          continue;
        }

        // Otherwise treat as airdrop
        airdrops.push({ hash, amount: amt });
        qty += amt; // zero cost
        continue;
      }

      // ---- SELL (wallet -> token) ----
      if (from === wallet){
        let proceeds = sameHashRecv;

        // Counterparty pairing first (use counterparty->wallet base in in same block)
        if (proceeds === 0n){
          const cp = to; // the address we sent tokens to
          const available = avail(blkInByCP, blkInUsedByCP, bn, cp);
          if (available > 0n){
            proceeds = available;
            use(blkInUsedByCP, bn, cp, proceeds);
          }
        }

        // Block pool fallback
        if (proceeds === 0n){
          let poolRem = 0n;
          for (const [cp,wei] of (blkInByCP.get(bn)||new Map()).entries()){
            const rem = avail(blkInByCP, blkInUsedByCP, bn, cp);
            if (rem > 0n){ poolRem += rem; use(blkInUsedByCP, bn, cp, rem); break; }
          }
          if (poolRem > 0n) proceeds = poolRem;
        }

        // Gift / internal out (no proceeds)
        if (proceeds === 0n){
          if (qty > 0n){
            const avg = (costWei * 1_000_000_000_000_000_000n) / (qty || 1n);
            const used = amt > qty ? qty : amt;
            const reduce = (avg * used) / 1_000_000_000_000_000_000n;
            qty -= used;
            costWei = costWei > reduce ? (costWei - reduce) : 0n;
          }
          continue;
        }

        // Real sell
        sellsUnits += amt;
        const sellUnits = amt > qty ? qty : amt;
        const avgCost = qty > 0n ? (costWei * 1_000_000_000_000_000_000n) / qty : 0n;
        const costOfSold = (avgCost * sellUnits) / 1_000_000_000_000_000_000n;

        realizedWei += (proceeds - costOfSold);

        const newQty = qty > sellUnits ? (qty - sellUnits) : 0n;
        costWei = newQty > 0n ? (avgCost * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;

        totalSellWei += proceeds;
        baseInTradeWei += proceeds;
        continue;
      }
    }

    // Mark-to-market + USD
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const invCostBase = Number(costWei) / 1e18;
    const { priceWeth } = await getWethQuote(token);
    const mtmBase = qtyFloat * Number(priceWeth || 0);
    const unrealBase = mtmBase - invCostBase;
    const { priceUsd } = await getUsdQuote(token);
    const usdValue = qtyFloat * Number(priceUsd || 0);

    // Hide open dust (<5 tokens) except ETH/WETH
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen = qty > 0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    if (!isDustOpen){
      perToken.push({
        token,
        symbol: txs[0]?.tokenSymbol || '',
        decimals: tokenDecimals,

        buys: buysUnits.toString(),
        sells: sellsUnits.toString(),
        remaining: qty.toString(),

        totalBuyBase: Number(totalBuyWei)/1e18,
        totalSellBase: Number(totalSellWei)/1e18,

        realizedBase: Number(realizedWei)/1e18,
        unrealizedBase: unrealBase,

        usdValueRemaining: usdValue
      });
    }
  }

  // Totals (only trade flows)
  const baseIn  = Number(baseInTradeWei)/1e18;
  const baseOut = Number(baseOutTradeWei)/1e18;

  let totalRealized = 0, totalUnreal = 0, totalHoldUsd = 0;
  for (const r of perToken){
    totalRealized += Number(r.realizedBase)||0;
    totalUnreal   += Number(r.unrealizedBase)||0;
    totalHoldUsd  += Number(r.usdValueRemaining)||0;
  }
  const totalPnl = totalRealized + totalUnreal;
  const pnlPct = baseOut > 0 ? (totalPnl / baseOut) * 100 : 0;

  // Derived lists
  const isClosedOrDust = (row) => {
    const q = BigInt(row.remaining||'0');
    if (q === 0n) return true;
    const dec = Number(row.decimals || 18);
    const min = 5n * (10n ** BigInt(dec));
    const symUp = String(row.symbol||'').toUpperCase();
    const isEthLike = (symUp === 'ETH' || symUp === 'WETH');
    return (!isEthLike) && (q < min);
  };

  const closed = perToken.filter(isClosedOrDust);
  const best  = closed.filter(r => Number(r.realizedBase) > 0)
                      .sort((a,b)=> Number(b.realizedBase)-Number(a.realizedBase))
                      .slice(0,15);
  const worst = closed.filter(r => Number(r.realizedBase) < 0)
                      .sort((a,b)=> Number(a.realizedBase)-Number(b.realizedBase))
                      .slice(0,15);
  const open  = perToken.filter(r => BigInt(r.remaining||'0') > 0n);

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,
      baseIn, baseOut,
      realizedBase: totalRealized,
      unrealizedBase: totalUnreal,
      totalPnlBase: totalPnl,
      pnlPct,
      holdingsUsd: totalHoldUsd,
      airdropsUsd: 0
    },
    tokens: perToken,
    derived: { open, best, worst }
  };
}

// ---------- Public API + Worker ----------
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const pnlQueueName = 'tabs_pnl';
export const pnlQueue = new Queue(pnlQueueName, { connection: bullRedis });

export async function refreshPnl(wallet, window){
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
    console.log('[PNL] job received', wallet, window);
    const res = await refreshPnl(String(wallet||''), String(window||'30d'));
    console.log('[PNL] job OK');
    return res;
  },
  { connection: bullRedis }
);