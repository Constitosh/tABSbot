// src/pnlWorker.js
// Accurate wallet PnL on Abstract with: normal ETH, internal ETH, WETH legs, router/proxy settlement,
// deduped token logs, overview top-3 lists (via renderer), and NFT airdrop detection.

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba', // Moonshot
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f', // TG proxy/forwarder
].map(s=>s.toLowerCase()));

// ---- throttled Etherscan (≤5rps) ----
const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });
const ES_RPS = Math.min(5, Math.max(1, Number(process.env.ETHERSCAN_RPS || 5)));
let last = 0, chain = Promise.resolve();
async function throttle(){ await (chain = chain.then(async () => {
  const wait = Math.max(0, last + Math.ceil(1000/ES_RPS) - Date.now());
  if (wait) await new Promise(r=>setTimeout(r, wait));
  last = Date.now();
}));}
const q = (o)=>({ params: { chainid: ES_CHAIN, apikey: ES_KEY, ...o }});
async function esGET(params){
  await throttle();
  const MAX=3;
  for (let i=1;i<=MAX;i++){
    try{
      const {data}=await httpES.get('', q(params));
      if (data?.status==='1') return data.result;
      if (i===MAX) throw new Error(data?.result||data?.message||'Etherscan error');
    }catch(e){ if (i===MAX) throw e; await new Promise(r=>setTimeout(r, 300*i)); }
  }
}

// ---- quotes ----
async function getUsdQuote(ca){
  try{
    const {data}=await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`,{timeout:12_000});
    const it = Array.isArray(data)?data[0]:data;
    return { priceUsd: Number(it?.priceUsd||0) || 0 };
  }catch{ return { priceUsd: 0 }; }
}
async function getWethQuote(ca){
  try{
    const {data}=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`,{timeout:12_000});
    const pairs=(data?.pairs||[]).filter(p=>p?.chainId==='abstract');
    pairs.sort((a,b)=>(Number(b?.liquidity?.usd||0)-Number(a?.liquidity?.usd||0))||(Number(b?.volume?.h24||0)-Number(a?.volume?.h24||0)));
    return { priceWeth: Number(pairs[0]?.priceNative||0) || 0 };
  }catch{ return { priceWeth: 0 }; }
}
async function getQuotes(ca){ const [u,w]=await Promise.all([getUsdQuote(ca),getWethQuote(ca)]); return { priceUsd:u.priceUsd, priceWeth:w.priceWeth }; }

// ---- pulls ----
async function getWalletERC20Txs(address,{fromTs=0}={}){
  const wallet=String(address).toLowerCase(); const out=[]; let page=1;
  while(true){
    const res=await esGET({module:'account',action:'tokentx',address:wallet,startblock:0,endblock:999999999,page,offset:1000,sort:'asc'});
    if(!Array.isArray(res)||res.length===0)break;
    for(const r of res) if(Number(r.timeStamp||0)>=fromTs) out.push(r);
    if(res.length<1000)break; if(++page>50)break;
  } return out;
}
async function getWalletNormalTxs(address,{fromTs=0}={}){
  const wallet=String(address).toLowerCase(); const out=[]; let page=1;
  while(true){
    const res=await esGET({module:'account',action:'txlist',address:wallet,startblock:0,endblock:999999999,page,offset:10000,sort:'asc'});
    if(!Array.isArray(res)||res.length===0)break;
    for(const r of res) if(Number(r.timeStamp||0)>=fromTs) out.push(r);
    if(res.length<10000)break; if(++page>5)break;
  } return out;
}
async function getWalletInternalTxs(address,{fromTs=0}={}){
  const wallet=String(address).toLowerCase(); const out=[]; let page=1;
  while(true){
    const res=await esGET({module:'account',action:'txlistinternal',address:wallet,startblock:0,endblock:999999999,page,offset:10000,sort:'asc'});
    if(!Array.isArray(res)||res.length===0)break;
    for(const r of res) if(Number(r.timeStamp||0)>=fromTs) out.push(r);
    if(res.length<10000)break; if(++page>5)break;
  } return out;
}
async function getWalletNFTTxs(address,{fromTs=0}={}){
  const wallet=String(address).toLowerCase(); const out=[]; let page=1;
  while(true){
    const res=await esGET({module:'account',action:'tokennfttx',address:wallet,startblock:0,endblock:999999999,page,offset:1000,sort:'asc'});
    if(!Array.isArray(res)||res.length===0)break;
    for(const r of res) if(Number(r.timeStamp||0)>=fromTs) out.push(r);
    if(res.length<1000)break; if(++page>50)break;
  } return out;
}
async function getEthBalance(addr){
  try{ const r=await esGET({module:'account',action:'balance',address:addr,tag:'latest'}); return typeof r==='string'?r:(r?.result||'0'); }
  catch{ return '0'; }
}

// ---- helpers ----
const toBig = (x)=>BigInt(String(x||'0'));
const add = (a,b)=>(a||0n)+(b||0n);

// ---- core ----
async function computePnL(wallet,{sinceTs=0}){
  wallet=wallet.toLowerCase();

  const [erc20, normal, internals, nftTxs, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet,{fromTs:sinceTs}),
    getWalletNormalTxs(wallet,{fromTs:sinceTs}),
    getWalletInternalTxs(wallet,{fromTs:sinceTs}),
    getWalletNFTTxs(wallet,{fromTs:sinceTs}),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr)/1e18;

  // ETH/WETH deltas
  const ethDeltaByHash=new Map(), wethDeltaByHash=new Map();
  const blockEthNet=new Map(), blockWethNet=new Map();

  // Normal ETH
  for(const tx of normal){
    const bn=Number(tx.blockNumber||0), hash=String(tx.hash);
    const from=String(tx.from||'').toLowerCase(), to=String(tx.to||'').toLowerCase();
    const val=toBig(tx.value||'0'); let d=0n;
    if(to===wallet && val>0n) d=val; else if(from===wallet && val>0n) d=-val;
    if(d!==0n){ ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), d)); blockEthNet.set(bn, add(blockEthNet.get(bn), d)); }
  }
  // Internal ETH
  for(const itx of internals){
    const bn=Number(itx.blockNumber||0), hash=String(itx.hash);
    const from=String(itx.from||'').toLowerCase(), to=String(itx.to||'').toLowerCase();
    const val=toBig(itx.value||'0'); let d=0n;
    if(to===wallet && val>0n) d=val; else if(from===wallet && val>0n) d=-val;
    if(d!==0n){ ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), d)); blockEthNet.set(bn, add(blockEthNet.get(bn), d)); }
  }

  // Group token txs, track WETH
  const tokenTxsByToken=new Map();
  for(const r of erc20){
    const bn=Number(r.blockNumber||0), hash=String(r.hash);
    const token=String(r.contractAddress||'').toLowerCase();
    const to=String(r.to||'').toLowerCase(), from=String(r.from||'').toLowerCase();
    const v=toBig(r.value||'0');
    if(token===WETH){
      let d=0n; if(to===wallet) d=v; else if(from===wallet) d=-v;
      if(d!==0n){ wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), d)); blockWethNet.set(bn, add(blockWethNet.get(bn), d)); }
      continue;
    }
    if(to!==wallet && from!==wallet) continue;
    if(!tokenTxsByToken.has(token)) tokenTxsByToken.set(token,[]);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken=[];
  for(const [token,txsRaw] of tokenTxsByToken.entries()){
    // sort and de-dup by hash:logIndex to ensure we never process the same ERC20 log twice
    const seen = new Set();
    const txs = txsRaw
      .sort((a,b)=>(Number(a.timeStamp)-Number(b.timeStamp))||(Number(a.blockNumber)-Number(b.blockNumber))||(Number(a.transactionIndex||0)-Number(b.transactionIndex||0))||(Number(a.logIndex||0)-Number(b.logIndex||0)))
      .filter(r => { const k=`${r.hash}:${r.logIndex}`; if(seen.has(k)) return false; seen.add(k); return true; });

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty=0n, costWeth=0n, realizedWeth=0n;
    let buysUnits=0n, sellsUnits=0n;
    let totalBuysEthWei=0n, totalSellsEthWei=0n;

    const decimals = Math.max(0, Number(txs[0]?.tokenDecimal||18));
    const scale = 10n ** BigInt(decimals);
    const airdrops=[];

    for(const r of txs){
      const hash=String(r.hash), bn=Number(r.blockNumber||0);
      const to=String(r.to||'').toLowerCase(), from=String(r.from||'').toLowerCase();
      const amt=toBig(r.value||'0');

      const ethH = ethDeltaByHash.get(hash)||0n;
      const wethH= wethDeltaByHash.get(hash)||0n;
      const paidWei = (ethH<0n?-ethH:0n)+(wethH<0n?-wethH:0n);
      const recvWei = (ethH>0n? ethH:0n)+(wethH>0n? wethH:0n);

      // BUY
      if (to===wallet && (paidWei>0n || from===token)){
        qty+=amt; buysUnits+=amt;
        costWeth+=paidWei; totalBuysEthWei+=paidWei;
        continue;
      }

      // SELL (same-hash proceeds)
      if (from===wallet && recvWei>0n){
        sellsUnits+=amt; totalSellsEthWei+=recvWei;
        const avg = qty>0n ? (costWeth*1_000_000_000_000_000_000n)/qty : 0n;
        const useAmt = amt>qty ? qty : amt;
        const costSold = (avg*useAmt)/1_000_000_000_000_000_000n;
        realizedWeth += (recvWei - costSold);
        const newQty = qty>useAmt ? (qty-useAmt) : 0n;
        costWeth = newQty>0n ? (avg*newQty)/1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // SELL (router/proxy block settle)
      if (from===wallet && recvWei===0n && (KNOWN_ROUTERS.has(String(r.to||'').toLowerCase()) || String(r.to||'').toLowerCase()===token)){
        let proceeds = add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n;
        if (proceeds<0n) proceeds = 0n;
        if (proceeds===0n && priceWeth>0){
          const amtWeiEq = scale>0n ? (amt*1_000_000_000_000_000_000n)/scale : 0n;
          proceeds = toBig(Math.floor(Number(amtWeiEq)*Number(priceWeth)));
        }
        totalSellsEthWei += proceeds;
        const avg = qty>0n ? (costWeth*1_000_000_000_000_000_000n)/qty : 0n;
        const useAmt = amt>qty ? qty : amt;
        const costSold = (avg*useAmt)/1_000_000_000_000_000_000n;
        realizedWeth += (proceeds - costSold);
        const newQty = qty>useAmt ? (qty-useAmt) : 0n;
        costWeth = newQty>0n ? (avg*newQty)/1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        sellsUnits += amt;
        continue;
      }

      // OUT no proceeds (gift/burn)
      if (from===wallet && recvWei===0n){
        if (qty>0n){
          const avg=(costWeth*1_000_000_000_000_000_000n)/(qty||1n);
          const useAmt=amt>qty?qty:amt;
          const dec=(avg*useAmt)/1_000_000_000_000_000_000n;
          qty-=useAmt; costWeth = costWeth>dec ? (costWeth-dec) : 0n;
          sellsUnits += useAmt;
        }
        continue;
      }

      // AIRDROP (token)
      if (to===wallet && paidWei===0n && from!==token){
        airdrops.push({hash,amount:amt});
        qty+=amt;
      }
    }

    // MTM / USD
    const qtyFloat = Number(qty)/Number(scale||1n);
    const invCostW = Number(costWeth)/1e18;
    const mtmW = qtyFloat * Number((await getWethQuote(token)).priceWeth || 0); // slight refresh safe
    const unrealW = mtmW - invCostW;
    const usdValue = qtyFloat * Number((await getUsdQuote(token)).priceUsd || 0);

    let adUnits=0n; for(const a of airdrops) adUnits+=a.amount;
    const adQty = Number(adUnits)/Number(scale||1n);
    const adUsd = adQty * Number((await getUsdQuote(token)).priceUsd || 0);

    // open filter: keep only ≥$1
    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals,
      buys: buysUnits.toString(),
      sells: sellsUnits.toString(),
      remaining: qty.toString(),

      realizedWeth: Number(realizedWeth)/1e18,
      unrealizedWeth: unrealW,
      inventoryCostWeth: Number(costWeth)/1e18,

      priceUsd: Number((await getUsdQuote(token)).priceUsd || 0),
      priceWeth: Number((await getWethQuote(token)).priceWeth || 0),
      usdValueRemaining: usdValue,

      totalBuysEth: Number(totalBuysEthWei)/1e18,
      totalSellsEth: Number(totalSellsEthWei)/1e18,

      isOpen: qty>0n && usdValue>=1,

      airdrops: { count: airdrops.length, units: adUnits.toString(), estUsd: adUsd }
    });
  }

  // NFT airdrops (name + qty)
  const nftAirdropsMap = new Map();
  for (const n of nftTxs){
    const hash = String(n.hash);
    const to = String(n.to||'').toLowerCase();
    const from = String(n.from||'').toLowerCase();
    // ETH/WETH out in same hash? then it's a purchase, skip
    const ethH = toBig((ethDeltaByHash.get(hash)||0n) < 0n ? -(ethDeltaByHash.get(hash)||0n) : 0n);
    const wethH = toBig((wethDeltaByHash.get(hash)||0n) < 0n ? -(wethDeltaByHash.get(hash)||0n) : 0n);
    const paid = (ethH + wethH);
    if (to === wallet && paid === 0n){
      const name = n.tokenName || 'NFT';
      const key = name;
      nftAirdropsMap.set(key, (nftAirdropsMap.get(key)||0) + 1);
    }
  }
  const nftAirdrops = [...nftAirdropsMap.entries()].map(([name,qty])=>({ name, qty }));

  // Aggregates (trade-only)
  let sumBuy=0, sumSell=0, sumReal=0, sumUnreal=0, sumHoldUsd=0, sumAirUsd=0;
  for (const t of perToken){
    sumBuy += Number(t.totalBuysEth||0);
    sumSell+= Number(t.totalSellsEth||0);
    sumReal+= Number(t.realizedWeth||0);
    sumUnreal += Number(t.unrealizedWeth||0);
    sumHoldUsd += Number(t.usdValueRemaining||0);
    sumAirUsd  += Number(t.airdrops?.estUsd||0);
  }
  const totalPnlWeth = sumReal + sumUnreal;
  const pnlPct = sumBuy>0 ? (totalPnlWeth/sumBuy)*100 : 0;

  // Derived views
  const openPositions = perToken.filter(t =>
    t.isOpen && !['ETH','WETH'].includes(String(t.symbol).toUpperCase())
  );

  // realized leaders (only tokens, not ETH/WETH)
  const realizedOnly = perToken
    .filter(t => Math.abs(Number(t.realizedWeth)||0)>1e-10 && !['ETH','WETH'].includes(String(t.symbol).toUpperCase()))
    .map(t => {
      const spent = Number(t.totalBuysEth||0);
      const pct = spent>0 ? (Number(t.realizedWeth)/spent)*100 : 0;
      return {
        symbol: t.symbol,
        realizedWeth: Number(t.realizedWeth),
        pct,
        buysEth: Number(t.totalBuysEth||0),
        sellsEth: Number(t.totalSellsEth||0),
        remaining: t.remaining,
        decimals: t.decimals
      };
    });
  const best = realizedOnly.filter(x=>x.realizedWeth>0).sort((a,b)=>b.realizedWeth-a.realizedWeth);
  const worst= realizedOnly.filter(x=>x.realizedWeth<0).sort((a,b)=>a.realizedWeth-b.realizedWeth);

  return {
    wallet,
    sinceTs,
    totals:{
      ethBalance: ethBalanceFloat,
      ethInFloat:  sumSell,
      ethOutFloat: sumBuy,
      realizedWeth: sumReal,
      unrealizedWeth: sumUnreal,
      totalPnlWeth,
      pnlPct,
      airdropsUsd: sumAirUsd,
      holdingsUsd: sumHoldUsd
    },
    tokens: perToken,
    derived: {
      open: openPositions,
      best,           // full lists (renderer does top-3 for home)
      worst,
      nftAirdrops     // {name, qty}
    }
  };
}

// ---- exports / cache / worker ----
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const pnlQueueName = 'tabs_pnl';
export const pnlQueue = new Queue(pnlQueueName, { connection: bullRedis });

export async function refreshPnl(wallet, window){
  const since = { '24h':86400, '7d':604800, '30d':2592000, '90d':7776000, 'all':0 }[window] ?? 2592000;
  const sinceTs = since ? Math.floor(Date.now()/1000)-since : 0;
  const key = `pnl:${String(wallet).toLowerCase()}:${window}`;

  return withLock(`lock:${key}`, 60, async ()=>{
    const cached = await getJSON(key);
    if (cached) return cached;
    const data = await computePnL(wallet,{ sinceTs });
    await setJSON(key, data, 120);
    return data;
  });
}

new Worker(
  pnlQueueName,
  async (job)=> {
    const { wallet, window } = job.data || {};
    return await refreshPnl(String(wallet||''), String(window||'30d'));
  },
  { connection: bullRedis }
);