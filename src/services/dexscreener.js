// src/services/dexscreener.js
// Dexscreener (Abstract) → normalized "market" object for the bot/renderers.

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickBestPair(list, ca) {
  const baseMatches = list.filter(
    (p) => p?.baseToken?.address?.toLowerCase() === ca
  );
  const candidates = baseMatches.length ? baseMatches : list;

  // choose highest-liquidity pair
  return candidates
    .slice()
    .sort((a, b) => toNum(b?.liquidity?.usd || 0) - toNum(a?.liquidity?.usd || 0))[0];
}

function extractSocials(info) {
  const socials = { twitter: '', telegram: '', website: '' };

  if (Array.isArray(info?.socials)) {
    for (const s of info.socials) {
      if (!s?.url) continue;
      if (s.type === 'twitter' && !socials.twitter) socials.twitter = s.url;
      if (s.type === 'telegram' && !socials.telegram) socials.telegram = s.url;
    }
  }
  if (Array.isArray(info?.websites)) {
    const w = info.websites.find(Boolean);
    if (w?.url && !socials.website) socials.website = w.url;
  }
  return socials;
}

/**
 * Fetch & normalize Dexscreener token data for Abstract chain.
 * Returns:
 * {
 *   pairAddress, url, name, symbol,
 *   priceNative, priceUsd,
 *   priceChange: { m5,h1,h6,h24 },
 *   volume: { m5,h1,h6,h24 },
 *   liquidity: { usd },
 *   marketCap, fdv, marketCapSource: 'mcap'|'fdv',
 *   socials: { twitter, telegram, website },
 *   info: { imageUrl, header, openGraph },
 *   moonshot: { creator }
 * }
 */
export async function getDexscreenerTokenStats(contractAddress) {
  const ca = String(contractAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error('Invalid contract address');

  const url = `https://api.dexscreener.com/tokens/v1/abstract/${ca}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const p = pickBestPair(data, ca);
  if (!p) return null;

  const info = p.info || {};
  const socials = extractSocials(info);

  const priceChange = {
    m5: toNum(p?.priceChange?.m5),
    h1: toNum(p?.priceChange?.h1),
    h6: toNum(p?.priceChange?.h6),
    h24: toNum(p?.priceChange?.h24),
  };

  const volume = {
    m5: toNum(p?.volume?.m5) || 0,
    h1: toNum(p?.volume?.h1) || 0,
    h6: toNum(p?.volume?.h6) || 0,
    h24: toNum(p?.volume?.h24) || 0,
  };

  // Prefer marketCap; fall back to fdv (and tell the renderer which one we used)
  const mcap = toNum(p?.marketCap);
  const fdv = toNum(p?.fdv);
  const marketCap = mcap ?? fdv ?? null;
  const marketCapSource = mcap != null ? 'mcap' : 'fdv';

  return {
    pairAddress: p?.pairAddress?.toLowerCase() || null,
    url: p?.url || null,

    name: p?.baseToken?.name || 'Token',
    symbol: p?.baseToken?.symbol || '',

    priceNative: toNum(p?.priceNative),
    priceUsd: toNum(p?.priceUsd),

    priceChange,
    volume,

    liquidity: { usd: toNum(p?.liquidity?.usd) || 0 },

    marketCap,
    fdv: fdv ?? null,
    marketCapSource,

    socials,
    info: {
      imageUrl: info?.imageUrl || null,
      header: info?.header || null,
      openGraph: info?.openGraph || null,
    },

    // for creator fallback in worker if needed
    moonshot: {
      creator: p?.moonshot?.creator
        ? String(p.moonshot.creator).toLowerCase()
        : null,
    },
  };
}