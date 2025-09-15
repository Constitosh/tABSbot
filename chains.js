const chains = {
  ethereum: { name: 'Ethereum', chainId: 1 },
  base: { name: 'Base', chainId: 8453 },
  arbitrum: { name: 'Arbitrum', chainId: 42161 },
  optimism: { name: 'Optimism', chainId: 10 },
  bsc: { name: 'BSC', chainId: 56 },
  polygon: { name: 'Polygon', chainId: 137 },
  avalanche: { name: 'Avalanche', chainId: 43114 },
  // Add more V2-supported: fantom: { chainId: 250 }, etc.
  // Note: Abstract (2741) not supported by V2—use fallback if needed.
};

export default chains;