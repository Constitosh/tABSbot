// src/bundles.js
import axios from 'axios';
import { getJSON, setJSON } from './cache.js';

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';

const httpES = axios.create({ baseURL: ES_BASE, timeout: 30_000 });

// gentle throttle (same as rest of app)
const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 5));
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS);
let _last = 0, _chain = Promise.resolve();
async function throttle() {
  await (_chain = _chain.then(async () => {
    const wait = Math.max(0, _last + ES_MIN_INTERVAL - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    _last = Date.now();
  }));
}
async function esGET(params) {
  await throttle();
  const { data } = await httpES.get('', { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } });
  if (data?.status === '1') return data.result;
  throw new Error(data?.result || data?.message || 'Etherscan v2 error');
}

const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

/**
 * Build a lightweight "bundles" snapshot:
 *  - find creator
 *  - scan earliest token transfers asc
 *  - take first ~100 distinct recipients that receive from creator
 *  - group buys that land in the same block (and near logIndex)
 * Cached 10 minutes in Redis: token:<ca>:bundles
 */
export async function buildBundlesSnapshot(ca) {
  ca = String(ca || '').toLowerCase();
  const key = `token:${ca}:bundles`;
  const cached = await getJSON(key);
  if (cached) return cached;

  // 1) creator (dexscreener -> contract creation fallback)
  let creator = null;
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 12_000 });
    creator = String((Array.isArray(data) ? data[0]?.creator : data?.creator) || '').toLowerCase() || null;
  } catch {}
  if (!creator) {
    try {
      const r = await esGET({ module:'contract', action:'getcontractcreation', contractaddresses: ca });
      const first = Array.isArray(r) ? r[0] : r;
      creator = String(first?.contractCreator || first?.creatorAddress || '').toLowerCase() || null;
    } catch {}
  }
  if (!creator) {
    const res = { updatedAt: Date.now(), totalBundles: 0, groups: [] };
    await setJSON(key, res, 600);
    return res;
  }

  // 2) earliest transfers asc (cap)
  const out = [];
  const PAGES = 12; // up to 2400 events
  const OFFSET = 200;
  for (let page=1; page<=PAGES; page++) {
    const batch = await esGET({ module:'account', action:'tokentx', contractaddress: ca, page, offset: OFFSET, sort:'asc' });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < OFFSET) break;
  }

  // 3) after first transfer to creator, collect first 100 distinct recipients buying from creator
  let startIdx = -1;
  for (let i=0;i<out.length;i++) {
    if (String(out[i]?.to||'').toLowerCase() === creator) { startIdx = i; break; }
  }
  if (startIdx < 0) {
    const res = { updatedAt: Date.now(), totalBundles: 0, groups: [] };
    await setJSON(key, res, 600);
    return res;
  }

  const recipients = []; // [{addr,value,blockNumber,logIndex}]
  const seen = new Set();
  for (let i=startIdx;i<out.length && recipients.length < 100;i++) {
    const ev = out[i];
    const to = String(ev?.to||'').toLowerCase();
    if (!to || DEAD.has(to)) continue;
    if (seen.has(to)) continue;
    if (String(ev?.from||'').toLowerCase() !== creator) continue; // must come from creator
    const val = toBig(ev.value||'0');
    if (val <= 0n) continue;
    recipients.push({
      addr: to,
      value: val,
      blockNumber: Number(ev.blockNumber||0),
      logIndex: Number(ev.logIndex||0)
    });
    seen.add(to);
  }

  // 4) group per block + logIndex proximity
  const byBlock = new Map();
  for (const r of recipients) {
    const keyB = r.blockNumber;
    if (!byBlock.has(keyB)) byBlock.set(keyB, []);
    byBlock.get(keyB).push(r);
  }

  const groups = [];
  for (const [, arr] of byBlock) {
    if (arr.length < 2) continue;
    arr.sort((a,b)=> a.logIndex - b.logIndex);
    let cur = [arr[0]];
    for (let i=1;i<arr.length;i++) {
      const prev = cur[cur.length-1];
      if (Math.abs(arr[i].logIndex - prev.logIndex) <= 3) {
        cur.push(arr[i]);
      } else {
        if (cur.length >= 2) groups.push(cur);
        cur = [arr[i]];
      }
    }
    if (cur.length >= 2) groups.push(cur);
  }

  // 5) stats
  const totalBought = recipients.reduce((acc, r)=> acc + r.value, 0n) || 1n;
  const groupStats = groups.map(g => {
    const members = g.map(x => x.addr);
    const sum = g.reduce((a,b)=> a + b.value, 0n);
    const share = Number((sum * 10000n) / totalBought) / 100;
    return {
      size: g.length,
      buyers: members.slice(0, 10),
      sharePct: +share.toFixed(2),
    };
  }).sort((a,b)=> b.size - a.size || b.sharePct - a.sharePct);

  const result = {
    updatedAt: Date.now(),
    totalBundles: groupStats.length,
    groups: groupStats,
  };
  await setJSON(key, result, 600);
  return result;
}

// also provide default export to avoid import shape issues
export default { buildBundlesSnapshot };