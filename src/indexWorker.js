// src/indexWorker.js
import './configEnv.js';
import { getJSON, setJSON } from './cache.js';

// --- burn & helpers ---
const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x000000000000000000000000000000000000dEaD',
].map(s => s.toLowerCase()));

function num(x, dflt = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}
function cleanPct(x) {
  if (x == null) return 0;
  // accepts 12.34, "12.34", "+12.34%", " 12.34 % "
  const s = String(x).replace(/[^0-9.+-eE]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function giniFromPercents(percents) {
  // percents = each holder's % of total supply (already filtered)
  // normalize to weights summing to 1, then area under Lorenz curve
  const total = percents.reduce((a, p) => a + Math.max(0, p), 0);
  if (total <= 0) return 0;
  const w = percents.map(p => Math.max(0, p) / total).sort((a,b) => a - b);
  let cum = 0, area = 0;
  for (let i = 0; i < w.length; i++) {
    const prev = cum;
    cum += w[i];
    area += (prev + cum) / 2;
  }
  // average area per slice
  area /= w.length;
  const g = 1 - 2 * area;
  return Math.max(0, Math.min(1, g));
}

function mkPctBuckets() {
  // fixed buckets you asked for
  return [
    { label: '<0.01%', max: 0.01, count: 0 },
    { label: '<0.05%', max: 0.05, count: 0 },
    { label: '<0.10%', max: 0.10, count: 0 },
    { label: '<0.50%', max: 0.50, count: 0 },
    { label: '<1.00%', max: 1.00,  count: 0 },
    { label: '≥1.00%', max: null,  count: 0 },
  ];
}
function mkValueBands() {
  // compact value bands you liked
  return [
    { label: '$0–$10',      min: 0,      max: 10,    count: 0 },
    { label: '$10–$50',     min: 10,     max: 50,    count: 0 },
    { label: '$50–$100',    min: 50,     max: 100,   count: 0 },
    { label: '$100–$250',   min: 100,    max: 250,   count: 0 },
    { label: '$250–$1,000', min: 250,    max: 1000,  count: 0 },
    { label: '$1,000+',     min: 1000,   max: null,  count: 0 },
  ];
}

function asLower(x) {
  return String(x || '').toLowerCase();
}

// Compute the filtered snapshot given /stats summary payload
function computeFilteredIndex(summary) {
  const ca = asLower(summary?.tokenAddress);
  const lp = asLower(summary?.market?.pairAddress || '');
  const launch = asLower(summary?.market?.launchPadPair || '');

  const exclude = new Set([ca, lp, launch].filter(Boolean));
  for (const b of BURN) exclude.add(b);

  // prefer full holder list if present, else fall back to holdersTop20
  const source =
    Array.isArray(summary?.holdersAll) ? summary.holdersAll :
    Array.isArray(summary?.holdersPerc) ? summary.holdersPerc :
    Array.isArray(summary?.holdersTop20) ? summary.holdersTop20 :
    [];

  // normalize entries -> { address, percent, usd }
  const base = source
    .map(h => ({
      address: asLower(h?.address),
      percent: cleanPct(h?.percent ?? h?.pct ?? h?.share),
      usd: num(h?.usd ?? h?.usdNow ?? h?.valueUsd, 0)
    }))
    .filter(h => h.address);

  // filter out LP/CA/burn
  const filtered = base.filter(h => !exclude.has(h.address) && h.percent > 0);

  const holdersCount = filtered.length;
  if (holdersCount === 0) {
    return {
      holdersCount: 0,
      top10CombinedPct: 0,
      gini: 0,
      pctBuckets: [],
      valueBuckets: [],
      _note: 'No holders after excluding LP/CA/burn.',
    };
  }

  // Top-10 combined (by % of supply)
  const byPct = [...filtered].sort((a,b) => b.percent - a.percent);
  const top10CombinedPct = byPct.slice(0, 10).reduce((acc, h) => acc + h.percent, 0);

  // Gini from filtered percents
  const gini = giniFromPercents(filtered.map(h => h.percent));

  // % of supply buckets
  const pctBuckets = mkPctBuckets();
  for (const h of filtered) {
    let idx = pctBuckets.length - 1; // default last (≥)
    for (let i = 0; i < pctBuckets.length; i++) {
      const mx = pctBuckets[i].max;
      if (mx != null && h.percent < mx) { idx = i; break; }
    }
    pctBuckets[idx].count++;
  }
  for (const b of pctBuckets) {
    b.pct = Math.round((b.count / holdersCount) * 10000) / 100;
  }

  // Value buckets (if we have any USD)
  const haveUSD = filtered.some(h => h.usd > 0);
  const valueBuckets = haveUSD ? mkValueBands() : [];
  if (haveUSD) {
    for (const h of filtered) {
      const v = h.usd;
      let idx = valueBuckets.length - 1;
      for (let i = 0; i < valueBuckets.length; i++) {
        const { min, max } = valueBuckets[i];
        if (v >= min && (max == null || v < max)) { idx = i; break; }
      }
      valueBuckets[idx].count++;
    }
    for (const b of valueBuckets) {
      b.pct = Math.round((b.count / holdersCount) * 10000) / 100;
    }
  }

  return {
    holdersCount,
    top10CombinedPct: Math.round(top10CombinedPct * 100) / 100,
    gini: Math.round(gini * 10000) / 10000,
    pctBuckets,
    valueBuckets,
    _note: 'Snapshot excludes LP/CA pools and burn addresses.',
  };
}

// Cache 6h
const TTL_SECONDS = 6 * 60 * 60;

export async function ensureIndexSnapshot(tokenAddress) {
  const ca = asLower(tokenAddress);
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error('Bad address');

  const cacheKey = `index:${ca}:filtered:v2`;
  const cached = await getJSON(cacheKey);
  if (cached?.holdersCount != null) return cached;

  // need /stats summary (already cached by your refresh worker)
  const sumKey = `token:${ca}:summary`;
  const summary = await getJSON(sumKey);
  if (!summary) {
    // no summary yet -> tell caller to try again later
    return { holdersCount: 0, top10CombinedPct: 0, gini: 0, pctBuckets: [], valueBuckets: [], _note: 'Initializing…' };
  }

  const idx = computeFilteredIndex(summary);
  await setJSON(cacheKey, idx, TTL_SECONDS);
  return idx;
}