// src/chains.js
// Central multichain config. Extend here to support more EVM chains.
export const CHAINS = {
  // key: { title, etherscanChainId, dsSlug, aliases:[] }
  tabs: {            // Abstract
    key: 'tabs',
    title: 'Abstract',
    etherscanChainId: '2741',
    dsSlug: 'abstract',
    aliases: ['abstract', 'abs']
  },
  base: {
    key: 'base',
    title: 'Base',
    etherscanChainId: '8453',
    dsSlug: 'base',
    aliases: ['coinbase', 'cb']
  },
  polygon: {
    key: 'polygon',
    title: 'Polygon',
    etherscanChainId: '137',
    dsSlug: 'polygon',
    aliases: ['matic', 'poly']
  },
};

// Map alias->key
const _aliasToKey = Object.fromEntries(Object.values(CHAINS).flatMap(c => [[c.key, c.key], ...c.aliases.map(a => [a, c.key])]));

export function resolveChain(input, fallback='tabs') {
  const k = String(input || '').toLowerCase().trim();
  return CHAINS[_aliasToKey[k]] || CHAINS[fallback];
}

export function listChainAliases() {
  return Object.values(CHAINS).map(c => ({ key: c.key, title: c.title, aliases: [c.key, ...c.aliases] }));
}
