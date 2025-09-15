const chains = {
  abstract: {
    name: 'Abstract',
    chainId: 2741,
    explorerBase: process.env.ABSCAN_BASE || 'https://api.abscan.org/api',
    apiKeyVar: 'ABSCAN_API_KEY'
  },
  base: {
    name: 'Base',
    chainId: 8453,
    explorerBase: 'https://api.basescan.org/api',
    apiKeyVar: 'ETHERSCAN_API_KEY'
  },
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    explorerBase: 'https://api.etherscan.io/api',
    apiKeyVar: 'ETHERSCAN_API_KEY'
  },
  arbitrum: {
    name: 'Arbitrum',
    chainId: 42161,
    explorerBase: 'https://api.arbiscan.io/api',
    apiKeyVar: 'ETHERSCAN_API_KEY'
  },
  optimism: {
    name: 'Optimism',
    chainId: 10,
    explorerBase: 'https://api.optimistic.etherscan.io/api',
    apiKeyVar: 'ETHERSCAN_API_KEY'
  },
  bsc: {
    name: 'BSC',
    chainId: 56,
    explorerBase: 'https://api.bscscan.com/api',
    apiKeyVar: 'ETHERSCAN_API_KEY'
  },
  polygon: {
    name: 'Polygon',
    chainId: 137,
    explorerBase: 'https://api.polygonscan.com/api',
    apiKeyVar: 'ETHERSCAN_API_KEY'
  }
};

export default chains;
