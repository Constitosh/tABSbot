// src/services/dexscreener.js
// ESM module
import axios from 'axios';

/**
 * Fetch best Abstract pair for a token from Dexscreener and normalize fields.
 *
 * What you get:
 * - name, symbol
 * - priceUsd
 * - volume: { m5, h1, h6, h24 }
 * - priceChange: { m5, h1, h6, h24 }
 * - marketCap (prefers `marketCap`, falls back to `fdv`), plus raw fdv
 * - imageUrl
 * - socials: { twitter, telegram, website } (best-effort extraction)
 * - moonshot: { present, progress, creator, curveType, curvePosition, marketcapThreshold }
 * - metadata: pairAddress, dexId, url, baseTokenAddress, quoteTokenSymbol
 *
 * Selection strategy:
 * - Only consider pairs where chainId === 'abstract'
 * - Pick the pair with highest 24h volume (volume.h24)
 */
export async function getDexscreenerTokenStats(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) {
    throw new Error(`Dexscreener: invalid token address: ${tokenAddress}`);
  }

  const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
  const { data } = await axios.get(url, { timeout: 12000 });

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  if (!pairs.length) return null;

  // Filter to Abstract chain
  const absPairs = pairs.filter(p => (p?.chainId || '').toLowerCase() === 'abstract');
  if (!absPairs.length) return null;

  // Choose "best" pair by largest 24h volume (fallback to 0)
  const best = absPairs
    .slice()
    .sort((a, b) => (Number(b?.volume?.h24) || 0) - (Number(a?.volume?.h24) || 0))[0];

  if (!best) return null;

  // Base fields
  const name   = best?.baseToken?.name   || best?.info?.baseToken?.name   || '';
  const symbol = best?.baseToken?.symbol || best?.info?.baseToken?.symbol || '';
  const priceUsd = toNum(best?.priceUsd ?? best?.price);
  const volume = {
    m5:  toNum(best?.volume?.m5),
    h1:  toNum(best?.volume?.h1),
    h6:  toNum(best?.volume?.h6),
    h24: toNum(best?.volume?.h24),
  };
  const priceChange = {
    m5:  toNum(best?.priceChange?.m5),
    h1:  toNum(best?.priceChange?.h1),
    h6:  toNum(best?.priceChange?.h6),
    h24: toNum(best?.priceChange?.h24),
  };

  // market cap: prefer explicit marketCap, else fdv
  const rawMarketCap = toNum(best?.marketCap);
  const fdv          = toNum(best?.fdv);
  const marketCap    = Number.isFinite(rawMarketCap) && rawMarketCap > 0 ? rawMarketCap : fdv;
  const marketCapSource = Number.isFinite(rawMarketCap) && rawMarketCap > 0 ? 'marketCap' : 'fdv';

  // image + socials
  const imageUrl = best?.info?.imageUrl || null;
  const socials = normalizeSocials(best?.info?.socials, best?.info?.websites);

  // moonshot block (if present)
  const moon = best?.moonshot || null;
  const moonshot = {
    present: Boolean(moon),
    progress: moon?.progress != null ? toNum(moon.progress) : null,
    creator: moon?.creator || null,
    curveType: moon?.curveType || null,
    curvePosition: moon?.curvePosition || null,
    marketcapThreshold: moon?.marketcapThreshold || null,
  };

  // metadata
  const meta = {
    chainId: best?.chainId || 'abstract',
    dexId: best?.dexId || null,
    url: best?.url || null,
    pairAddress: best?.pairAddress || null,
    baseTokenAddress: best?.baseToken?.address || null,
    quoteTokenSymbol: best?.quoteToken?.symbol || null,
    pairCreatedAt: best?.pairCreatedAt || null,
  };

  return {
    name,
    symbol,
    priceUsd,
    volume,
    priceChange,
    marketCap,
    fdv,
    marketCapSource,
    imageUrl,
    socials,        // { twitter, telegram, website }
    moonshot,       // { present, progress, creator, ... }
    ...meta,
  };
}

// ---------- helpers ----------

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSocials(socialsRaw, websitesRaw) {
  const socials = Array.isArray(socialsRaw) ? socialsRaw : [];
  const websites = Array.isArray(websitesRaw) ? websitesRaw : [];

  let twitter = null;
  let telegram = null;
  let website = null;

  for (const s of socials) {
    const url = s?.url || '';
    const type = (s?.type || '').toLowerCase();
    if (!twitter && (type === 'twitter' || /(^https?:\/\/)?(x\.com|twitter\.com)\//i.test(url))) {
      twitter = url;
    }
    if (!telegram && (type === 'telegram' || /(^https?:\/\/)?(t\.me|telegram\.me)\//i.test(url))) {
      telegram = url;
    }
  }

  // pick the first website if any
  if (websites.length) {
    website = websites[0];
  }

  return { twitter, telegram, website };
}
