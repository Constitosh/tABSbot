// src/services/dexscreener.js
// Dexscreener helpers (multi-chain) -> returns a normalized "summary" for UI/worker.

import axios from 'axios';

const DS_BASE = process.env.DS_ENDPOINT || 'https://api.dexscreener.com';

function safeNum(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

function extractSocials(info) {
  const out = {};
  const arr = info?.websites || [];
  const soc = info?.socials || [];
  const site = arr.find(w => typeof w?.url === 'string' && w.url.length);
  if (site) out.website = site.url;
  for (const s of soc) {
    const type = String(s?.type || '').toLowerCase();
    const url  = s?.url;
    if (!url) continue;
    if (type === 'twitter' || type === 'x') out.twitter = url;
    if (type === 'telegram') out.telegram = url;
  }
  return out;
}

/** choose best AMM by 24h volume then liquidity; also identify moonshot pseudo-pair (":moon") */
function choosePairs(pairs, dsChain) {
  const sameChain = (p) => String(p?.chainId || '').toLowerCase() === String(dsChain).toLowerCase();
  const chainPairs = (Array.isArray(pairs) ? pairs : []).filter(sameChain);
  const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

  const ammCandidates = chainPairs.filter(p => !isMoon(p));
  ammCandidates.sort((a, b) => {
    const vA = Number(a?.volume?.h24 || 0), vB = Number(b?.volume?.h24 || 0);
    if (vB !== vA) return vB - vA;
    const lA = Number(a?.liquidity?.usd || 0), lB = Number(b?.liquidity?.usd || 0);
    return lB - lA;
  });
  const bestAMM = ammCandidates[0] || null;
  const moon = chainPairs.find(isMoon) || null;
  return { bestAMM, moon };
}

/**
 * Fetch /latest/dex/tokens/<CA> and build a normalized "summary".
 * @param {string} ca
 * @param {string} dsChain - dexscreener chainId ('abstract' | 'base' | 'hyperevm' | …)
 */
export async function getDexscreenerTokenStats(ca, dsChain = 'abstract') {
  const url = `${DS_BASE}/latest/dex/tokens/${ca}`;
  const { data } = await axios.get(url, { timeout: 15_000 });

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const { bestAMM, moon } = choosePairs(pairs, dsChain);
  const chosen = bestAMM || moon || null;

  const base = chosen?.baseToken || {};
  const info = chosen?.info || {};

  const priceUsd    = safeNum(chosen?.priceUsd ?? moon?.priceUsd);
  const fdv         = safeNum(chosen?.fdv);
  const marketCap   = safeNum(chosen?.marketCap);
  const volume      = chosen?.volume || null;
  const priceChange = chosen?.priceChange || null;

  const socials = extractSocials(info);

  return {
    summary: {
      name: base?.name || null,
      symbol: base?.symbol || null,
      priceUsd,
      volume,
      priceChange,
      marketCap: marketCap ?? fdv ?? null,
      marketCapSource: marketCap != null ? 'market' : (fdv != null ? 'fdv' : null),

      pairAddress: bestAMM?.pairAddress ? String(bestAMM.pairAddress).toLowerCase() : null,
      launchPadPair: moon?.pairAddress || null,
      dexId: chosen?.dexId || null,
      chainId: dsChain,

      moonshot: chosen?.moonshot || moon?.moonshot || null,
      socials
    }
  };
}