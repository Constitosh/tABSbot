// src/services/bundles.js
import axios from 'axios';
import { getJSON, setJSON } from '../cache.js';

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });
const ZERO = '0x0000000000000000000000000000000000000000';

function esParams(params){ return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } }; }
async function esGET(params){
  const { data } = await httpES.get('', esParams(params));
  if (data?.status === '1') return data.result;
  throw new Error(data?.result || data?.message || 'Etherscan v2 error');
}
const toLower = (a)=> String(a||'').toLowerCase();
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

async function getLogsTransfer(token, fromBlock, toBlock){
  const all = [];
  let page = 1;
  while (true) {
    const r = await esGET({
      module:'logs', action:'getLogs',
      address: token, topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      fromBlock, toBlock, page, offset: 1000
    });
    if (!Array.isArray(r) || r.length === 0) break;
    all.push(...r);
    if (r.length < 1000) break;
    page++;
  }
  all.sort((a,b)=> (Number(a.blockNumber)-Number(b.blockNumber)) || (Number(a.logIndex)-Number(b.logIndex)));
  return all;
}

async function getTokentxAsc(token){
  const out = [];
  for (let page=1; page<=200; page++){
    const r = await esGET({ module:'account', action:'tokentx', contractaddress:token, page, offset:1000, sort:'asc' });
    if (!Array.isArray(r) || r.length===0) break;
    out.push(...r);
    if (r.length<1000) break;
  }
  out.sort((a,b)=> (Number(a.blockNumber)-Number(b.blockNumber)) || (Number(a.logIndex)-Number(b.logIndex)));
  return out;
}

async function getBlockByTime(ts){
  const r = await esGET({ module:'block', action:'getblocknobytime', timestamp: ts, closest:'before' });
  const n = Number(r?.blockNumber || r);
  return Number.isFinite(n) ? n : 0;
}

async function getAccountTxList(addr, startBlock, endBlock){
  const out = [];
  for (let page=1; page<=10; page++){
    const r = await esGET({ module:'account', action:'txlist', address:addr, startblock:startBlock, endblock:endBlock, sort:'desc', page, offset:100 });
    if (!Array.isArray(r) || r.length===0) break;
    out.push(...r);
    if (r.length<100) break;
  }
  return out;
}

// Build first 100 buyers from tokentx (buy sources: ZERO, token CA, LP)
function firstBuyers100FromTx(txAsc, { ca, ammPair }){
  const caL = toLower(ca);
  const lp  = ammPair ? toLower(ammPair) : null;
  const buySources = new Set([ZERO, caL]);
  if (lp) buySources.add(lp);

  const firstSeen = new Map(); // addr -> { bn, ts }
  for (const tx of txAsc){
    const from = toLower(tx.from);
    const to   = toLower(tx.to);
    if (!to || to===caL || (lp && to===lp)) continue;
    if (!buySources.has(from)) continue;
    if (!firstSeen.has(to)){
      firstSeen.set(to, { bn:Number(tx.blockNumber), ts:Number(tx.timeStamp||0) });
      if (firstSeen.size>=100) break;
    }
  }
  return [...firstSeen.entries()].map(([addr,meta])=>({ address:addr, block:meta.bn, time:meta.ts }));
}

export async function analyzeBundlesForToken(token, { ammPair, force = false } = {}){
  const ca = toLower(token);
  const cacheKey = `bundles:${ca}:first100`;
  if (!force){
    const cached = await getJSON(cacheKey);
    if (cached) return cached;
  }

  // Pull tx list (asc) and pick first 100 buyers
  const txAsc = await getTokentxAsc(ca);
  const buyers = firstBuyers100FromTx(txAsc, { ca, ammPair });

  // For each buyer, find funding EOA: last incoming native tx before their first buy (2h window)
  const clusters = new Map(); // funder -> Set(buyer)
  const buyerMeta = new Map(); // buyer -> { funder, txHash, value }

  for (const b of buyers){
    const endTs = b.time || 0;
    const startTs = endTs ? endTs - 2*60*60 : 0;
    let startBlock = 0, endBlock = 9_223_372_036;

    if (startTs && endTs){
      try { startBlock = await getBlockByTime(startTs); } catch {}
      try { endBlock   = await getBlockByTime(endTs); } catch {}
    }

    const txs = await getAccountTxList(b.address, startBlock, endBlock);
    const incoming = txs.filter(t => toLower(t.to) === b.address && Number(t.value||0) > 0);
    const lastIn = incoming[0]; // because we asked sort=desc
    if (!lastIn) continue;

    const funder = toLower(lastIn.from);
    // Optional: skip contracts/routers if you maintain a set; for now cluster all EOAs
    if (!clusters.has(funder)) clusters.set(funder, new Set());
    clusters.get(funder).add(b.address);
    buyerMeta.set(b.address, { funder, txHash:lastIn.hash, value:lastIn.value });
  }

  // Build output clusters sorted by size
  const summary = [...clusters.entries()]
    .map(([funder, set]) => ({
      funder,
      buyers: [...set],
      count: set.size
    }))
    .filter(c => c.count >= 3) // threshold for “interesting” bundle
    .sort((a,b) => b.count - a.count);

  const payload = {
    tokenAddress: ca,
    computedAt: Date.now(),
    totalFirstBuyers: buyers.length,
    clusters: summary.slice(0, 10), // top clusters
  };

  await setJSON(cacheKey, payload, 300); // 5m cache
  return payload;
}
