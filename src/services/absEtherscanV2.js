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

async function call(params, { timeout = 20000 } = {}) {
  const url = buildURL(params);
  console.log('[ESV2]', url);
  const { data } = await axios.get(url, { timeout });
  if (!data) throw new Error('EtherscanV2: empty response');

  // Etherscan-style envelope
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

/** Total supply (return **string** so we never lose precision). */
export async function getTokenTotalSupply(ca) {
  // Only the TOKEN module; do not use any 'stats' fallback.
  const res = await call({
    module: 'token',
    action: 'tokensupply',
    contractaddress: ca,
  });

  // Etherscan v2 returns {result: "string"} most of the time.
  const raw = (res && typeof res === 'object') ? (res.result ?? res.TokenSupply) : res;

  // Ensure we return a plain digits string. If API ever returned a number,
  // refuse to coerce (numbers >1e15 are unsafe) — just stringify as-is.
  if (typeof raw === 'string') {
    // strip any accidental whitespace
    return raw.trim();
  }
  if (typeof raw === 'number') {
    // Last resort: avoid scientific notation commas etc.
    // We intentionally string-coerce without locales. Precision might be lost,
    // but this path should practically never happen on Etherscan (it returns strings).
    return String(Math.trunc(raw));
  }
  return '0';
}

/** Build balances from transfers (BigInt map) + decimals heuristic. */
export function buildBalanceMap(transfers) {
  const balances = new Map(); // address -> BigInt
  let decimals = 18;

  for (const t of transfers) {
    const dec = Number(t.tokenDecimal || 18);
    if (Number.isFinite(dec)) decimals = dec;
    const v = BigInt(t.value || '0');
    const from = (t.from || '').toLowerCase();
    const to = (t.to || '').toLowerCase();

    if (from && from !== ZERO) balances.set(from, (balances.get(from) || 0n) - v);
    if (to && to !== ZERO) balances.set(to, (balances.get(to) || 0n) + v);
  }
  return { balances, decimals };
}

function pctFromParts(part, total) {
  if (total <= 0n) return 0;
  // percentage with 4 decimals
  return Number((part * 1000000n) / total) / 10000;
}

/** Holders summary (expects totalSupplyRaw as **string** or BigInt-convertible). */
export function summarizeHoldersFromBalances(balances, totalSupplyRaw, decimals) {
  const rows = [];
  for (const [addr, raw] of balances.entries()) {
    if (!addr || raw === 0n) continue;
    rows.push({ address: addr, raw });
  }
  rows.sort((a,b) => (a.raw < b.raw ? 1 : -1));

  let total;
  try {
    total = BigInt(String(totalSupplyRaw || '0'));
  } catch {
    total = 0n;
  }

  // fallback: if tokensupply == 0, infer total as sum of positive balances
  if (total === 0n) {
    const inferred = rows.reduce((s, r) => (r.raw > 0n ? s + r.raw : s), 0n);
    if (inferred > 0n) total = inferred;
  }

  const burnedRaw = balances.get(DEAD) || 0n;

  const top20 = rows.slice(0, 20).map((r) => ({
    address: r.address,
    percent: pctFromParts(r.raw, total),
  }));

  const top10Raw = rows.slice(0, 10).reduce((s, r) => s + r.raw, 0n);
  const top10CombinedPct = pctFromParts(top10Raw, total);
  const burnedPct = pctFromParts(burnedRaw, total);

  // holders count = addresses with positive balance
  const holdersCount = rows.filter((r) => r.raw > 0n).length;

  return { holdersTop20: top20, top10CombinedPct, burnedPct, holdersCount, decimals };
}

/** First 20 buyers status, skipping first 2 receivers (LP/mint heuristic). */
export function first20BuyersStatus(transfers, balanceMap) {
  const firstSeen = [];
  const seen = new Set();

  for (const t of transfers) {
    const to = t.to;
    if (!to || to === ZERO) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    firstSeen.push({ address: to, amountRaw: String(t.value || '0'), decimals: t.tokenDecimal || 18 });
    if (firstSeen.length >= 22) break; // will drop first 2
  }

  const list = firstSeen.slice(2, 22); // 20
  const out = [];

  const toNum = (raw, d = 18) => {
    try {
      const v = BigInt(raw);
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