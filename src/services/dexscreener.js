// src/services/dexscreener.js
import axios from 'axios';
import { resolveChain } from '../chains.js';

const http = axios.create({ timeout: 15000 });

// Small helper to normalize DS chainId values
const asSlug = (v) => String(v ?? '').trim().toLowerCase();

/**
 * getDexscreenerTokenStats
 * - Fetches creator via /tokens/v1/<slug>/<ca>
 * - Finds the best pair for this chain via /latest/dex/tokens/<ca>, filtered by chain slug
 *
 * @param {string} ca       token contract address (lowercased)
 * @param {string} chainKey chain key e.g. 'tabs' | 'base' | 'polygon'
 * @returns {Promise<{ summary: any }>}
 */
export async function getDexscreenerTokenStats(ca, chainKey = 'tabs') {
  const chain = resolveChain(chainKey);
  const slug  = asSlug(chain.dsSlug);

  let creator = null;

  // 1) Creator & token-level meta: /tokens/v1/<slug>/<ca>
  try {
    const { data } = await http.get(`https://api.dexscreener.com/tokens/v1/${slug}/${ca}`);
    if (data?.creator) {
      creator = String(data.creator).toLowerCase();
    } else if (Array.isArray(data) && data[0]?.creator) {
      creator = String(data[0].creator).toLowerCase();
    }
  } catch (_) {
    // non-fatal
  }

  // 2) Pairs across all chains; we filter by slug
  let best = null;
  try {
    const { data } = await http.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const pairsAll = Array.isArray(data?.pairs) ? data.pairs : [];
    const pairs = pairsAll.filter((p) => asSlug(p?.chainId) === slug);

    const scored = pairs.map((p) => ({
      pairAddress: p?.pairAddress || null,
      dexId: p?.dexId || '',
      baseToken: p?.baseToken || {},
      liquidityUsd: Number(p?.liquidity?.usd || 0),
      vol24h: Number(p?.volume?.h24 || 0),
      priceUsd: Number(p?.priceUsd || 0),
      priceNative: Number(p?.priceNative || 0),
      moonshot: p?.moonshot || null,
    }));

    scored.sort((a, b) => (b.liquidityUsd + b.vol24h) - (a.liquidityUsd + a.vol24h));
    best = scored[0] || null;
  } catch (_) {
    // non-fatal (summary will still contain creator + chain)
  }

  return {
    summary: best
      ? {
          chain: chain.key,
          chainSlug: slug,
          pairAddress: best.pairAddress,
          dexId: best.dexId,
          symbol: best.baseToken?.symbol || '',
          name: best.baseToken?.name || '',
          priceUsd: best.priceUsd,
          priceNative: best.priceNative,
          liquidityUsd: best.liquidityUsd,
          vol24h: best.vol24h,
          moonshot: best.moonshot || null,
          creator,
        }
      : { chain: chain.key, chainSlug: slug, creator },
  };
}
