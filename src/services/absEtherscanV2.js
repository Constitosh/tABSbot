// src/services/absEtherscanV2.js
// Abstract via Etherscan v2 (chainid=2741).
// Needs ETHERSCAN_V2_BASE and ETHERSCAN_API_KEY in .env

import '../configEnv.js';
import axios from 'axios';

const BASE = (process.env.ETHERSCAN_V2_BASE || 'https://api.etherscan.io/v2/api').replace(/\/+$/, '');
const KEY  = process.env.ETHERSCAN_API_KEY || '';
const CHAIN_ID = 2741; // Abstract
const PAGE_SIZE = 1000;

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildURL(params) {
  const u = new URL(BASE);
  u.searchParams.set('chainid', String(CHAIN_ID));
  if (KEY) u.searchParams.set('apikey', KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function call(params, { timeout = 15000 } = {}) {
  const url = buildURL(params);
  console.log('[ESV2]', url);
  const { data } = await axios.get(url, { timeout });
  if (!data) throw new Error('EtherscanV2: empty');
  // v2 common pattern
  if (data.status === '0' && typeof data.result === 'string') {
    throw new Error(`EtherscanV2: ${data.result}`);
  }
  return data.result ?? data;
}

/** All ERC20 transfers for a token (ascending pagination). */
export async function getAllTokenTransfers(ca, { maxPages = 50 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await call({
      module: 'account',
      action: 'tokentx',
      contractaddress: ca,
      page,
      offset: PAGE_SIZE,
      startblock: 0,
      endblock: 999999999,
      sort: 'asc',
    }).catch(async (e) => {
      if (/rate limit/i.test(String(e?.message))) {
        await sleep(300);
        return null;
      }
      throw e;
    });

    if (!res) continue;

    const arr = Array.isArray(res) ? res : (res?.result || []);
    if (!arr.length) break;

    out.push(
      ...arr.map((t) => ({
        blockNumber: Number(t.blockNumber),
        timeStamp: Number(t.timeStamp || t.blockTimestamp || 0),
        hash: t.hash,
        from: (t.from || '').toLowerCase(),
        to: (t.to || '').toLowerCase(),
        value: String(t.value || '0'),
        tokenDecimal: Number(t.tokenDecimal || 18),
        tokenSymbol: t.tokenSymbol || '',
      }))
    );

    if (arr.length < PAGE_SIZE) break;
    await sleep(150);
  }
  return out;
}

/** Total supply — return as STRING (avoid scientific notation). */
export async function getTokenTotalSupply(ca) {
  const res = await call({
    module: 'token',
    action: 'tokensupply', // <- correct action
    contractaddress: ca,
  });
  // Prefer string fields first, fall back carefully
  if (typeof res?.result === 'string') return res.result;
  if (typeof res?.TokenSupply === 'string') return res.TokenSupply;
  if (typeof res === 'string') return res;

  // If API gave us a number, stringify it without losing precision
  if (typeof res === 'number') return String(res);
  if (typeof res?.result === 'number') return String(res.result);

  // Last resort
  return '0';
}

/** Contract creator info. */
export async function getContractCreator(ca) {
  const res = await call({
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: ca,
  });
  const row = Array.isArray(res) ? res[0] : res;
  return {
    contractAddress: row?.contractAddress || ca,
    creatorAddress: (row?.contractCreator || row?.creator || '').toLowerCase() || null,
    txHash: row?.txHash || row?.transactionHash || null,
  };
}

// --- add near top of file (below existing consts), or just before buildBalanceMap ---

// Accepts number | string | null and returns a BigInt.
// Handles scientific notation like "9.9007e+26" or 9.9007e+26 safely.
function toBigIntSafe(v) {
  if (v == null) return 0n;

  // If it's already a BigInt, done.
  if (typeof v === 'bigint') return v;

  // Normalize to string without losing precision if it's a Number.
  // Using toLocaleString is risky; instead detect sci-notation and expand.
  let s = typeof v === 'number' ? v.toString() : String(v).trim();

  if (s === '' || s === 'NaN') return 0n;

  // If plain integer string, fast path
  if (/^[+-]?\d+$/.test(s)) {
    return BigInt(s);
  }

  // If decimal or scientific notation, expand to an integer string.
  // Examples: "1.23e+5", "9.0e18", "1.0", "0.0001e+22"
  const sci = s.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!sci) {
    // Fallback: try Number → BigInt of the integer part (last resort)
    const n = Number(s);
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.trunc(n));
  }

  const sign = sci[1] || '';
  const intPart = sci[2] || '0';
  const fracPart = sci[3] || '';
  const exp = sci[4] ? parseInt(sci[4], 10) : 0;

  // Build full digits (no decimal point)
  let digits = intPart + fracPart;
  // Effective decimal shift is frac length minus exponent
  const decShift = fracPart.length - exp;

  if (decShift === 0) {
    // Already integer
    return BigInt(sign + digits.replace(/^0+/, '') || '0');
  }

  if (decShift > 0) {
    // Need to remove decShift digits from the end (pad with leading zeros if needed)
    if (digits.length <= decShift) {
      // becomes less than 1; integer part zero
      return 0n;
    }
    const cut = digits.length - decShift;
    const intDigits = digits.slice(0, cut);
    return BigInt(sign + (intDigits.replace(/^0+/, '') || '0'));
  }

  // decShift < 0: need to append zeros
  const zerosToAppend = -decShift;
  digits = digits + '0'.repeat(zerosToAppend);
  return BigInt(sign + (digits.replace(/^0+/, '') || '0'));
}


// --- replace your existing buildBalanceMap with this version ---

export function buildBalanceMap(transfers) {
  const balances = new Map(); // address -> BigInt
  let decimals = 18;

  for (const t of transfers || []) {
    // Keep decimals heuristic from the feed (default 18)
    const dec = Number(t?.tokenDecimal ?? 18);
    if (Number.isFinite(dec)) decimals = dec;

    // SAFELY convert transfer value to BigInt (handles numbers and sci-notation)
    const v = toBigIntSafe(t?.value ?? '0');
    const from = String(t?.from || '').toLowerCase();
    const to = String(t?.to || '').toLowerCase();

    if (from && from !== ZERO) balances.set(from, (balances.get(from) || 0n) - v);
    if (to && to !== ZERO) balances.set(to, (balances.get(to) || 0n) + v);
  }
  return { balances, decimals };
}

/** Summarize holders/topN/burn using computed balances + total supply (string). */
export function summarizeHoldersFromBalances(balances, totalSupplyRaw, decimals) {
  const rows = [];
  for (const [addr, raw] of balances.entries()) {
    if (!addr || raw === 0n) continue;
    rows.push({ address: addr, raw });
  }
  rows.sort((a, b) => (a.raw < b.raw ? 1 : -1));

  // Prefer true totalSupply; if 0, infer as sum of positive balances
  let inferredTotal = rows.reduce((s, r) => (r.raw > 0n ? s + r.raw : s), 0n);
  let total = 0n;
  try {
    total = BigInt(String(totalSupplyRaw || '0'));
  } catch {
    total = 0n;
  }
  if (total === 0n && inferredTotal > 0n) total = inferredTotal;

  const pct = (part, tot) => (tot > 0n ? Number((part * 1000000n) / tot) / 10000 : 0);

  const burnedRaw = (balances.get(DEAD) || 0n);
  const burnedPct = pct(burnedRaw, total);

  const holdersTop20 = rows.slice(0, 20).map(r => ({
    address: r.address,
    percent: pct(r.raw, total),
  }));

  const top10Raw = rows.slice(0, 10).reduce((s, r) => s + r.raw, 0n);
  const top10CombinedPct = pct(top10Raw, total);

  const holdersCount = rows.filter(r => r.raw > 0n).length;

  return { holdersTop20, top10CombinedPct, burnedPct, holdersCount, decimals };
}

// --- replace your existing first20BuyersStatus with this version (uses the same toBigIntSafe) ---

export function first20BuyersStatus(transfers, balanceMap) {
  const firstSeen = [];
  const seen = new Set();

  for (const t of transfers || []) {
    const to = String(t?.to || '').toLowerCase();
    if (!to || to === ZERO) continue;
    if (seen.has(to)) continue;
    seen.add(to);

    // Keep original amount RAW as safe string
    const raw = toBigIntSafe(t?.value ?? '0').toString();
    const d = Number(t?.tokenDecimal ?? 18);
    firstSeen.push({ address: to, amountRaw: raw, decimals: Number.isFinite(d) ? d : 18 });
    if (firstSeen.length >= 22) break; // drop first 2 later
  }

  const list = firstSeen.slice(2, 22); // 20
  const out = [];

  const toNum = (raw, d = 18) => {
    try {
      const v = toBigIntSafe(raw);
      const D = 10n ** BigInt(d);
      const whole = v / D;
      const frac = v % D;
      const fs = frac.toString().padStart(d, '0').replace(/0+$/, '').slice(0, 6);
      return Number(whole.toString() + (fs ? '.' + fs : ''));
    } catch {
      return 0;
    }
  };

  for (const r of list) {
    const start = toNum(r.amountRaw, r.decimals);
    const currRaw = balanceMap.get(r.address) || 0n;
    const curr = toNum(currRaw.toString(), r.decimals);
    let status = 'HOLD';
    const EPS = 1e-9;
    if (curr <= EPS) status = 'SOLD ALL';
    else if (curr > start + EPS) status = 'BOUGHT MORE';
    else if (curr + EPS < start) status = 'SOLD SOME';
    out.push({ address: r.address, status });
  }
  return out;
}

  const list = firstSeen.slice(2, 22); // 20
  const out = [];

  const toNum = (raw, d = 18) => {
    try {
      const v = BigInt(String(raw));
      const D = 10n ** BigInt(d);
      const whole = v / D;
      const frac = v % D;
      const fs = frac.toString().padStart(d, '0').replace(/0+$/, '').slice(0, 6);
      return Number(whole.toString() + (fs ? '.' + fs : ''));
    } catch {
      return 0;
    }
  };

  for (const r of list) {
    const start = toNum(r.amountRaw, r.decimals);
    const currRaw = balanceMap.get(r.address) || 0n;
    const curr = toNum(currRaw.toString(), r.decimals);
    let status = 'HOLD';
    const EPS = 1e-9;
    if (curr <= EPS) status = 'SOLD ALL';
    else if (curr > start + EPS) status = 'BOUGHT MORE';
    else if (curr + EPS < start) status = 'SOLD SOME';
    out.push({ address: r.address, status });
  }
  return out;
}