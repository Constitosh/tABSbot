// src/chains.js
// Central place to define supported chains and how to call DS/ES for each.

export const CHAINS = {
  // Default Abstract (what /stats did before) -> now /tabs
  abstract: {
    key: 'abstract',
    dsSlug: 'abstract',     // dexscreener slug for /tokens/v1/<slug>/<CA> and filtering latest pairs
    esChainId: '2741',      // Etherscan v2 "chainid" param
    label: 'Abstract',
    commands: ['/tabs'],    // primary command(s) that map here
  },

  // Base (new)
  base: {
    key: 'base',
    dsSlug: 'base',
    esChainId: '8453',
    label: 'Base',
    commands: ['/tbase'],
  },

  // Hyper EVM (new)
  hyperevm: {
    key: 'hyperevm',
    dsSlug: 'hyperevm',
    esChainId: '999',
    label: 'Hyper EVM',
    commands: ['/thyper'],
  },
};

// quick lookup from command -> chainKey
export const COMMAND_TO_CHAIN = Object.values(CHAINS).reduce((acc, ch) => {
  for (const c of ch.commands) acc[c] = ch.key;
  return acc;
}, {});

// helpers
export function getChainByKey(key) {
  const ck = String(key || '').toLowerCase();
  return CHAINS[ck] || null;
}

export function getChainByCommand(cmd) {
  return getChainByKey(COMMAND_TO_CHAIN[cmd]);
}