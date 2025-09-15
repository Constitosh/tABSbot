// src/chains.js
// Central registry for multi-chain support (Dexscreener + Etherscan IDs)

export const CHAINS = Object.freeze({
  // Default tABS (Abstract chain)
  tabs:  { cmd: 'tabs',  ds: 'abstract',  es: '2741',  label: 'Abstract' },

  // Base
  tbase: { cmd: 'tbase', ds: 'base',      es: '8453',  label: 'Base' },

  // HyperEVM (adjust if your Etherscan-compatible chain id differs)
  thyper:{ cmd: 'thyper',ds: 'hyperevm',  es: '999',   label: 'HyperEVM' },
});

/** Map command name -> chain object (fallback to tabs/Abstract). */
export function getChainByCmd(cmd) {
  const k = String(cmd || '').toLowerCase();
  return CHAINS[k] || CHAINS.tabs;
}

/** Small helper to normalize chain key for cache namespacing. */
export function chainKey(dsChain) {
  return String(dsChain || 'abstract').toLowerCase();
}
