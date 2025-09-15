// src/scanClient.js
import axios from 'axios';

function makeThrottle(rps = 5) {
  const min = Math.ceil(1000 / Math.max(1, Number(rps || 5)));
  let last = 0;
  let chain = Promise.resolve();
  return async () => {
    await (chain = chain.then(async () => {
      const wait = Math.max(0, last + min - Date.now());
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
    }));
  };
}

/**
 * Single client for Etherscan v2 for ANY chain.
 * We ALWAYS hit the v2 base and pass ?chainid=<id>.
 * No .env chain id usage here.
 */
export function getScanFns(chainId, {
  apiKey = process.env.ETHERSCAN_API_KEY,
  rps    = process.env.ETHERSCAN_RPS || 5,
  v2Base = process.env.ETHERSCAN_V2_BASE || process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api',
} = {}) {
  if (!apiKey) console.warn('[SCAN] ETHERSCAN_API_KEY is missing');

  const CHAIN = String(chainId || '').trim();
  const http = axios.create({ baseURL: v2Base, timeout: 45_000 });
  const throttle = makeThrottle(rps);

  function esParams(params) {
    return { params: { chainid: CHAIN, apikey: apiKey, ...params } };
  }
  function esURL(params) {
    try {
      const u = new URL(v2Base);
      const baseParams = { chainid: CHAIN, apikey: apiKey };
      for (const [k, v] of Object.entries({ ...baseParams, ...params })) {
        u.searchParams.set(k, String(v));
      }
      return u.toString();
    } catch {
      return `${v2Base}?<params>`;
    }
  }

  async function esGET(params, { logOnce = false, tag = '' } = {}) {
    if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
    await throttle();

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { data } = await http.get('', esParams(params));
        // v2 returns { status, result, message }
        if (data?.status === '1') return data.result;
        if (Array.isArray(data?.result)) return data.result;
        if (data?.message === 'OK' && data?.result != null) return data.result;

        const msg = data?.result || data?.message || 'Etherscan v2 error';
        if (attempt === maxAttempts) throw new Error(msg);
      } catch (e) {
        if (attempt === maxAttempts) throw e;
      }
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }

  return { esGET, esURL, chainId: CHAIN, ES_BASE: v2Base, ES_IS_V2: true };
}
