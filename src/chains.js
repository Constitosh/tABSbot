// src/chains.js
// Central place to define per-command chain routing for Dexscreener + Etherscan v2.

export const CHAINS = {
  tabs:  { label: 'Abstract', cmd: 'tabs',  ds: 'abstract', es: '2741' },
  tbase: { label: 'Base',     cmd: 'tbase', ds: 'base',     es: '8453' },
  thyper:{ label: 'HyperEVM', cmd: 'thyper',ds: 'hyperevm', es: '999'  },
};

// map command -> chain record
export function getChainByCmd(cmd = 'tabs') {
  const k = String(cmd).toLowerCase();
  return CHAINS[k] || CHAINS.tabs;
}

// small helper used for cache keys (namespacing)
export function chainKey(dsChain) {
  return String(dsChain || 'abstract').toLowerCase();
}