// src/services/dexscreener.js
import axios from 'axios';

const DS_BASE = 'https://api.dexscreener.com';

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  // sort by highest volume.h24, then by highest liquidity.usd
  return [...pairs].sort((a, b) => {
    const vA = n(a?.volume?.h24);
    const vB = n(b?.volume?.h24);
    if (vA !== vB) return vB - vA;
    const lA = n(a?.liquidity?.usd);
    const lB = n(b?.liquidity?.usd);
    return lB - lA;
  })[0];
}

function socialsFromInfo(info) {
  const socials = Array.isArray(info?.socials) ? info.socials : [];
  let twitter, telegram, website;
  for (const s of socials) {
    const type = (s?.type || '').toLowerCase();
    const url  = s?.url || '';
    if (type === 'twitter' && !twitter) twitter = url;
    if ((type === 'telegram' || type === 'tg') && !telegram) telegram = url;
  }
  const websites = Array.isArray(info?.websites) ? info.websites : [];
  for (const w of websites) {
    if (!website && w?.url) website = w.url;
  }
  return { twitter, telegram, website };
}

/**
 * getDexscreenerTokenStats(ca) -> normalized market object or null
 * Fields used by renderer:
 *  { name, symbol, priceUsd, volume{m5,h1,h6,h24}, priceChange{m5,h1,h6,h24},
 *    marketCap, marketCapSource, imageUrl, socials{twitter,telegram,website},
 *    url, dexId }
 */
export async function getDexscreenerTokenStats(contractAddress) {
  const ca = String(contractAddress || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return null;

  const url = `${DS_BASE}/latest/dex/tokens/${ca}`;
  if (process.env.DS_DEBUG) console.log('[DEX] GET', url);

  const { data } = await axios.get(url, { timeout: 15000 }).catch((e) => {
    if (process.env.DS_DEBUG) console.error('[DEX] ERROR', e?.message || e);
    return { data: null };
  });

  const allPairs = data?.pairs || [];
  // Keep only Abstract chainId
  const abstractPairs = allPairs.filter((p) => (p?.chainId || '').toLowerCase() === 'abstract');
  if (process.env.DS_DEBUG) {
    console.log('[DEX] pairs total=', allPairs.length, 'abstract=', abstractPairs.length);
  }
  if (!abstractPairs.length) return null;

  const best = pickBestPair(abstractPairs);
  if (!best) return null;

  const name   = best?.baseToken?.name || 'Token';
  const symbol = best?.baseToken?.symbol || '';
  const priceUsd = n(best?.priceUsd);
  const volume = {
    m5: n(best?.volume?.m5),
    h1: n(best?.volume?.h1),
    h6: n(best?.volume?.h6),
    h24: n(best?.volume?.h24),
  };
  const priceChange = {
    m5: n(best?.priceChange?.m5),
    h1: n(best?.priceChange?.h1),
    h6: n(best?.priceChange?.h6),
    h24: n(best?.priceChange?.h24),
  };

  // Prefer true marketCap if present; otherwise use fdv and mark source accordingly
  const mc = n(best?.marketCap);
  const fdv = n(best?.fdv);
  let marketCap = mc || fdv || 0;
  let marketCapSource = mc ? 'mc' : (fdv ? 'fdv' : undefined);

  const imageUrl = best?.info?.imageUrl || null;
  const { twitter, telegram, website } = socialsFromInfo(best?.info);
  const dexId = best?.dexId || null;
  const pairUrl = best?.url || null;

  const out = {
    name,
    symbol,
    priceUsd,
    volume,
    priceChange,
    marketCap,
    marketCapSource,
    imageUrl,
    socials: { twitter, telegram, website },
    url: pairUrl,
    dexId,
  };

  if (process.env.DS_DEBUG) console.log('[DEX] selected pair', JSON.stringify(out, null, 2));
  return out;
}

export default { getDexscreenerTokenStats };