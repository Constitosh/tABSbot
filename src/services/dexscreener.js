import chains from '../../chains.js';

async function getDexscreenerTokenStats(tokenAddress, chain) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);

  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  if (!response.ok) throw new Error('Dexscreener API error');

  const data = await response.json();
  const pairs = data.pairs || [];

  const targetChainId = config.chainId.toString();
  let bestPair = null;
  let maxLiquidity = 0;

  for (let pair of pairs) {
    if (pair.chainId === targetChainId && pair.liquidity?.usd > maxLiquidity) {
      maxLiquidity = pair.liquidity.usd;
      bestPair = pair;
    }
  }

  if (!bestPair) return null;

  const token = bestPair.baseToken;
  return {
    name: token.name,
    symbol: token.symbol,
    priceUsd: parseFloat(bestPair.priceUsd) || 0,
    volume24h: parseFloat(bestPair.volume?.h24) || 0,
    priceChange: {
      h1: parseFloat(bestPair.priceChange?.h1) || 0,
      h6: parseFloat(bestPair.priceChange?.h6) || 0,
      h24: parseFloat(bestPair.priceChange?.h24) || 0
    },
    marketCap: parseFloat(bestPair.fdv) || 0
  };
}

export { getDexscreenerTokenStats };
