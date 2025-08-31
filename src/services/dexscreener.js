// src/services/dexscreener.js
// Dexscreener market fetch + normalization for Abstract chain.
//
// Exports:
//   getDexscreenerTokenStats(contractAddress) -> {
//     name, symbol, priceUsd,
//     volume: { m5,h1,h6,h24 },
//     priceChange: { m5,h1,h6,h24 },
//     marketCap,              // prefers marketCap; falls back to fdv
//     marketCapSource,        // 'mc' or 'fdv'
//     imageUrl,
//     socials: { twitter, telegram, website },
//     url,                    // pair url
//     dexId                   // e.g. 'abstractswap', 'moonshot'
//   } | null
//
// Notes:
// - Filters strictly to chainId === 'abstract'.
// - Chooses pair by highest volume.h24, tiebreaker liquidity.usd.
// - Safe numeric parsing and null guards.
// - Opt-in debug logs: set DS_DEBUG=true

import axios from 'axios';

const DS_BASE = (process.env.DS_ENDPOINT || 'https://api.dexscreener.com').replace(/\/+$/, '');

// ---------- small helpers ----------
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const isAbstract = (p) => String(p?.chainId || '').toLowerCase() === 'abstract';

function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  // Clone + sort: primary key = volume.h24 desc, secondary = liquidity.usd desc
  const sorted = [...pairs].sort((a, b) => {
    const vA = num(a?.volume?.h24);
    const vB = num(b?.volume?.h24);
    if (vA !== vB) return vB - vA;

    const lA = num(a?.liquidity?.usd);
    const lB = num(b?.liquidity?.usd);
    return lB - lA;
  });

  return sorted[0] || null;
}

function extractSocials(info) {
  const socials = Array.isArray(info?.socials) ? info.socials : [];
  const websites = Array.isArray(info?.websites) ? info.websites : [];

  let twitter, telegram, website;

  for (const s of socials) {
    const type = String(s?.type || '').toLowerCase();
    const url  = s?.url || '';
    if (!twitter && type === 'twitter' && url)  twitter  = url;
    if (!telegram && (type === 'telegram' || type === 'tg') && url) telegram = url;
  }
  for (const w of websites) {
    if (!website && w?.url) website = w.url;
  }
  return { twitter, telegram, website };
}

// ---------- main ----------
export async function getDexscreenerTokenStats(contractAddress) {
  const ca = String(contractAddress || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return null;

  const url = `${DS_BASE}/latest/dex/tokens/${ca}`;
  if (process.env.DS_DEBUG) console.log('[DEX] GET', url);

  let data;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    data = res?.data;
  } catch (e) {
    if (process.env.DS_DEBUG) console.error('[DEX] HTTP ERROR', e?.message || e);
    return null;
  }

  const allPairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const abstractPairs = allPairs.filter(isAbstract);

  if (process.env.DS_DEBUG) {
    console.log('[DEX] pairs total=', allPairs.length, 'abstract=', abstractPairs.length);
  }

  if (abstractPairs.length === 0) return null;

  const best = pickBestPair(abstractPairs);
  if (!best) return null;

  const name   = best?.baseToken?.name   || 'Token';
  const symbol = best?.baseToken?.symbol || '';
  const priceUsd = num(best?.priceUsd);

  const volume = {
    m5: num(best?.volume?.m5),
    h1: num(best?.volume?.h1),
    h6: num(best?.volume?.h6),
    h24: num(best?.volume?.h24),
  };

  const priceChange = {
    m5:  num(best?.priceChange?.m5),
    h1:  num(best?.priceChange?.h1),
    h6:  num(best?.priceChange?.h6),
    h24: num(best?.priceChange?.h24),
  };

  // Prefer marketCap; fallback to fdv; label source.
  const mc  = num(best?.marketCap);
  const fdv = num(best?.fdv);
  const marketCap = mc || fdv || 0;
  const marketCapSource = mc ? 'mc' : (fdv ? 'fdv' : undefined);

  const imageUrl = best?.info?.imageUrl || null;
  const { twitter, telegram, website } = extractSocials(best?.info);
  const dexId = best?.dexId || null;
  const pairUrl = best?.url || null;

  const mapped = {
    name,
    symbol,
    priceUsd,
    volume,
    priceChange,
    marketCap,
    marketCapSource,   // renderer uses this to label "Market Cap" vs "FDV (as cap)"
    imageUrl,
    socials: { twitter, telegram, website },
    url: pairUrl,
    dexId,
  };

  if (process.env.DS_DEBUG) {
    console.log('[DEX] selected pair:', JSON.stringify({
      chainId: best?.chainId,
      dexId: best?.dexId,
      url: best?.url,
      priceUsd: mapped.priceUsd,
      volume: mapped.volume,
      priceChange: mapped.priceChange,
      marketCap: mapped.marketCap,
      marketCapSource: mapped.marketCapSource,
      socials: mapped.socials
    }, null, 2));
  }

  return mapped;
}

export default { getDexscreenerTokenStats };