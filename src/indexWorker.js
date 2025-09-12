// src/indexWorker.js
import './configEnv.js';
import { getJSON, setJSON } from './cache.js';
import { getDexscreenerTokenStats } from './services/dexscreener.js';

// Your existing snapshot function that builds holders arrays/buckets/gini/etc.
// If your current file already has a builder, keep it and import it here.
import { buildHoldersSnapshot } from './holdersIndex.js';

// Burn list (expand if you have more in your project)
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

// Return lowercased string or null
const lo = (s) => (s ? String(s).toLowerCase() : null);

// Pull likely LP / pool addresses from Dexscreener
async function getExcludedAddresses(ca) {
  try {
    const { summary } = await getDexscreenerTokenStats(ca);
    const amm = lo(summary?.pairAddress);
    const launchPadPair = lo(summary?.launchPadPair);
    const isMoonshot = !!launchPadPair || String(summary?.dexId || '').toLowerCase() === 'moonshot' || !!summary?.moonshot;

    // If moonshot bonding, the token contract itself often acts as a pool in early phase
    const excludeTokenAsPool = isMoonshot ? lo(ca) : null;

    const out = new Set([...DEAD]);
    if (amm) out.add(amm);
    if (launchPadPair) out.add(launchPadPair);
    if (excludeTokenAsPool) out.add(excludeTokenAsPool);

    return { excludeSet: out, context: { amm, launchPadPair, isMoonshot, excludeTokenAsPool } };
  } catch {
    const out = new Set([...DEAD]);
    return { excludeSet: out, context: { amm: null, launchPadPair: null, isMoonshot: false, excludeTokenAsPool: null } };
  }
}

// Recompute top10, gini and buckets **after** excluding LP/CA/Burn
function postFilterSnapshot(raw, excludeSet) {
  // We expect either:
  //  - raw.holdersPerc: array of { address, percent, usd?, balance? }
  //  - or raw.holders:   array of { address, percent, ... }
  //  - plus prebuilt buckets (pctBuckets/valueBuckets) which we’ll rebuild if possible

  const holdersArray =
    Array.isArray(raw.holdersPerc) ? raw.holdersPerc
    : (Array.isArray(raw.holders) ? raw.holders
    : []);

  // Filter out excluded addresses
  const filtered = holdersArray.filter(h => !excludeSet.has(lo(h.address)));

  // If nothing to work with, return a shallow safe copy
  if (!filtered.length) {
    return {
      ...raw,
      holdersCount: raw.holdersCount ?? 0,
      top10CombinedPct: raw.top10CombinedPct ?? 0,
      gini: raw.gini ?? 0,
      pctBuckets: raw.pctBuckets ?? [],
      valueBuckets: raw.valueBuckets ?? [],
      _note: 'postFilter: no holders after filter',
    };
  }

  // --- Top 10 combined (filtered) ---
  const byPctDesc = [...filtered].sort((a, b) => Number(b.percent || 0) - Number(a.percent || 0));
  const top10 = byPctDesc.slice(0, 10).reduce((acc, h) => acc + Number(h.percent || 0), 0);
  const holdersCount = filtered.length;

  // --- Gini (filtered, percent as share of total supply in [0..100]) ---
  // Convert percent to fraction of supply (0..1) and renormalize to sum of “non-excluded supply” for distribution-based gini.
  // If you prefer supply-based gini (not renormalized), comment the renorm section.
  const supplyFractions = filtered.map(h => Math.max(0, Number(h.percent || 0)) / 100);
  const totalShare = supplyFractions.reduce((a, b) => a + b, 0) || 1;
  // Renormalize to 1 over the filtered set (so bars map nicely to 100% of “considered” holders)
  const w = supplyFractions.map(x => x / totalShare);

  // Gini over weights w where sum(w)=1:
  // G = 1 - 2 * sum_{i} (cum_i) / n   if equal-weighted holders
  // We’ll use the discrete sorted formulation for probabilities:
  const sortedW = [...w].sort((a, b) => a - b);
  let cum = 0;
  let lorentzArea = 0;
  for (let i = 0; i < sortedW.length; i++) {
    cum += sortedW[i];
    // trapezoid area increment; since sum(w)=1, the x step is 1/n
    const prevCum = cum - sortedW[i];
    lorentzArea += (prevCum + cum) / 2;
  }
  const n = sortedW.length;
  // normalize area by n (since the x-axis step sum equals n)
  const normalizedArea = lorentzArea / n;
  // Gini = 1 - 2*Area under Lorenz curve
  const gini = Math.max(0, Math.min(1, 1 - 2 * normalizedArea));

  // --- Buckets by % of supply (filtered, normalized to 100% of filtered holders) ---
  // Use your existing boundaries if present; else use fixed set
  const pctBounds = raw.pctBounds || [
    { label: '<0.01%', max: 0.01 },
    { label: '<0.05%', max: 0.05 },
    { label: '<0.10%', max: 0.10 },
    { label: '<0.50%', max: 0.50 },
    { label: '<1.00%', max: 1.00 },
    { label: '≥1.00%', max: null },
  ];

  const pctBuckets = pctBounds.map(b => ({ label: b.label, count: 0 }));
  for (const h of filtered) {
    const p = Number(h.percent || 0);
    let idx = pctBuckets.length - 1; // default last (≥)
    for (let i = 0; i < pctBounds.length; i++) {
      const mx = pctBounds[i].max;
      if (mx != null && p < mx) { idx = i; break; }
    }
    pctBuckets[idx].count++;
  }
  for (const b of pctBuckets) {
    b.pct = Math.round((b.count / holdersCount) * 10000) / 100; // percent of filtered holders
  }

  // --- Buckets by estimated value ---
  // If you previously calculated per-holder USD value (e.g., h.usd), we’ll use it.
  // If not present, we fall back to prebuilt raw.valueBuckets (no change).
  let valueBuckets = Array.isArray(raw.valueBuckets) ? raw.valueBuckets : [];
  const haveUsd = filtered.some(h => Number.isFinite(Number(h.usd)));
  if (haveUsd) {
    // dynamic bands possible; else keep yours
    const bands = raw.valueBands || [
      { label: '$0–$10',    min: 0,      max: 10 },
      { label: '$10–$50',   min: 10,     max: 50 },
      { label: '$50–$100',  min: 50,     max: 100 },
      { label: '$100–$250', min: 100,    max: 250 },
      { label: '$250–$1,000', min: 250,  max: 1000 },
      { label: '$1,000+',   min: 1000,   max: null },
    ];
    valueBuckets = bands.map(b => ({ label: b.label, count: 0 }));
    for (const h of filtered) {
      const v = Number(h.usd || 0);
      let idx = valueBuckets.length - 1;
      for (let i = 0; i < bands.length; i++) {
        const { min, max } = bands[i];
        if ((v >= min) && (max == null || v < max)) { idx = i; break; }
      }
      valueBuckets[idx].count++;
    }
    for (const b of valueBuckets) {
      b.pct = Math.round((b.count / holdersCount) * 10000) / 100;
    }
  } else {
    // Keep existing buckets if you had them, but renormalize pct if counts exist
    const totalCounts = valueBuckets.reduce((a, b) => a + Number(b.count || 0), 0);
    if (totalCounts > 0) {
      for (const b of valueBuckets) {
        b.pct = Math.round((Number(b.count || 0) / totalCounts) * 10000) / 100;
      }
    }
  }

  // Return merged snapshot with filtered metrics
  return {
    ...raw,
    holdersCount,             // filtered holders count
    top10CombinedPct: +top10.toFixed(2),
    gini: +gini.toFixed(4),
    pctBuckets,
    valueBuckets,
    _note: 'postFilter: excluded LP/CA/Burn from stats',
  };
}

// ------------- Public API -------------
// Build (or reuse cached) snapshot, then apply post-filtering.
// Cache the POST-FILTERED result for 6 hours (21600s).
export async function ensureIndexSnapshot(tokenAddress) {
  const ca = lo(tokenAddress);
  if (!/^0x[a-f0-9]{40}$/.test(ca || '')) throw new Error('Bad contract address');

  const cacheKey = `index:${ca}:filtered:v1`;
  const cached = await getJSON(cacheKey);
  if (cached && cached.updatedAt && (Date.now() - cached.updatedAt < 6 * 3600 * 1000)) {
    return cached;
  }

  // Build raw snapshot with your existing code (no changes here)
  const rawKey = `index:${ca}:raw:v1`;
  let raw = await getJSON(rawKey);
  if (!raw) {
    raw = await buildHoldersSnapshot(ca); // <- your existing function
    // be generous: keep raw for 6h too
    try { await setJSON(rawKey, raw, 21600); } catch {}
  }

  const { excludeSet } = await getExcludedAddresses(ca);
  const filtered = postFilterSnapshot(raw, excludeSet);

  // carry over the tokenAddress and updatedAt
  filtered.tokenAddress = ca;
  filtered.updatedAt = Date.now();

  try { await setJSON(cacheKey, filtered, 21600); } catch {}
  return filtered;
}