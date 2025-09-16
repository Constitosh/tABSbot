// src/services/dexscreener.js
import axios from 'axios';
import { resolveChain } from '../chains.js';

const http = axios.create({ timeout: 15000 });

// Normalize anything to a lowercase string for reliable compares
const lc = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Select the "best" pair for a token on a specific chain:
 * - filter by chain slug (e.g., 'abstract', 'base', 'polygon', 'hyperevm', ...)
 * - prefer non-launchpad pairs (skip pairAddress containing ':moon')
 * - score = liquidity.usd + volume.h24 (descending)
 */
function pickBestPairForChain(pairs, slug) {
  const isMoon = (p) => String(p?.pairAddress || '').includes(':moon');

  const sameChain = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => lc(p?.chainId) === lc(slug));

  if (!sameChain.length) return { best: null, moon: null };

  const nonMoon = sameChain.filter((p) => !isMoon(p));
  nonMoon.sort((a, b) => {
    const va = Number(a?.liquidity?.usd || 0) + Number(a?.volume?.h24 || 0);
    const vb = Number(b?.liquidity?.usd || 0) + Number(b?.volume?.h24 || 0);
    return vb - va;
  });

  const best = nonMoon[0] || null;
  const moon = sameChain.find(isMoon) || null;
  return { best, moon };
}

/**
 * getDexscreenerTokenStats
 * - Uses /tokens/v1/<slug>/<ca> to fetch creator (and token meta if present)
 * - Uses /latest/dex/tokens/<ca> to fetch pairs across chains; filters to <slug>
 * - Returns a compact summary used by your bot renderers
 *
 * @param {string} ca       token contract address (lowercased)
 * @param {string} chainKey chain key: 'tabs' | 'base' | 'polygon' | 'hyperevm' | ...
 * @returns {Promise<{ summary: any }>}
 */
export async function getDexscreenerTokenStats(ca, chainKey = 'tabs') {
  const chain = resolveChain(chainKey);
  const slug  = lc(chain.dsSlug);

  let creator = null;
  let tokenName = '';
  let tokenSymbol = '';

  // 1) Creator & token-level meta
  try {
    const { data } = await http.get(`https://api.dexscreener.com/tokens/v1/${slug}/${ca}`);
    // DS sometimes returns an object, sometimes an array
    const row = Array.isArray(data) ? (data[0] || {}) : (data || {});
    if (row?.creator) creator = lc(row.creator);
    if (row?.name)    tokenName = String(row.name);
    if (row?.symbol)  tokenSymbol = String(row.symbol);
  } catch (_) {
    // non-fatal
  }

  // 2) All pairs (we filter to target chain)
  let best = null;
  let moon = null;

  try {
    const { data } = await http.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const picked = pickBestPairForChain(pairs, slug);
    best = picked.best;
    moon = picked.moon;
  } catch (_) {
    // non-fatal
  }

  // 3) Build a friendly summary
  const baseToken = best?.baseToken || {};
  const summary = {
    chain: chain.key,
    chainSlug: slug,

    // pair selection
    pairAddress: best?.pairAddress || null,
    dexId: best?.dexId || '',

    // token text (fallbacks to token meta if pair is missing)
    symbol: baseToken?.symbol || tokenSymbol || '',
    name:   baseToken?.name   || tokenName   || '',

    // prices & liquidity
    priceUsd: Number(best?.priceUsd || 0),
    priceNative: Number(best?.priceNative || 0),

    liquidityUsd: Number(best?.liquidity?.usd || 0),
    volume: {
      m5:  Number(best?.volume?.m5  || 0),
      h1:  Number(best?.volume?.h1  || 0),
      h6:  Number(best?.volume?.h6  || 0),
      h24: Number(best?.volume?.h24 || 0),
    },
    priceChange: {
      m5:  Number(best?.priceChange?.m5  || 0),
      h1:  Number(best?.priceChange?.h1  || 0),
      h6:  Number(best?.priceChange?.h6  || 0),
      h24: Number(best?.priceChange?.h24 || 0),
    },

    // FDV/market cap (Dexscreener may send fdv and/or marketCap)
    marketCap: Number(best?.marketCap || best?.fdv || 0),

    // launchpad bits (if any)
    moonshot: moon ? (moon.moonshot || { pairAddress: moon.pairAddress }) : (best?.moonshot || null),

    // creator
    creator,
  };

  return { summary };
}