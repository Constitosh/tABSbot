// src/pnlWorker.js
// Accurate wallet PnL for Abstract chain — ETH & WETH combined, robust same-block pairing.
//   • Greedy-nearest base matching (same-hash → same-counterparty → nearest in block), single-use base legs
//   • Bonding buys (from===token) at 0 cost
//   • Gifts/internal outs reduce qty & cost basis proportionally (no realized PnL)
//   • Closed-only realized lists (profits>0 / losses<0)
//   • Open positions: only ≥$1 holdings, no ETH/WETH lines, no MTM fields in rows
//   • ETH IN/OUT totals are trade-only (matched legs), random transfers excluded

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain / API ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Known routers / proxies
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot / bonding router
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG proxy you flagged
]);

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

// ---------- History pulls ----------
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
    const r = await esGET({ module:'account', action:'balance', address: wallet, tag:'latest' }, { tag:'[balance]' });
    const s = typeof r === 'string' ? r : (r?.result || '0');
    return s;
  } catch { return '0'; }
}

// ---------- Helpers ----------
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

  // Build base events (ETH+WETH) per block with usage flag; also map by hash for same-hash match.
  const baseByBlock = new Map(); // bn -> [{dir:'out'|'in', wei, txIndex, logIndex, hash, cp, used:false}]
  const baseByHash  = new Map(); // hash -> {inWei,outWei}
  function pushBase(bn, ev){
    const arr = baseByBlock.get(bn) || [];
    arr.push(ev);
    baseByBlock.set(bn, arr);
  }
  function addHash(h, dir, wei){
    const rec = baseByHash.get(h) || { inWei:0n, outWei:0n };
    if (dir==='in')  rec.inWei  = add(rec.inWei,  wei);
    else             rec.outWei = add(rec.outWei, wei);
    baseByHash.set(h, rec);
  }

  // Native ETH → base events
  for(const tx of normal){
    const bn   = Number(tx.blockNumber||0);
    const idx  = Number(tx.transactionIndex||0);
    const hash = String(tx.hash);
    const from = String(tx.from||'').toLowerCase();
    const to   = String(tx.to||'').toLowerCase();
    const val  = toBig(tx.value||'0');
    if (val === 0n) continue;

    if (to === wallet){
      pushBase(bn, { dir:'in', wei:val, txIndex:idx, logIndex:-1, hash, cp:from, used:false });
      addHash(hash,'in',val);
    } else if (from === wallet){
      pushBase(bn, { dir:'out', wei:val, txIndex:idx, logIndex:-1, hash, cp:to, used:false });
      addHash(hash,'out',val);
    }
  }

  // WETH ERC20 → base events
  const tokenTxsByToken = new Map(); // token -> txs[]
  for(const r of erc20){
    const bn   = Number(r.blockNumber||0);
    const idx  = Number(r.transactionIndex||0);
    const lg   = Number(r.logIndex||0);
    const hash = String(r.hash);
    const token= String(r.contractAddress||'').toLowerCase();
    const to   = String(r.to||'').toLowerCase();
    const from = String(r.from||'').toLowerCase();
    const val  = toBig(r.value||'0');

    if (token === WETH){
      if (val === 0n) continue;
      if (to === wallet){
        pushBase(bn, { dir:'in', wei:val, txIndex:idx, logIndex:lg, hash, cp:from, used:false });
        addHash(hash,'in',val);
      } else if (from === wallet){
        pushBase(bn, { dir:'out', wei:val, txIndex:idx, logIndex:lg, hash, cp:to, used:false });
        addHash(hash,'out',val);
      }
      continue;
    }

    // group non-WETH tokens for PnL
    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  // Nearest base picker (same block), preferring same cp & routers, then minimal (|txIndex diff|, |logIndex diff|)
  function takeNearestBase(bn, wantDir, ref){
    const pool = (baseByBlock.get(bn) || []).filter(e => !e.used && e.dir === wantDir);
    if (!pool.length) return 0n;

    // First pass: prefer same counterparty if provided
    let cand = pool
      .map(e => {
        const cpScore =
          (ref.cp && e.cp === ref.cp) ? 0 :
          ((ref.cp && (KNOWN_ROUTERS.has(ref.cp) || ref.cp === ref.token)) && (KNOWN_ROUTERS.has(e.cp) || e.cp === ref.token)) ? 1 :
          2; // worse
        const dx = Math.abs((e.txIndex||0) - (ref.txIndex||0));
        const dl = Math.abs((e.logIndex||0) - (ref.logIndex||0));
        return { e, score: [cpScore, dx, dl] };
      })
      .sort((a,b)=> (a.score[0]-b.score[0]) || (a.score[1]-b.score[1]) || (a.score[2]-b.score[2]));

    if (!cand.length) return 0n;
    const picked = cand[0].e;
    picked.used = true;
    return picked.wei;
  }

  const perToken = [];
  let baseInMatchedWei  = 0n; // proceeds from sells
  let baseOutMatchedWei = 0n; // cost for buys

  // Per-token processing
  for (const [token, txs] of tokenTxsByToken.entries()){
    txs.sort((a,b)=>
      (Number(a.blockNumber)-Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0)-Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0)-Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;         // remaining units
    let cost = 0n;        // cost basis of remaining (wei)
    let realized = 0n;    // realized PnL (wei)

    let totalBuyWei  = 0n;
    let totalSellWei = 0n;
    let boughtUnits  = 0n;
    let soldUnits    = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    for (const r of txs){
      const bn   = Number(r.blockNumber||0);
      const idx  = Number(r.transactionIndex||0);
      const lg   = Number(r.logIndex||0);
      const hash = String(r.hash);
      const to   = String(r.to||'').toLowerCase();
      const from = String(r.from||'').toLowerCase();
      const amt  = toBig(r.value||'0');

      const h = baseByHash.get(hash) || { inWei:0n, outWei:0n };

      // BUY (token -> wallet)
      if (to === wallet){
        let paidWei = h.outWei; // same-hash base out
        if (paidWei === 0n){
          paidWei = takeNearestBase(bn, 'out', { txIndex:idx, logIndex:lg, cp:from, token });
        }
        // bonding 0-cost
        if (from === token && paidWei === 0n){
          boughtUnits += amt; qty += amt; continue;
        }
        // matched cost
        if (paidWei > 0n){
          boughtUnits += amt; qty += amt;
          cost += paidWei;
          totalBuyWei += paidWei;
          baseOutMatchedWei += paidWei;
          continue;
        }
        // unpriced inbound → keep as zero-cost (airdrop-like)
        boughtUnits += amt; qty += amt;
        continue;
      }

      // SELL (wallet -> token)
      if (from === wallet){
        let proceeds = h.inWei; // same-hash base in
        if (proceeds === 0n){
          proceeds = takeNearestBase(bn, 'in', { txIndex:idx, logIndex:lg, cp:to, token });
        }
        if (proceeds === 0n){
          // gift / internal: reduce qty & cost proportionally
          if (qty > 0n){
            const avg = (cost * 1_000_000_000_000_000_000n) / (qty || 1n);
            const useAmt = amt > qty ? qty : amt;
            const reduce = (avg * useAmt) / 1_000_000_000_000_000_000n;
            qty -= useAmt;
            cost = cost > reduce ? (cost - reduce) : 0n;
          }
          continue;
        }
        // real sell
        soldUnits += amt;
        const useAmt = amt > qty ? qty : amt;
        const avg = qty > 0n ? (cost * 1_000_000_000_000_000_000n) / qty : 0n;
        const costOfSold = (avg * useAmt) / 1_000_000_000_000_000_000n;

        realized += (proceeds - costOfSold);

        const newQty = qty > useAmt ? (qty - useAmt) : 0n;
        cost = newQty > 0n ? (avg * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;

        totalSellWei += proceeds;
        baseInMatchedWei += proceeds;
        continue;
      }
    }

    // Valuation for totals/open (no MTM on row)
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const holdingsUsd = qtyFloat * Number((await getUsdQuote(token)).priceUsd || priceUsd || 0); // small refresh to avoid 0s sometimes

    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,

      boughtUnits:  boughtUnits.toString(),
      soldUnits:    soldUnits.toString(),
      remaining:    qty.toString(),

      totalBuyBase:  Number(totalBuyWei)  / 1e18,
      totalSellBase: Number(totalSellWei) / 1e18,
      realizedBase:  Number(realized)     / 1e18,

      holdingsUsd
    });
  }

  // Trade-only ETH in/out
  const baseIn  = Number(baseInMatchedWei)  / 1e18;
  const baseOut = Number(baseOutMatchedWei) / 1e18;

  // Totals + lists
  let totalRealized = 0, totalHoldUsd = 0;
  for (const r of perToken){
    totalRealized += Number(r.realizedBase)||0;
    totalHoldUsd  += Number(r.holdingsUsd)||0;
  }
  // No MTM in rows; unrealized is implied by open positions value – we keep it 0 for summary now.
  const totalUnrealized = 0;
  const totalPnl = totalRealized + totalUnrealized;
  const pnlPct = baseOut > 0 ? (totalPnl / baseOut) * 100 : 0;

  // Classifications
  function isClosed(row){
    const q = BigInt(row.remaining || '0');
    if (q === 0n) return true;
    const dec = Number(row.decimals||18);
    const minUnits = 5n * (10n ** BigInt(dec));
    return q < minUnits;
  }
  function isOpenRow(row){
    const q = BigInt(row.remaining || '0');
    if (q === 0n) return false;
    const dec = Number(row.decimals||18);
    const minUnits = 5n * (10n ** BigInt(dec));
    if (q < minUnits) return false;
    return Number(row.holdingsUsd||0) >= 1; // hide <$1
  }

  const closed = perToken.filter(isClosed);
  const best  = closed.filter(r => Number(r.realizedBase) > 0)
                      .sort((a,b)=> Number(b.realizedBase)-Number(a.realizedBase))
                      .slice(0, 15);
  const worst = closed.filter(r => Number(r.realizedBase) < 0)
                      .sort((a,b)=> Number(a.realizedBase)-Number(b.realizedBase))
                      .slice(0, 15);
  const open  = perToken.filter(isOpenRow);

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat, // native ETH balance
      baseIn, baseOut,             // trade-only ETH in/out
      realizedBase: totalRealized,
      unrealizedBase: totalUnrealized, // kept 0 to avoid MTM confusion
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