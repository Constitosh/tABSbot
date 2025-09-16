// src/services/dexscreener.js
import axios from 'axios';
import { resolveChain } from '../chains.js';

const http = axios.create({ timeout: 15000 });

/**
 * getDexscreenerTokenStats
 * @param {string} ca - token contract address (lowercased)
 * @param {string} chainKey - e.g. 'tabs', 'base', 'polygon' ...
 * @returns {Promise<{ summary: any }>}
 */
export async function getDexscreenerTokenStats(ca, chainKey = 'tabs') {
  const chain = resolveChain(chainKey);

  // Main token metadata (creator is available on /tokens/v1/<slug>/<ca>)
  let creator = null;
  try {
    const { data } = await http.get(`https://api.dexscreener.com/tokens/v1/${chain.dsSlug}/${ca}`);
    if (data?.creator) creator = String(data.creator).toLowerCase();
    else if (Array.isArray(data) && data[0]?.creator) creator = String(data[0].creator).toLowerCase();
  } catch (_) {
    // swallow; not fatal
  }

  // Latest pairs
  const { data: latest } = await http.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
  const pairsAll = Array.isArray(latest?.pairs) ? latest.pairs : [];
  const pairs = pairsAll.filter(p => String(p?.chainId) === chain.dsSlug);

  // pick best AMM pair by (liquidity + 24h volume)
  const scored = pairs.map(p => ({
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
  const best = scored[0] || null;

  return {
    summary: best
      ? {
          chain: chain.key,
          chainSlug: chain.dsSlug,
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
      : { chain: chain.key, chainSlug: chain.dsSlug, creator },
  };
}
