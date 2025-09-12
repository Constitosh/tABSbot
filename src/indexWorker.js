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

function pickPercent(h) {
  // tolerate different field names; ALWAYS return a number in [0..100]
  const cand = h?.percent ?? h?.pct ?? h?.share ?? 0;
  const v = Number(cand);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}
function pickUSD(h) {
  // tolerate your value field variants
  const cand = h?.usd ?? h?.usdNow ?? h?.valueUsd ?? h?.usd_value ?? 0;
  const v = Number(cand);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function postFilterSnapshot(raw, excludeSet) {
  // Prefer a full holders list with addresses. Fall back if your builder used a different key.
  // Accepted shapes:
  //  - raw.holdersPerc: [{address, percent/pct, usd?/usdNow?/valueUsd?}, ...]
  //  - raw.holders:     [{address, percent/pct, ...}, ...]
  const holdersArray =
    Array.isArray(raw.holdersPerc) ? raw.holdersPerc
    : (Array.isArray(raw.holders) ? raw.holders
    : []);

  // Filter out excluded addresses (LP, launchpad pool/moonshot CA, burn)
  const filtered = holdersArray.filter(h => !excludeSet.has(String(h?.address || '').toLowerCase()));

  if (!filtered.length) {
    // Nothing to work with: keep previous summary fields if any
    return {
      ...raw,
      holdersCount: raw.holdersCount ?? 0,
      top10CombinedPct: raw.top10CombinedPct ?? 0,
      gini: raw.gini ?? 0,
      pctBuckets: [],
      valueBuckets: [],
      _note: 'postFilter: empty holders after filter or no holders list present',
    };
  }

  // ---------- Top 10 combined (filtered) ----------
  const byPctDesc = [...filtered].sort((a, b) => pickPercent(b) - pickPercent(a));
  const top10CombinedPct = byPctDesc.slice(0, 10).reduce((sum, h) => sum + pickPercent(h), 0);
  const holdersCount = filtered.length;

  // ---------- Gini over filtered holders ----------
  // Convert percent-of-supply to fractions and renormalize to sum=1 for the filtered set
  const fractions = filtered.map(h => Math.max(0, pickPercent(h)) / 100);
  const denom = fractions.reduce((a, b) => a + b, 0) || 1;
  const w = fractions.map(x => x / denom); // sum(w)=1

  // Discrete Lorenz area; G = 1 - 2*Area
  const s = [...w].sort((a, b) => a - b);
  let cum = 0, area = 0;
  for (let i = 0; i < s.length; i++) {
    const prev = cum;
    cum += s[i];
    area += (prev + cum) / 2; // trapezoid
  }
  const gini = Math.max(0, Math.min(1, 1 - 2 * (area / s.length)));

  // ---------- % of supply buckets ----------
  const pctBounds = raw.pctBounds || [
    { label: '<0.01%', max: 0.01 },
    { label: '<0.05%', max: 0.05 },
    { label: '<0.10%', max: 0.10 },
    { label: '<0.50%', max: 0.50 },
    { label: '<1.00%', max: 1.00 },
    { label: '≥1.00%',  max: null },
  ];
  const pctBuckets = pctBounds.map(b => ({ label: b.label, count: 0, pct: 0 }));
  for (const h of filtered) {
    const p = pickPercent(h);
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

  // ---------- Value buckets ----------
  const haveValue = filtered.some(h => pickUSD(h) > 0);
  let valueBuckets = [];
  if (haveValue) {
    const bands = raw.valueBands || [
      { label: '$0–$10',      min: 0,      max: 10    },
      { label: '$10–$50',     min: 10,     max: 50    },
      { label: '$50–$100',    min: 50,     max: 100   },
      { label: '$100–$250',   min: 100,    max: 250   },
      { label: '$250–$1,000', min: 250,    max: 1000  },
      { label: '$1,000+',     min: 1000,   max: null  },
    ];
    valueBuckets = bands.map(b => ({ label: b.label, count: 0, pct: 0 }));
    for (const h of filtered) {
      const v = pickUSD(h);
      let idx = valueBuckets.length - 1;
      for (let i = 0; i < bands.length; i++) {
        const { min, max } = bands[i];
        if (v >= min && (max == null || v < max)) { idx = i; break; }
      }
      valueBuckets[idx].count++;
    }
    for (const b of valueBuckets) {
      b.pct = Math.round((b.count / holdersCount) * 10000) / 100;
    }
  } else {
    // If you built buckets earlier, keep them (but they may not reflect filtering)
    valueBuckets = Array.isArray(raw.valueBuckets) ? raw.valueBuckets : [];
  }

  return {
    ...raw,
    holdersCount,
    top10CombinedPct: +top10CombinedPct.toFixed(2),
    gini: +gini.toFixed(4),
    pctBuckets,
    valueBuckets,
    _note: 'postFilter: filtered metrics computed (LP/CA/Burn excluded)',
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