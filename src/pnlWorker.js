// src/pnlWorker.js
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

// Routers/forwarders (add more if you find them)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(),
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
async function esGET(params, { logOnce=false, tag='' }={}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  for (let a=1; a<=3; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (a === 3) throw new Error(`Etherscan v2 error: ${msg}`);
    } catch (e) { if (a === 3) throw e; }
    await new Promise(r => setTimeout(r, 400*a));
  }
}

async function getUsdQuote(ca){
  try{
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 15_000 });
    if (Array.isArray(data) && data.length) return { priceUsd: Number(data[0]?.priceUsd || 0) || 0 };
    return { priceUsd: Number(data?.priceUsd || 0) || 0 };
  } catch { return { priceUsd: 0 }; }
}
async function getWethQuote(ca){
  try{
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 15_000 });
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    const abs = ps.filter(p => p?.chainId === 'abstract');
    abs.sort((a,b)=>
      (Number(b?.liquidity?.usd||0) - Number(a?.liquidity?.usd||0)) ||
      (Number(b?.volume?.h24||0)    - Number(a?.volume?.h24||0))
    );
    const best = abs[0];
    return { priceWeth: Number(best?.priceNative || 0) || 0 };
  } catch { return { priceWeth: 0 }; }
}
async function getQuotes(ca){ const [{priceUsd},{priceWeth}] = await Promise.all([getUsdQuote(ca), getWethQuote(ca)]); return { priceUsd, priceWeth }; }

async function getWalletERC20Txs(wallet,{fromTs=0}={}){
  wallet = wallet.toLowerCase();
  let page=1; const PAGE=1000; const out=[];
  while(true){
    const res = await esGET({ module:'account', action:'tokentx', address:wallet, page, offset:PAGE, sort:'asc', startblock:0, endblock:999999999 }, { logOnce:page===1, tag:'[PNL tokentx]' });
    if (!Array.isArray(res) || !res.length) break;
    for (const r of res){ const t=Number(r.timeStamp||0); if (t>=fromTs) out.push(r); }
    if (res.length < PAGE) break;
    page++; if (page>50){ console.warn('[PNL] tokentx page cap hit'); break; }
  }
  return out;
}
async function getWalletNormalTxs(wallet,{fromTs=0}={}){
  wallet = wallet.toLowerCase();
  let page=1; const PAGE=10000; const out=[];
  while(true){
    const res = await esGET({ module:'account', action:'txlist', address:wallet, page, offset:PAGE, sort:'asc', startblock:0, endblock:999999999 }, { logOnce:page===1, tag:'[PNL txlist]' });
    if (!Array.isArray(res) || !res.length) break;
    for (const r of res){ const t=Number(r.timeStamp||0); if (t>=fromTs) out.push(r); }
    if (res.length < PAGE) break;
    page++; if (page>5){ console.warn('[PNL] txlist page cap hit'); break; }
  }
  return out;
}
async function getEthBalance(wallet){
  try{
    const r = await esGET({ module:'account', action:'balance', address:wallet, tag:'latest' }, { tag:'[balance]' });
    return String(typeof r==='string' ? r : (r?.result || '0'));
  } catch { return '0'; }
}

const toBig = (x)=> BigInt(String(x));
const add   = (a,b)=> (a||0n) + (b||0n);

async function computePnL(wallet,{ sinceTs=0 }){
  wallet = wallet.toLowerCase();

  const [erc20, normal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet,{ fromTs: sinceTs }),
    getWalletNormalTxs(wallet,{ fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  const wethDeltaByHash=new Map(), ethDeltaByHash=new Map();
  const blockEthNet=new Map(), blockWethNet=new Map();
  const tokenTxsByToken=new Map();

  for (const tx of normal){
    const hash=String(tx.hash), bn=Number(tx.blockNumber||0);
    const from=String(tx.from||'').toLowerCase(), to=String(tx.to||'').toLowerCase();
    const val=toBig(tx.value||'0');
    let d=0n;
    if (to===wallet && val>0n) d=val;
    else if (from===wallet && val>0n) d=-val;
    if (d!==0n){ ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash),d)); blockEthNet.set(bn, add(blockEthNet.get(bn),d)); }
  }
  for (const r of erc20){
    const hash=String(r.hash), bn=Number(r.blockNumber||0);
    const token=String(r.contractAddress||'').toLowerCase();
    const to=String(r.to||'').toLowerCase(), from=String(r.from||'').toLowerCase();
    const v=toBig(r.value||'0');
    if (token===WETH){
      let d=0n; if (to===wallet) d=v; else if (from===wallet) d=-v;
      if (d!==0n){ wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash),d)); blockWethNet.set(bn, add(blockWethNet.get(bn),d)); }
      continue;
    }
    if (to!==wallet && from!==wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken=[];
  let totalBaseInWei=0n, totalBaseOutWei=0n;

  for (const [token, txs] of tokenTxsByToken.entries()){
    txs.sort((a,b)=>
      (Number(a.timeStamp)-Number(b.timeStamp)) ||
      (Number(a.blockNumber)-Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0)-Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0)-Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty=0n, costBase=0n, realizedBase=0n;
    let buysUnits=0n, sellsUnits=0n;
    let totalBuyBase=0n, totalSellBase=0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops=[];

    for (const r of txs){
      const hash=String(r.hash), bn=Number(r.blockNumber||0);
      const to=String(r.to||'').toLowerCase(), from=String(r.from||'').toLowerCase();
      const amt=toBig(r.value||'0');

      const dW = wethDeltaByHash.get(hash) || 0n;
      const dE = ethDeltaByHash.get(hash)  || 0n;
      const paidWei = (dE<0n?-dE:0n) + (dW<0n?-dW:0n);
      const recvWei = (dE>0n? dE:0n) + (dW>0n? dW:0n);

      // BUY
      if (to===wallet && (paidWei>0n || from===token)){
        buysUnits += amt; qty += amt;
        if (paidWei>0n){ costBase += paidWei; totalBuyBase += paidWei; totalBaseOutWei += paidWei; }
        continue;
      }

      // SELL (same-hash)
      if (from===wallet && recvWei>0n){
        sellsUnits += amt;
        const avgCost = qty>0n ? (costBase * 1_000_000_000_000_000_000n) / qty : 0n;
        const used = amt>qty ? qty : amt;
        const costSold = (avgCost * used) / 1_000_000_000_000_000_000n;
        realizedBase += (recvWei - costSold);
        const newQty = qty>used ? (qty-used) : 0n;
        costBase = newQty>0n ? (avgCost * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        totalSellBase += recvWei;
        totalBaseInWei += recvWei;
        continue;
      }

      // SELL via router/block settlement
      if (from===wallet && recvWei===0n && (KNOWN_ROUTERS.has(to) || to===token)){
        let proceeds = (add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n);
        if (proceeds<=0n && priceWeth>0){
          const amtScaled1e18 = scale>0n ? (amt * 1_000_000_000_000_000_000n) / scale : 0n;
          proceeds = toBig(Math.floor(Number(amtScaled1e18) * Number(priceWeth)));
        }
        sellsUnits += amt;
        const avgCost = qty>0n ? (costBase * 1_000_000_000_000_000_000n) / qty : 0n;
        const used = amt>qty ? qty : amt;
        const costSold = (avgCost * used) / 1_000_000_000_000_000_000n;
        realizedBase += (proceeds - costSold);
        const newQty = qty>used ? (qty-used) : 0n;
        costBase = newQty>0n ? (avgCost * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        totalSellBase += proceeds>0n ? proceeds : 0n;
        if (proceeds>0n) totalBaseInWei += proceeds;
        continue;
      }

      // GIFT OUT
      if (from===wallet && recvWei===0n){
        if (qty>0n){
          const avgCost = (costBase * 1_000_000_000_000_000_000n) / (qty || 1n);
          const used = amt>qty ? qty : amt;
          const reduce = (avgCost * used) / 1_000_000_000_000_000_000n;
          qty -= used;
          costBase = costBase>reduce ? (costBase - reduce) : 0n;
        }
        continue;
      }

      // AIRDROP
      if (to===wallet && paidWei===0n && from!==token){
        airdrops.push({ hash, amount: amt });
        qty += amt;
        continue;
      }
    }

    // MTM / USD
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const invCostF = Number(costBase)/1e18;
    const mtmBase  = qtyFloat * Number(priceWeth || 0);
    const unrealF  = mtmBase - invCostF;
    const usdValue = qtyFloat * Number(priceUsd || 0);

    // Airdrops
    let adUnits=0n; for (const a of airdrops) adUnits += a.amount;
    const adQty = Number(adUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp==='ETH') || (symUp==='WETH') || (token===WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen = qty>0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,

      buysUnits:  buysUnits.toString(),
      sellsUnits: sellsUnits.toString(),
      remaining:  qty.toString(),

      totalBuyBase:  Number(totalBuyBase)/1e18,
      totalSellBase: Number(totalSellBase)/1e18,

      realizedBase:       Number(realizedBase)/1e18,
      inventoryCostBase:  Number(costBase)/1e18,
      priceUsd: Number(priceUsd||0),
      priceWeth: Number(priceWeth||0),
      unrealizedBase: unrealF,
      usdValueRemaining: usdValue,

      airdrops: { count: airdrops.length, units: adUnits.toString(), estUsd: adUsd },

      _isOpenVisible: !isDustOpen,
      _isClosed: !isOpen || isDustOpen
    });
  }

  const baseIn  = Number(totalBaseInWei)/1e18;
  const baseOut = Number(totalBaseOutWei)/1e18;

  let totalRealized=0, totalUnreal=0, totalAD=0, totalHold=0;
  for (const r of perToken){
    totalRealized += Number(r.realizedBase)||0;
    totalUnreal   += Number(r.unrealizedBase)||0;
    totalAD       += Number(r.airdrops?.estUsd||0);
    totalHold     += Number(r.usdValueRemaining||0);
  }
  const totalPnlBase = totalRealized + totalUnreal;
  const pnlPct = baseOut>0 ? (totalPnlBase/baseOut)*100 : 0;

  const open  = perToken.filter(t => Number(t.remaining)>0 && t._isOpenVisible);
  const closed= perToken.filter(t => t._isClosed);
  const closedReal = closed.filter(t => Math.abs(Number(t.realizedBase)||0) > 0);
  const best  = [...closedReal].sort((a,b)=> (Number(b.realizedBase)||0)-(Number(a.realizedBase)||0)).slice(0,15);
  const worst = [...closedReal].sort((a,b)=> (Number(a.realizedBase)||0)-(Number(b.realizedBase)||0)).slice(0,15);

  return {
    wallet, sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,
      baseIn, baseOut,
      realizedBase: totalRealized,
      unrealizedBase: totalUnreal,
      totalPnlBase, pnlPct,
      holdingsUsd: totalHold,
      airdropsUsd: totalAD
    },
    tokens: perToken,
    derived: { open, best, worst }
  };
}

// ---------- Public API + worker ----------
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