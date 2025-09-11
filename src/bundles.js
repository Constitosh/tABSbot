// src/bundles.js
import axios from 'axios';
import { getJSON, setJSON } from './cache.js';

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';

const httpES = axios.create({ baseURL: ES_BASE, timeout: 30_000 });

// gentle throttle (reuse app-wide defaults)
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

/**
 * Build a lightweight "bundles" snapshot:
 *  - detect creator + moonshot status
 *  - scan earliest token transfers asc
 *  - consider first ~100 distinct recipients who receive directly from:
 *      • creator, OR
 *      • null address (mint), OR
 *      • token contract itself (if moonshot/bonding-curve)
 *  - group buys that land in the same block and near logIndex
 * Cached 10 minutes in Redis: token:<ca>:bundles
 */
export async function buildBundlesSnapshot(ca) {
  ca = String(ca || '').toLowerCase();
  const cacheKey = `token:${ca}:bundles`;
  const cached = await getJSON(cacheKey);
  if (cached) return cached;

  // 1) Try Dexscreener token info (creator + moonshot)
  let creator = null;
  let allowTokenAsSender = false; // <— enable when bonding-curve/moonshot
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 12_000 });
    const obj = Array.isArray(data) ? data[0] : data;

    // creator may be present here
    if (obj?.creator) creator = String(obj.creator).toLowerCase();

    // detect moonshot
    const dexId = String(obj?.dexId || '').toLowerCase();
    const hasLaunchPadPair = !!obj?.launchPadPair || !!obj?.moonshot?.pairAddress;
    const progress = Number(obj?.moonshot?.progress ?? 0);

    // If it's moonshot (dexId === 'moonshot' or a launchPadPair is present), let token-address-as-sender count.
    // We also check progress in (0,100) — during bonding curve this is most relevant.
    if (dexId === 'moonshot' || hasLaunchPadPair || (progress > 0 && progress < 100)) {
      allowTokenAsSender = true;
    }
  } catch {
    // ignore
  }

  // 2) Fallback for creator via contract creation
  if (!creator) {
    try {
      const r = await esGET({ module:'contract', action:'getcontractcreation', contractaddresses: ca });
      const first = Array.isArray(r) ? r[0] : r;
      creator = String(first?.contractCreator || first?.creatorAddress || '').toLowerCase() || null;
    } catch {
      // ignore
    }
  }

  // If we have neither creator nor token-as-sender allowed, we can't infer bundles well — return empty snapshot.
  if (!creator && !allowTokenAsSender) {
    const res = { updatedAt: Date.now(), totalBundles: 0, groups: [] };
    await setJSON(cacheKey, res, 600);
    return res;
  }

  // 3) earliest transfers asc (cap)
  const out = [];
  const PAGES = 12;   // up to ~2400 events
  const OFFSET = 200;
  for (let page=1; page<=PAGES; page++) {
    const batch = await esGET({ module:'account', action:'tokentx', contractaddress: ca, page, offset: OFFSET, sort:'asc' });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < OFFSET) break;
  }

  // 4) Find first transfer TO creator (bonding start anchor) — keep behavior if creator exists
  let startIdx = -1;
  if (creator) {
    for (let i=0;i<out.length;i++) {
      if (String(out[i]?.to||'').toLowerCase() === creator) { startIdx = i; break; }
    }
  }
  // If no anchor found but moonshot mode is allowed, we still proceed from the beginning;
  // we'll filter by "from" (creator / zero / token) below.
  if (startIdx < 0) startIdx = 0;

  // 5) Collect first ~100 distinct recipients who receive tokens directly from
  //    creator  OR  ZERO (mint)  OR  token address (moonshot/bonding curve).
  const recipients = []; // [{addr,value,blockNumber,logIndex}]
  const seen = new Set();

  for (let i=startIdx; i<out.length && recipients.length < 100; i++) {
    const ev   = out[i];
    const from = String(ev?.from || '').toLowerCase();
    const to   = String(ev?.to   || '').toLowerCase();
    if (!to || DEAD.has(to)) continue;
    if (seen.has(to)) continue;

    const fromIsCreator = creator && from === creator;
    const fromIsZero    = from === ZERO;
    const fromIsToken   = allowTokenAsSender && from === ca;

    // Accept if any of the acceptable sources
    if (!(fromIsCreator || fromIsZero || fromIsToken)) continue;

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

  // 6) Group recipients by block and logIndex proximity
  const byBlock = new Map();
  for (const r of recipients) {
    const b = r.blockNumber;
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(r);
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

  // 7) Stats
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
    hints: {
      creator: creator || null,
      allowTokenAsSender,
    }
  };

  await setJSON(cacheKey, result, 600);
  return result;
}

// default export (belt & suspenders)
export default { buildBundlesSnapshot };