// src/services/dexscreener.js
// Dexscreener helpers (Abstract)
// Returns a "summary" object used by the UI + worker

import axios from 'axios';

const DS_BASE = process.env.DS_ENDPOINT || 'https://api.dexscreener.com';

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function extractSocials(info) {
  const out = {};
  const arr = info?.websites || [];
  const soc = info?.socials || [];
  // websites
  const site = arr.find(w => typeof w?.url === 'string' && w.url.length);
  if (site) out.website = site.url;
  // socials
  for (const s of soc) {
    const type = String(s?.type || '').toLowerCase();
    const url  = s?.url;
    if (!url) continue;
    if (type === 'twitter' || type === 'x') out.twitter = url;
    if (type === 'telegram') out.telegram = url;
  }
  return out;
}

/**
 * Choose best AMM pair by 24h volume, then by liquidity.
 * Also identify Moonshot pseudo-pair (":moon").
 */
function choosePairs(abstractPairs) {
  const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

  const ammCandidates = abstractPairs.filter(p => !isMoon(p));
  ammCandidates.sort((a, b) => {
    const vA = Number(a?.volume?.h24 || 0), vB = Number(b?.volume?.h24 || 0);
    if (vB !== vA) return vB - vA;
    const lA = Number(a?.liquidity?.usd || 0), lB = Number(b?.liquidity?.usd || 0);
    return lB - lA;
  });
  const bestAMM = ammCandidates[0] || null;

  const moon = abstractPairs.find(isMoon) || null;
  return { bestAMM, moon };
}

/**
 * Main exported function used by the worker/bot.
 * It fetches /latest/dex/tokens/<CA> and builds a normalized "summary".
 */
export async function getDexscreenerTokenStats(ca) {
  const url = `${DS_BASE}/latest/dex/tokens/${ca}`;
  const { data } = await axios.get(url, { timeout: 15_000 });

  // ---- IMPORTANT: use unique variable names (no duplicate "pairs") ----
  const allPairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const abstractPairs = allPairs.filter(p => p?.chainId === 'hyperevm');

  // pick AMM & Moonshot
  const { bestAMM, moon } = choosePairs(abstractPairs);
  const chosen = bestAMM || moon || null;

  const base = chosen?.baseToken || {};
  const info = chosen?.info || {};

  // price & caps
  const priceUsd = safeNum(chosen?.priceUsd ?? moon?.priceUsd);
  const fdv      = safeNum(chosen?.fdv);
  const marketCap = safeNum(chosen?.marketCap);

  // volume & change objects as-is (renderer expects numbers or null)
  const volume     = chosen?.volume || null;
  const priceChange = chosen?.priceChange || null;

  // Socials
  const socials = extractSocials(info);

  // Build summary
  const summary = {
    name: base?.name || null,
    symbol: base?.symbol || null,
    priceUsd: priceUsd,
    volume,
    priceChange,
    marketCap: marketCap ?? fdv ?? null,
    marketCapSource: marketCap != null ? 'market' : (fdv != null ? 'fdv' : null),

    // Pairs
    pairAddress: bestAMM?.pairAddress ? String(bestAMM.pairAddress).toLowerCase() : null, // real 0x… (for buyers/LP exclusion)
    launchPadPair: moon?.pairAddress || null,                                             // ":moon" pseudo-id (UI only)
    dexId: chosen?.dexId || null,
    chainId: 'abstract',

    // Pass-through moonshot object if present so renderer can read progress
    moonshot: chosen?.moonshot || moon?.moonshot || null,

    // socials for UI row
    socials
  };

  return { summary };
}
