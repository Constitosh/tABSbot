// src/pnlWorker.js
import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---- Chain constants (Abstract)
const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// ---- Etherscan v2 client + throttle (reuse pattern from refresh worker)
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');
const httpES = axios.create({ baseURL: ES_BASE, timeout: 25_000 });

const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 5));
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS);
let esLastTs = 0, esChain = Promise.resolve();
async function throttleES() {
  await (esChain = esChain.then(async () => {
    const wait = Math.max(0, esLastTs + ES_MIN_INTERVAL - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    esLastTs = Date.now();
  }));
}
function esParams(params) { return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } }; }
function esURL(params){ const u=new URL(ES_BASE); Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v])=>u.searchParams.set(k,String(v))); return u.toString(); }
async function esGET(params,{logOnce=false,tag=''}={}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  const maxAttempts=3;
  for (let a=1;a<=maxAttempts;a++){
    try {
      const {data}=await httpES.get('', esParams(params));
      if (data?.status==='1') return data.result;
      const msg=data?.result||data?.message||'Unknown Etherscan error';
      if (a===maxAttempts) throw new Error(`Etherscan v2 error: ${msg}`);
    } catch(e){ if (a===maxAttempts) throw e; }
    await new Promise(r=>setTimeout(r, 400*a));
  }
}

// ---- Dexscreener helpers
async function getPairsForToken(ca){
  try{
    const {data}=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {timeout: 15_000});
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    return ps.filter(p=>p?.chainId==='abstract');
  }catch{ return []; }
}
async function getCurrentTokenQuote(ca){
  // pick highest-liquidity/volume pair's priceUsd
  const ps = await getPairsForToken(ca);
  const best = ps.sort((a,b)=> (Number(b?.liquidity?.usd||0)-Number(a?.liquidity?.usd||0)) || (Number(b?.volume?.h24||0)-Number(a?.volume?.h24||0)) )[0];
  const priceUsd = Number(best?.priceUsd||0) || 0;
  const priceWeth = Number(best?.priceNative||0) || 0; // since quote is WETH on Abstract
  const pairAddrs = ps.map(p=>String(p.pairAddress||'').toLowerCase());
  const isMoonshot = ps.some(p => String(p?.pairAddress||'').includes(':moon'));
  return { priceUsd, priceWeth, pairAddrs, isMoonshot };
}

// ---- Fetch wallet ERC20 transfers
async function getWalletERC20Txs(wallet, {fromTs=0}={}){
  // We’ll page until empty, capped to reasonable pages for MVP
  let page=1, out=[];
  const PAGE_SIZE=1000;
  while(true){
    const res = await esGET({
      module:'account', action:'tokentx', address: wallet,
      page, offset: PAGE_SIZE, sort:'asc', startblock:0, endblock: 999999999
    }, { logOnce: page===1, tag:'[pnl tokentx]' });
    if (!Array.isArray(res) || res.length===0) break;
    for(const r of res){
      const t = Number(r.timeStamp||0);
      if (t>=fromTs) out.push(r);
    }
    if (res.length < PAGE_SIZE) break;
    page++;
    if (page>20){ console.warn('[PNL] tokentx page cap hit'); break; }
  }
  return out;
}

// ---- Build PnL per token
function toBig(x){ return BigInt(String(x)); }
function add(a,b){ return (a||0n) + (b||0n); }

async function computePnL(wallet, { sinceTs=0 }){
  wallet = String(wallet).toLowerCase();

  // 1) Pull all ERC20 movements sinceTs
  const erc20 = await getWalletERC20Txs(wallet, {fromTs: sinceTs});

  // Split WETH vs non-WETH
  const wethTxByHash = new Map();
  const tokenTxsByToken = new Map(); // tokenCA -> tx array

  for (const r of erc20){
    const hash = String(r.hash);
    const token = String(r.contractAddress||'').toLowerCase();
    if (token === WETH){
      // Map per txHash the weth delta for wallet (+in, -out)
      const to = String(r.to||'').toLowerCase();
      const from = String(r.from||'').toLowerCase();
      const v = toBig(r.value||'0');
      const sign = (to===wallet) ? +1n : (from===wallet ? -1n : 0n);
      if (sign!==0n){
        const cur = wethTxByHash.get(hash) || 0n;
        wethTxByHash.set(hash, cur + sign*v);
      }
      continue;
    }
    // non-WETH token transfers involving wallet only
    const to = String(r.to||'').toLowerCase();
    const from = String(r.from||'').toLowerCase();
    if (to!==wallet && from!==wallet) continue;

    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  // 2) For each token, decide which transfers are trades vs airdrops by checking counterparty against Dexscreener pairs.
  const perToken = [];
  for (const [token, txs] of tokenTxsByToken.entries()){
    // discover token pairs once
    const { priceUsd, priceWeth, pairAddrs, isMoonshot } = await getCurrentTokenQuote(token);
    const pairSet = new Set(pairAddrs);

    // sort asc by time/logIndex
    txs.sort((a,b)=> Number(a.timeStamp)-Number(b.timeStamp) || Number(a.logIndex||0)-Number(b.logIndex||0));

    // inventory / pnl state (average cost)
    let qty = 0n;              // token units
    let costWeth = 0n;         // total WETH cost of current inventory (scaled 1e18 vs token decimals)
    let realizedWeth = 0n;     // realized pnl in WETH
    let buys = 0n, sells = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));

    // airdrops gathered here
    const airdrops = [];

    for (const r of txs){
      const hash = String(r.hash);
      const to = String(r.to||'').toLowerCase();
      const from = String(r.from||'').toLowerCase();
      const counterparty = (to===wallet) ? from : to; // the other address
      const amount = toBig(r.value||'0');

      // Is this counterparty a known pair? If not, treat inbound w/ no WETH out as airdrop.
      const isTradeCounterparty = pairSet.has(String(counterparty).toLowerCase());

      // WETH delta for this tx (wallet perspective)
      const wethDelta = wethTxByHash.get(hash) || 0n; // +in / -out

      if (isTradeCounterparty){
        // classify buy/sell by direction of token
        if (to===wallet){
          // BUY: token in, weth should be negative
          buys += amount;
          qty += amount;
          // average cost add: increase costWeth by (-wethDelta)
          if (wethDelta < 0n) costWeth += (-wethDelta);
        } else {
          // SELL: token out, weth should be positive
          sells += amount;
          // compute avg cost per token unit (if qty>0)
          const avgCost = qty>0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n; // 1e18 scaler
          // realized pnl = wethIn - cost of tokens sold
          const wethIn = (wethDelta>0n) ? wethDelta : 0n;
          const costOfSold = (avgCost * amount) / 1_000_000_000_000_000_000n;
          realizedWeth += (wethIn - costOfSold);
          // reduce inventory
          qty = qty>amount ? (qty - amount) : 0n;
          costWeth = (qty>0n) ? (avgCost * qty) / 1_000_000_000_000_000_000n : 0n;
        }
      } else {
        // Not a known pair. If inbound and wethDelta >= 0 (no outflow), call it airdrop
        if (to===wallet && wethDelta >= 0n){
          airdrops.push({ hash, amount });
          // we do NOT add to inventory by default (optional: you can treat airdrop as 0-cost buy)
          qty += amount; // If you want airdrops to count as inventory, keep this line. Remove to exclude.
          // costWeth unchanged (0-cost basis)
        }
      }
    }

    // mark-to-market unrealized on current qty using priceWeth
    // priceWeth is "token per WETH" or "WETH per token"? Dexscreener priceNative is TOKEN price in NATIVE QUOTE.
    // On Abstract quote is WETH, so priceNative = price in WETH per 1 token.
    const priceWethPerToken = priceWeth; // Number
    const priceScale = 10n ** BigInt(tokenDecimals);

    const qtyFloat = Number(qty) / Number(priceScale || 1n);
    const invCostFloat = Number(costWeth) / 1e18;
    const mtmValueWeth = qtyFloat * Number(priceWethPerToken || 0);
    const unrealizedWeth = mtmValueWeth - invCostFloat;

    // aggregate airdrops value using priceUsd if available
    let airdropUnits = 0n;
    for (const a of airdrops) airdropUnits += a.amount;
    const airdropQtyFloat = Number(airdropUnits) / Number(priceScale || 1n);
    const airdropUsd = airdropQtyFloat * Number(priceUsd || 0);

    // store row
    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,
      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),
      realizedWeth: realizedWeth.toString(),     // realized PnL
      inventoryCostWeth: costWeth.toString(),    // cost basis of remaining
      priceUsd,
      priceWeth: priceWethPerToken,
      unrealizedWeth,                            // number (float)
      airdrops: {
        count: airdrops.length,
        units: airdropUnits.toString(),
        estUsd: airdropUsd
      }
    });
  }

  // Totals
  let totalRealizedWeth = 0;
  let totalUnrealizedWeth = 0;
  let totalAirdropUsd = 0;

  for (const r of perToken){
    totalRealizedWeth += Number(r.realizedWeth) / 1e18;
    totalUnrealizedWeth += Number(r.unrealizedWeth || 0);
    totalAirdropUsd += Number(r.airdrops?.estUsd || 0);
  }

  // WETH net flows
  let wethIn = 0n, wethOut = 0n;
  for (const v of wethTxByHash.values()){
    if (v>0n) wethIn += v; else wethOut += (-v);
  }

  return {
    wallet,
    sinceTs,
    totals: {
      wethIn: wethIn.toString(),
      wethOut: wethOut.toString(),
      realizedWeth: totalRealizedWeth,     // float WETH
      unrealizedWeth: totalUnrealizedWeth, // float WETH
      airdropsUsd: totalAirdropUsd         // float USD
    },
    tokens: perToken
  };
}

// ---- Public job API
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const pnlQueueName = 'tabs_pnl';
export const pnlQueue = new Queue(pnlQueueName, { connection: bullRedis });

export async function refreshPnl(wallet, window){
  const sinceMap = {
    '24h':  60*60*24,
    '7d':   60*60*24*7,
    '30d':  60*60*24*30,
    '365d': 60*60*24*365,
    'all':  0
  };
  const sinceSec = sinceMap[window] ?? sinceMap['30d'];
  const sinceTs = sinceSec ? Math.floor(Date.now()/1000) - sinceSec : 0;

  const key = `pnl:${wallet}:${window}`;
  return withLock(`lock:${key}`, 60, async () => {
    const cached = await getJSON(key);
    if (cached) return cached;

    const data = await computePnL(wallet, { sinceTs });
    await setJSON(key, data, 120); // cache 2 min
    return data;
  });
}

// ---- Worker
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
