// src/services/absEtherscanV2.js
// Abstract holders & buyers via Etherscan v2–style API (chainid=2741).
// Reads: ETHERSCAN_V2_BASE, ETHERSCAN_API_KEY  (e.g. https://api.etherscan.io/v2/api)

import '../configEnv.js';
import axios from 'axios';

const BASE = (process.env.ETHERSCAN_V2_BASE || 'https://api.etherscan.io/v2/api').replace(/\/+$/, '');
const KEY  = process.env.ETHERSCAN_API_KEY || '';
const CHAIN_ID = 2741; // Abstract

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const PAGE_SIZE = 1000; // v2 allows large pages

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

function qs(params) {
  const u = new URL(BASE);
 u.searchParams.set('chainid', String(CHAIN_ID));
  if (KEY) u.searchParams.set('apikey', KEY);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function call(params, { timeout = 15000 } = {}) {
  const url = qs(params);
  const { data } = await axios.get(url, { timeout });
  if (!data) throw new Error('EtherscanV2: empty');
  // v2 returns { status,message,result } or plain array
  if (data.status === '0' && typeof data.result === 'string') {
    // rate-limit / notok strings
    throw new Error(`EtherscanV2: ${data.result}`);
  }
  return data.result ?? data;
}

/** Get ALL ERC20 transfers for a token (contract) – paginated ascending */
export async function getAllTokenTransfers(ca, { maxPages = 50 } = {}) {
  const out = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await call({
      module: 'account',
      action: 'tokentx',
      contractaddress: ca,
      page,
      offset: PAGE_SIZE,
      startblock: 0,
      endblock: 999999999,
      sort: 'asc'
    }).catch(e => {
      // minor backoff on rate limit
      if (/rate limit/i.test(String(e.message))) return null;
      throw e;
    });

    if (!res) { await sleep(300); continue; }
    const arr = Array.isArray(res) ? res : (res?.result || []);
    if (!arr.length) break;

    out.push(...arr.map(t => ({
      blockNumber: Number(t.blockNumber),
      timeStamp: Number(t.timeStamp || t.blockTimestamp || 0),
      hash: t.hash,
      from: (t.from || '').toLowerCase(),
      to: (t.to || '').toLowerCase(),
      value: String(t.value || '0'),
      tokenDecimal: Number(t.tokenDecimal || 18),
      tokenSymbol: t.tokenSymbol || '',
    })));

    if (arr.length < PAGE_SIZE) break;
    page++;
    await sleep(150); // be nice to API
  }
  return out;
}

/** Sum balances from transfers (in/out), return Map<address, BigIntRaw>, decimals and helpers */
export function buildBalanceMap(transfers) {
  const balances = new Map(); // addr -> BigInt raw
  let decimals = 18;

  for (const t of transfers) {
    const dec = Number(t.tokenDecimal || 18);
    decimals = dec || 18;
    const v = BigInt(t.value || '0');
    const from = (t.from || '').toLowerCase();
    const to   = (t.to || '').toLowerCase();

    if (from && from !== ZERO) balances.set(from, (balances.get(from) || 0n) - v);
    if (to   && to   !== ZERO) balances.set(to,   (balances.get(to)   || 0n) + v);
  }
  return { balances, decimals };
}

/** Numeric helper: (raw / 10^dec) */
function unitsToNum(raw, dec = 18) {
  try {
    const v = BigInt(raw);
    const d = 10n ** BigInt(dec);
    const whole = v / d;
    const frac  = v % d;
    const fs = frac.toString().padStart(dec, '0').replace(/0+$/, '').slice(0, 6);
    return Number(whole.toString() + (fs ? '.' + fs : ''));
  } catch {
    return 0;
  }
}

/** holders summary from balances + totalSupplyRaw (BigInt or string) */
export function summarizeHoldersFromBalances(balances, totalSupplyRaw, decimals) {
  const totalBI = BigInt(totalSupplyRaw || '0');
  const rows = [];

  for (const [addr, raw] of balances.entries()) {
    if (addr === ZERO) continue; // ignore mint "from zero"
    if (raw === 0n) continue;
    rows.push({ address: addr, raw });
  }

  // burned
  const burnedRaw = (balances.get(DEAD) || 0n);
  const burnedPct = totalBI > 0n ? Number((burnedRaw * 1000000n) / totalBI) / 10000 : 0;

  // top 20
  rows.sort((a,b) => (b.raw > a.raw ? 1 : -1));
  const top20 = rows.slice(0, 20).map(r => ({
    address: r.address,
    percent: totalBI > 0n ? Number((r.raw * 1000000n) / totalBI) / 10000 : 0
  }));

  // top10 combined
  const top10BI = rows.slice(0, 10).reduce((s, r) => s + r.raw, 0n);
  const top10Pct = totalBI > 0n ? Number((top10BI * 1000000n) / totalBI) / 10000 : 0;

  return {
    holdersCount: rows.length,
    burnedPct,
    top10CombinedPct: top10Pct,
    holdersTop20: top20
  };
}

/** First 20 buyers + status (HOLD / SOLD ALL / SOLD SOME / BOUGHT MORE) */
export function first20BuyersStatus(transfers, balanceMap) {
  // follow your web script heuristic: drop first two receivers (often LP/mint)
  const firstSeen = [];
  const seen = new Set();

  for (const t of transfers) {
    const to = t.to;
    if (!to || to === ZERO) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    firstSeen.push({ address: to, amountRaw: String(t.value || '0'), decimals: t.tokenDecimal || 18 });
    if (firstSeen.length >= 22) break; // we will drop first 2
  }

  const list = firstSeen.slice(2, 22); // 20
  const out = [];

  for (const r of list) {
    const start = unitsToNum(r.amountRaw, r.decimals);
    const currRaw = balanceMap.get(r.address) || 0n;
    const curr = unitsToNum(currRaw.toString(), r.decimals);
    let status = 'HOLD';
    const EPS = 1e-9;
    if (curr <= EPS) status = 'SOLD ALL';
    else if (curr > start + EPS) status = 'BOUGHT MORE';
    else if (curr + EPS < start) status = 'SOLD SOME';
    out.push({ address: r.address, status });
  }
  return out;
}
