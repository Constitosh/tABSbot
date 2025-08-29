import axios from 'axios';

// Get market data for a token on Abstract via Dexscreener
// Strategy: search by token CA and chain slug "abstract"
export async function getDexscreenerTokenStats(tokenAddress) {
  // 1) Pools of a given token (stable + good for 24h stats)
  // Docs: https://docs.dexscreener.com/api/reference  (pairs by token / pools)
  // We'll try the "get pools of a given token address" first; fallback to search.
  const endpoints = [
    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
    `https://api.dexscreener.com/latest/dex/search?q=${tokenAddress}`
  ];

  for (const url of endpoints) {
    const { data } = await axios.get(url, { timeout: 12000 });
    const pairs = data?.pairs || [];
    // Filter Abstract chain
    const absPairs = pairs.filter(p => (p.chainId || p.chain || '').toLowerCase().includes('abstract'));
    const best = absPairs.sort((a,b) => (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0))[0];
    if (best) {
      const name = best.baseToken?.name || best.info?.baseToken?.name || '';
      const symbol = best.baseToken?.symbol || best.info?.baseToken?.symbol || '';
      const priceUsd = Number(best.priceUsd || best.price || 0);
      const volume24h = Number(best.volume?.h24 || best.volume24h || 0);
      const priceChange = {
        h1: Number(best.priceChange?.h1 ?? 0),
        h6: Number(best.priceChange?.h6 ?? 0),
        h24: Number(best.priceChange?.h24 ?? 0),
      };
      const marketCap = Number(best.fdv || best.marketCap || 0); // Dexscreener often reports FDV
      return {
        pairAddress: best.pairAddress,
        name, symbol, priceUsd, volume24h, priceChange, marketCap
      };
    }
  }
  return null;
}
