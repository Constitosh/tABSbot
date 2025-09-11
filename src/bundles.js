// src/bundles.js
import axios from 'axios';
import { getJSON, setJSON } from './cache.js';

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';

const httpES = axios.create({ baseURL: ES_BASE, timeout: 30_000 });

// Gentle throttle (reuse app-wide defaults)
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

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([
  ZERO,
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));

/** ———————————————————————————————————————————————————————————————
 * Helper: detect creator + “moonshot” allowance (token-as-sender)
 * Returns { creator, allowTokenAsSender, meta }
 * ——————————————————————————————————————————————————————————————— */
async function detectLaunchMeta(ca) {
  let creator = null;
  let allowTokenAsSender = false;
  let meta = {};

  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 12_000 });
    const obj = Array.isArray(data) ? data[0] : data;

    if (obj?.creator) creator = String(obj.creator).toLowerCase();

    const dexId = String(obj?.dexId || '').toLowerCase();
    const hasLaunchPadPair = !!obj?.launchPadPair || !!obj?.moonshot?.pairAddress;
    const progress = Number(obj?.moonshot?.progress ?? 0);

    if (dexId === 'moonshot' || hasLaunchPadPair || (progress > 0 && progress < 100)) {
      allowTokenAsSender = true;
    }
    meta = { dexId, hasLaunchPadPair, progress };
  } catch {
    // ignore
  }

  if (!creator) {
    try {
      const r = await esGET({ module:'contract', action:'getcontractcreation', contractaddresses: ca });
      const first = Array.isArray(r) ? r[0] : r;
      creator = String(first?.contractCreator || first?.creatorAddress || '').toLowerCase() || null;
    } catch { /* ignore */ }
  }

  return { creator, allowTokenAsSender, meta };
}

/** ———————————————————————————————————————————————————————————————
 * buildBundlesSnapshot(ca)
 *  • Scans earliest transfers (asc) and clusters first ~100 recipients
 *    receiving directly from creator / ZERO / token (if moonshot).
 *  • Useful to detect “bundles” of simultaneous early buys.
 * Cached 10 minutes.
 * ——————————————————————————————————————————————————————————————— */
export async function buildBundlesSnapshot(contractAddress) {
  const ca = String(contractAddress || '').toLowerCase();
  const cacheKey = `token:${ca}:bundles`;
  const cached = await getJSON(cacheKey);
  if (cached) return cached;

  const { creator, allowTokenAsSender, meta } = await detectLaunchMeta(ca);

  if (!creator && !allowTokenAsSender) {
    const res = { updatedAt: Date.now(), totalBundles: 0, groups: [], hints: { creator:null, allowTokenAsSender:false, meta } };
    await setJSON(cacheKey, res, 600);
    return res;
  }

  const out = [];
  const PAGES = 12;   // ~2400 events max
  const OFFSET = 200;
  for (let page=1; page<=PAGES; page++) {
    const batch = await esGET({ module:'account', action:'tokentx', contractaddress: ca, page, offset: OFFSET, sort:'asc' });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < OFFSET) break;
  }

  // anchor (first to creator), else start from 0 when moonshot allows token-as-sender
  let startIdx = 0;
  if (creator) {
    startIdx = -1;
    for (let i=0;i<out.length;i++) {
      if (String(out[i]?.to||'').toLowerCase() === creator) { startIdx = i; break; }
    }
    if (startIdx < 0) startIdx = 0;
  }

  const recipients = [];
  const seen = new Set();
  for (let i=startIdx; i<out.length && recipients.length < 100; i++) {
    const ev   = out[i];
    const from = String(ev?.from || '').toLowerCase();
    const to   = String(ev?.to   || '').toLowerCase();
    if (!to || DEAD.has(to)) continue;
    if (seen.has(to)) continue;

    const ok =
      (creator && from === creator) ||
      (from === ZERO) ||
      (allowTokenAsSender && from === ca);

    if (!ok) continue;

    const val = toBig(ev.value || '0');
    if (val <= 0n) continue;

    recipients.push({
      addr: to,
      value: val,
      blockNumber: Number(ev.blockNumber || 0),
      logIndex: Number(ev.logIndex || 0),
    });
    seen.add(to);
  }

  const byBlock = new Map();
  for (const r of recipients) {
    if (!byBlock.has(r.blockNumber)) byBlock.set(r.blockNumber, []);
    byBlock.get(r.blockNumber).push(r);
  }

  const groups = [];
  for (const arr of byBlock.values()) {
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
    hints: { creator, allowTokenAsSender, meta }
  };

  await setJSON(cacheKey, result, 600);
  return result;
}

/** ———————————————————————————————————————————————————————————————
 * buildFundingMap(ca)
 *  • Very lightweight “who funded early” view.
 *  • Aggregates value transferred FROM (creator | ZERO | token-if-moonshot)
 *    TO distinct addresses in the earliest ~2000 transfers.
 *  • Returns a simple ranked list by amount and a few totals.
 * Cached 10 minutes.
 * ——————————————————————————————————————————————————————————————— */
export async function buildFundingMap(contractAddress) {
  const ca = String(contractAddress || '').toLowerCase();
  const cacheKey = `token:${ca}:funding`;
  const cached = await getJSON(cacheKey);
  if (cached) return cached;

  const { creator, allowTokenAsSender, meta } = await detectLaunchMeta(ca);

  // If we can't identify any valid funding source, return an empty map
  if (!creator && !allowTokenAsSender) {
    const res = { updatedAt: Date.now(), sources: [], uniqueRecipients: 0, totalFundedRaw: '0', hints: { creator:null, allowTokenAsSender:false, meta } };
    await setJSON(cacheKey, res, 600);
    return res;
  }

  // earliest transfers (asc), smaller cap than bundles
  const out = [];
  const PAGES = 10;   // ~2000
  const OFFSET = 200;
  for (let page=1; page<=PAGES; page++) {
    const batch = await esGET({ module:'account', action:'tokentx', contractaddress: ca, page, offset: OFFSET, sort:'asc' });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < OFFSET) break;
  }

  const totalsBySource = new Map();   // from -> bigint amount
  const recipientsBySource = new Map(); // from -> Set(to)
  let totalFunded = 0n;

  for (const ev of out) {
    const from = String(ev?.from || '').toLowerCase();
    const to   = String(ev?.to   || '').toLowerCase();
    if (!to || DEAD.has(to)) continue;

    const isCreator = creator && from === creator;
    const isZero    = from === ZERO;
    const isToken   = allowTokenAsSender && from === ca;
    if (!(isCreator || isZero || isToken)) continue;

    const val = toBig(ev.value || '0');
    if (val <= 0n) continue;

    totalFunded += val;

    const k = from;
    totalsBySource.set(k, (totalsBySource.get(k) || 0n) + val);
    if (!recipientsBySource.has(k)) recipientsBySource.set(k, new Set());
    recipientsBySource.get(k).add(to);
  }

  const sources = [...totalsBySource.entries()]
    .map(([source, amt]) => ({
      source,
      amountRaw: amt.toString(),
      uniqueRecipients: recipientsBySource.get(source)?.size || 0
    }))
    .sort((a,b) => (toBig(b.amountRaw) > toBig(a.amountRaw) ? 1 : -1));

  const result = {
    updatedAt: Date.now(),
    sources,
    uniqueRecipients: [...recipientsBySource.values()].reduce((acc, s) => acc + (s?.size || 0), 0),
    totalFundedRaw: totalFunded.toString(),
    hints: { creator, allowTokenAsSender, meta }
  };

  await setJSON(cacheKey, result, 600);
  return result;
}

// default export with both builders
export default { buildBundlesSnapshot, buildFundingMap };
export { buildBundlesSnapshot as detectBundles };