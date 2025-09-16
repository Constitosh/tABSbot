// src/indexer.js
import { ensureIndexSnapshot, buildIndexSnapshot } from './indexWorker.js';
import { getJSON } from './cache.js';
import { resolveChain } from './chains.js';

// Legacy helper — chain-aware reader
export async function getIndexSnapshot(tokenAddress, chainKey = 'tabs') {
  const chain = resolveChain(chainKey);
  const ca = String(tokenAddress || '').toLowerCase();
  const key = `token:${chain.key}:${ca}:index:data`;
  return (await getJSON(key)) || null;
}

// Forwarders
export { ensureIndexSnapshot, buildIndexSnapshot };
