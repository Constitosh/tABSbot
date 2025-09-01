// src/services/dexscreener.js
import axios from 'axios';
import '../configEnv.js';


/**
 * Fetch raw Dexscreener data for a token address (Abstract pairs only).
 * @param {string} tokenAddress 0x... (40 hex)
 * @returns {Promise<{ schemaVersion?: string, pairs: any[] }>}
 */
export async function fetchDexscreenerRaw(tokenAddress) {
  const ca = (tokenAddress || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) {
    throw new Error(`Dexscreener: invalid token address: ${tokenAddress}`);
  }

  const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
  
  // after fetching Dexscreener /latest/dex/tokens/<CA>
const pairs = Array.isArray(data.pairs) ? data.pairs : [];
const pairsAbstract = pairs.filter(p => p.chainId === 'abstract');

// pick best AMM (real on-chain) pair
const ammCandidates = pairsAbstract.filter(p => !String(p.pairAddress).includes(':moon'));
const bestAMM = ammCandidates
  .slice()
  .sort((a, b) => ((b.volume?.h24 || 0) - (a.volume?.h24 || 0)) ||
                  ((b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)))
  [0] || null;

// pick moonshot “pair” if present
const moon = pairsAbstract.find(p => String(p.pairAddress).includes(':moon')) || null;

return {
  summary: {
    name: baseTokenName,
    symbol: baseTokenSymbol,
    priceUsd: Number(bestAMM?.priceUsd ?? moon?.priceUsd ?? 0) || null,
    volume: bestAMM?.volume || moon?.volume || null,
    priceChange: bestAMM?.priceChange || moon?.priceChange || null,
    fdv: Number(bestAMM?.fdv ?? moon?.fdv ?? 0) || null,
    marketCapSource: bestAMM?.marketCap ? 'market' : (bestAMM?.fdv || moon?.fdv ? 'fdv' : null),

    // IMPORTANT: expose both — one is real on-chain, the other is not.
    pairAddress: bestAMM?.pairAddress || null,       // real 0x… (for buyers & LP exclusion)
    launchPadPair: moon?.pairAddress || null,        // "0xTOKEN:moon" (for UI only)
    dexId: bestAMM?.dexId || moon?.dexId || null,
    chainId: 'abstract',
  }
};
  
  const { data } = await axios.get(url, { timeout: 12000 });

  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const abstractPairs = pairs.filter(
    (p) => (p?.chainId || '').toLowerCase() === 'abstract'
  );

  return { schemaVersion: data?.schemaVersion, pairs: abstractPairs };
}

/**
 * Pick the "best" pair from a list.
 * @param {any[]} pairs  Dexscreener pair objects
 * @param {{metric?: 'volume.h24'|'liquidity.usd'}} [opts]
 */
function pickBestPair(pairs, opts = {}) {
  const metric = opts.metric || 'volume.h24';
  const path = metric.split('.'); // e.g., ['volume','h24']

  const getMetric = (p) => {
    try {
      let v = p;
      for (const k of path) v = v?.[k];
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  };

  return pairs
    .slice()
    .sort((a, b) => getMetric(b) - getMetric(a))[0] || null;
}

/**
 * Normalize a single pair to your desired summary structure.
 * Includes *all* useful public fields we can extract + raw pair object.
 * @param {any} best
 */
function normalizePair(best) {
  if (!best) return null;

  const name   = best?.baseToken?.name   || best?.info?.baseToken?.name || '';
  const symbol = best?.baseToken?.symbol || best?.info?.baseToken?.symbol || '';
  const baseTokenAddress  = best?.baseToken?.address || null;
  const quoteTokenAddress = best?.quoteToken?.address || null;
  const quoteTokenSymbol  = best?.quoteToken?.symbol || null;

  const priceNative = toNum(best?.priceNative);
  const priceUsd    = toNum(best?.priceUsd ?? best?.price);

  const txns = {
    m5: safeTxn(best?.txns?.m5),
    h1: safeTxn(best?.txns?.h1),
    h6: safeTxn(best?.txns?.h6),
    h24: safeTxn(best?.txns?.h24),
  };

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

  const liquidity = {
    usd: toNum(best?.liquidity?.usd),
    base: toNum(best?.liquidity?.base),
    quote: toNum(best?.liquidity?.quote),
  };

  // market cap: prefer marketCap, fallback to fdv
  const rawMarketCap = toNum(best?.marketCap);
  const fdv          = toNum(best?.fdv);
  const marketCap    = rawMarketCap > 0 ? rawMarketCap : fdv;
  const marketCapSource = rawMarketCap > 0 ? 'marketCap' : 'fdv';

  // images & socials & websites
  const imageUrl  = best?.info?.imageUrl || null;
  const header    = best?.info?.header   || null;
  const openGraph = best?.info?.openGraph || null;

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

  // meta
  const meta = {
    schemaVersion: best?.schemaVersion || null, // usually on top-level response
    chainId: best?.chainId || 'abstract',
    dexId: best?.dexId || null,
    url: best?.url || null,
    pairAddress: best?.pairAddress || null,
    pairCreatedAt: best?.pairCreatedAt || null,
  };

  return {
    // headline
    name, symbol,
    baseTokenAddress, quoteTokenAddress, quoteTokenSymbol,

    // prices & volumes
    priceNative, priceUsd, volume, priceChange, txns, liquidity,

    // valuation
    marketCap, fdv, marketCapSource,

    // media & links
    imageUrl, header, openGraph,
    socials,  // { twitter, telegram, website, others: [...] }

    // moonshot block
    moonshot,

    // meta
    ...meta,

    // keep the full raw pair (handy for future additions)
    pairRaw: best,
  };
}

/**
 * Main function you can use in your worker/bot.
 * Returns: { summary, bestPair, pairsRaw, selection }
 *  - summary: normalized summary (see normalizePair)
 *  - bestPair: the same as summary.pairRaw (kept for convenience)
 *  - pairsRaw: ALL Abstract pairs as returned by Dexscreener (unmodified)
 *  - selection: which metric was used to pick best pair
 *
 * @param {string} tokenAddress
 * @param {{ metric?: 'volume.h24'|'liquidity.usd' }} [opts]
 */
export async function getDexscreenerTokenStats(tokenAddress, opts = {}) {
  const { schemaVersion, pairs } = await fetchDexscreenerRaw(tokenAddress);
  if (!pairs.length) {
    return { summary: null, bestPair: null, pairsRaw: [], selection: { metric: opts.metric || 'volume.h24', schemaVersion } };
  }

  const best = pickBestPair(pairs, opts);
  const summary = normalizePair(best);
  if (summary) summary.schemaVersion = schemaVersion || summary.schemaVersion;

  return {
    summary,
    bestPair: best || null,
    pairsRaw: pairs,
    selection: { metric: opts.metric || 'volume.h24', schemaVersion },
  };
}

/* ----------------- helpers ----------------- */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeTxn(obj) {
  const buys  = toNum(obj?.buys);
  const sells = toNum(obj?.sells);
  return { buys, sells };
}


function pickUrl(x) {
  if (!x) return null;
  if (typeof x === 'string') return x;
  if (typeof x === 'object' && typeof x.url === 'string') return x.url;
  return null;
}

function normalizeSocials(socialsRaw, websitesRaw) {
  const socials = Array.isArray(socialsRaw) ? socialsRaw : [];
  const websites = Array.isArray(websitesRaw) ? websitesRaw : [];

  let twitter = null;
  let telegram = null;
  let website = null;
  const others = [];

  for (const s of socials) {
    const url = pickUrl(s?.url || s);
    const type = (s?.type || '').toLowerCase();
    if (!url) continue;

    if (!twitter && (type === 'twitter' || /(^https?:\/\/)?(x\.com|twitter\.com)\//i.test(url))) {
      twitter = url; continue;
    }
    if (!telegram && (type === 'telegram' || /(^https?:\/\/)?(t\.me|telegram\.me)\//i.test(url))) {
      telegram = url; continue;
    }
    others.push({ type: type || 'unknown', url });
  }

  // websites can be strings or objects
  if (websites.length) {
    website = pickUrl(websites[0]);
    for (let i = 1; i < websites.length; i++) {
      const u = pickUrl(websites[i]);
      if (u) others.push({ type: 'website', url: u });
    }
  }

  // final sanitation: only keep strings
  twitter = typeof twitter === 'string' ? twitter : null;
  telegram = typeof telegram === 'string' ? telegram : null;
  website = typeof website === 'string' ? website : null;

  return { twitter, telegram, website, others };
}



