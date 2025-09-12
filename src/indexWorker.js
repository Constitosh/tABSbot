// src/indexWorker.js
import './configEnv.js';
import { getJSON, setJSON, withLock } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';
import { buildHoldersSnapshot } from './holdersIndex.js';

/** ---------- helpers ---------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (arr) => arr.reduce((a,b)=>a+b, 0);

/** Choose 6 value buckets (USD) scaled to market cap / FDV */
function pickDollarBuckets(mcUsd, holdersCount) {
  const mc = Number(mcUsd || 0);
  const h  = Number(holdersCount || 0);

  // base presets (USD)
  let buckets = [10, 50, 100, 250, 500, 1000];

  if (mc > 150_000 && mc <= 600_000) buckets = [25, 100, 250, 500, 1000, 2500];
  else if (mc > 600_000 && mc <= 2_000_000) buckets = [50, 250, 500, 1000, 2500, 5000];
  else if (mc > 2_000_000 && mc <= 10_000_000) buckets = [100, 500, 1000, 2500, 5000, 10000];
  else if (mc > 10_000_000) buckets = [250, 1000, 2500, 5000, 10000, 25000];

  // if there are very few holders, bias lower
  if (h && h < 200) buckets = buckets.map(v => Math.max(10, Math.round(v * 0.6)));

  return buckets;
}

/** Gini coefficient on non-negative array */
function gini(values) {
  const arr = values.filter(v => v > 0).slice().sort((a,b)=>a-b);
  const n = arr.length;
  if (n === 0) return 0;
  const s = arr.reduce((a,b)=>a+b, 0);
  if (s === 0) return 0;
  let cum = 0;
  let num = 0;
  for (let i = 0; i < n; i++) {
    cum += arr[i];
    num += cum;
  }
  // Gini = 1 + (1/n) - 2 * (sum_{i} (cum_i) / (n * sum))
  return clamp(1 + 1/n - (2 * num) / (n * s), 0, 1);
}

/** Convert holders % → USD values */
function percentsToUsd(holdersAllPerc, totalSupply, priceUsd) {
  const supply = Number(totalSupply || 0);
  const px = Number(priceUsd || 0);
  if (!holdersAllPerc || !holdersAllPerc.length || !supply || !px) return [];
  return holdersAllPerc.map(p => (Number(p || 0) / 100) * supply * px);
}

/** Build distribution buckets & bands */
function buildDistributions(usdVals, bucketsUsd, percBands, holdersAllPerc) {
  const counts = bucketsUsd.map(() => 0);
  for (const v of usdVals) {
    let idx = 0;
    while (idx < bucketsUsd.length && v >= bucketsUsd[idx]) idx++;
    // idx == number of thresholds passed; we count it in that bucket (<= threshold)
    // For a simple <= bucket, clamp to last index.
    const place = clamp(idx - 1, 0, bucketsUsd.length - 1);
    if (v < bucketsUsd[0]) {
      counts[0] += 1;
    } else {
      counts[place] += 1;
    }
  }

  // >= $10 vs < $10
  let above10 = 0, below10 = 0;
  for (const v of usdVals) (v >= 10 ? above10++ : below10++);

  // percentage-of-supply bands
  const bandCounts = {
    lt001: 0, lt005: 0, lt01: 0, lt05: 0, gte1: 0
  };
  if (Array.isArray(holdersAllPerc)) {
    for (const p of holdersAllPerc) {
      const x = Number(p || 0);
      if (x >= 1) bandCounts.gte1++;
      else if (x >= 0.5) bandCounts.lt05++;
      else if (x >= 0.1) bandCounts.lt01++;
      else if (x >= 0.05) bandCounts.lt005++;
      else bandCounts.lt001++;
    }
  }

  return { counts, above10, below10, bandCounts };
}

/** ---------- MAIN: refreshIndex ---------- */
export async function refreshIndex(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Invalid contract address: ${tokenAddress}`);

  // cache key for index view (6h)
  const idxKey = `token:${ca}:index`;

  // if cached — return immediately
  const cached = await getJSON(idxKey);
  if (cached && typeof cached.updatedAt === 'number' && (Date.now() - cached.updatedAt) < 6 * 3600 * 1000) {
    return cached;
  }

  return withLock(`lock:index:${ca}`, 60, async () => {
    // try again after lock (maybe someone else filled it)
    const again = await getJSON(idxKey);
    if (again && typeof again.updatedAt === 'number' && (Date.now() - again.updatedAt) < 6 * 3600 * 1000) {
      return again;
    }

    // 1) Pull summary (from your refreshWorker cache)
    let summary = await getJSON(`token:${ca}:summary`);

    // 2) Ensure we have market + holders snapshot
    let market = summary?.market || null;
    if (!market) {
      try {
        const { summary: ds } = await getDexscreenerTokenStats(ca);
        market = ds || null;
      } catch {}
    }

    // if snapshot fields are missing, build them now
    let holdersAllPerc = summary?.holdersAllPerc || null;
    let totalSupplyRaw = summary?.totalSupply || null;
    let decimals = Number(summary?.decimals || 18);
    let holdersCount = summary?.holdersCount || null;
    let holdersTop20 = summary?.holdersTop20 || null;
    let top10CombinedPct = summary?.top10CombinedPct || null;
    let burnedPct = summary?.burnedPct || null;

    if (!holdersAllPerc || !totalSupplyRaw || !holdersCount) {
      try {
        const snap = await buildHoldersSnapshot(ca, {
          balancesHint: null,
          totalSupplyHint: totalSupplyRaw || null,
        });
        if (Array.isArray(snap?.holdersAllPerc)) holdersAllPerc = snap.holdersAllPerc;
        if (snap?.totalSupply) totalSupplyRaw = String(snap.totalSupply);
        if (Number.isFinite(snap?.decimals)) decimals = Number(snap.decimals);
        if (Number.isFinite(snap?.holdersCount)) holdersCount = Number(snap.holdersCount);
        if (!holdersTop20 && Array.isArray(snap?.holdersTop20)) holdersTop20 = snap.holdersTop20;
        if (!top10CombinedPct && Number.isFinite(snap?.top10CombinedPct)) top10CombinedPct = snap.top10CombinedPct;
        if (!burnedPct && Number.isFinite(snap?.burnedPct)) burnedPct = snap.burnedPct;
      } catch (e) {
        console.warn('[INDEX] buildHoldersSnapshot failed:', e?.message || e);
      }
    }

    // 3) Price/token info
    const priceUsd = Number(market?.priceUsd || 0);
    const fdv = Number(market?.marketCap || market?.fdv || 0);
    const name = market?.name || 'Token';
    const symbol = market?.symbol || '';

    // 4) If no holders/price — abort with minimal payload so renderer can show a helpful message
    if (!holdersAllPerc || !holdersAllPerc.length || !priceUsd) {
      const minimal = {
        tokenAddress: ca,
        updatedAt: Date.now(),
        ok: false,
        reason: !priceUsd ? 'no_price' : 'no_holders',
        market: { name, symbol, priceUsd, marketCap: fdv },
      };
      await setJSON(idxKey, minimal, 6 * 3600);
      return minimal;
    }

    // 5) Compute USD holdings per holder
    const totalSupply = Number(totalSupplyRaw || 0); // already raw units; percent is of raw supply
    const usdValues = percentsToUsd(holdersAllPerc, totalSupply, priceUsd);

    // 6) Pick buckets & build distributions
    const bucketsUsd = pickDollarBuckets(fdv, holdersCount);
    const dist = buildDistributions(usdValues, bucketsUsd, [0.01, 0.05, 0.1, 0.5, 1], holdersAllPerc);

    // 7) Gini (USD-based)
    const giniUsd = gini(usdValues);

    // 8) final payload
    const out = {
      ok: true,
      tokenAddress: ca,
      updatedAt: Date.now(),
      market: {
        name, symbol,
        priceUsd,
        marketCap: fdv
      },
      holders: {
        count: Number(holdersCount || 0),
        top10CombinedPct: Number(top10CombinedPct || 0),
        burnedPct: Number(burnedPct || 0),
        percBands: dist.bandCounts,          // { lt001, lt005, lt01, lt05, gte1 }
        holdersAllPerc: holdersAllPerc,      // raw array (optional to render sparklines)
      },
      valueBuckets: {
        thresholds: bucketsUsd,              // 6 numbers (USD)
        counts: dist.counts,                 // same length as thresholds
        above10: dist.above10,
        below10: dist.below10
      },
      gini: {
        usd: Number(giniUsd.toFixed(4))
      }
    };

    // 9) cache 6h
    await setJSON(idxKey, out, 6 * 3600);
    return out;
  });
}