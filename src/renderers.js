// src/renderers.js
// HTML renderers for Telegram UI (safe against MarkdownV2 issues)
import { esc, pct, money, shortAddr, trendBadge } from './ui_html.js';

/** tiny text progress bar (10 slots) */
function progressBar(pctNum) {
  if (typeof pctNum !== 'number' || !isFinite(pctNum)) return null;
  const p = Math.max(0, Math.min(100, pctNum));
  const filled = Math.round(p / 10);  // 0..10
  const empty  = 10 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${p.toFixed(2)}%`;
}

/* -------------------- NEW: Holder distribution helpers -------------------- */

/** Pick 6 reasonable USD value buckets from market cap order of magnitude */
function pickBucketsUSD(mcap) {
  // Fallback if MC unknown
  if (!(mcap > 0)) {
    return [10, 50, 100, 250, 500, 1000]; // <$10 .. >$1000
  }
  if (mcap < 100_000) {
    return [10, 25, 50, 100, 250, 500];
  }
  if (mcap < 1_000_000) {
    return [25, 100, 250, 500, 1000, 2500];
  }
  if (mcap < 10_000_000) {
    return [50, 250, 1000, 2500, 5000, 10000];
  }
  return [100, 500, 2000, 5000, 10000, 25000];
}

/** ASCII bar (Telegram safe). maxBlocks auto scales to max count. */
function bar(count, max, maxBlocks = 12) {
  if (!(max > 0)) return '';
  const filled = Math.max(0, Math.round((count / max) * maxBlocks));
  const empty  = Math.max(0, maxBlocks - filled);
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/** Gini index from an array of non-negative values */
function gini(values) {
  const arr = (values || []).filter(v => v >= 0);
  const n = arr.length;
  if (n === 0) return 0;
  const sum = arr.reduce((a,b)=>a+b,0);
  if (sum === 0) return 0;
  arr.sort((a,b)=>a-b);
  // G = 1 + 1/n - (2/(n^2 * mean)) * sum_i ( (n+1-i) * x_i )
  let cum = 0;
  for (let i=0;i<n;i++) cum += (i+1) * arr[i];
  const mean = sum / n;
  const G = 1 + 1/n - (2 * cum) / (n * n * mean);
  return Math.max(0, Math.min(1, G));
}

/** Human value formatting: 1234 -> $1,234; small -> $0.00 */
function usd(x) {
  const v = Number(x || 0);
  if (!isFinite(v)) return '$0';
  if (v >= 1000) return '$' + Math.round(v).toLocaleString();
  return '$' + v.toFixed(2);
}

/** Build the holder distribution section text */
function holderDistributionSection(data) {
  const m = data.market || {};
  const mcap = Number(m.marketCap || m.fdv || 0);
  const priceUsd = Number(m.priceUsd || 0);

  // Prefer full-holders percent list if you later store it (lightweight):
  //   data.holdersAllPerc = [0.52, 0.21, ...]  (percent of supply per holder)
  // Otherwise fall back to top20 percents.
  let percents = [];
  if (Array.isArray(data.holdersAllPerc) && data.holdersAllPerc.length) {
    percents = data.holdersAllPerc.slice();
  } else if (Array.isArray(data.holdersTop20) && data.holdersTop20.length) {
    percents = data.holdersTop20.map(h => Number(h.percent || 0));
  } else {
    // nothing to show
    return null;
  }

  // Holder USD value ≈ percent * market cap (works w/o supply/price).
  // This is the most stable estimate and avoids new API calls.
  const valuesUSD = percents.map(p => (mcap > 0 ? (p/100) * mcap : 0));

  // Split by $10 threshold
  const gt10 = valuesUSD.filter(v => v >= 10).length;
  const lt10 = valuesUSD.length - gt10;

  // Pick 6 buckets based on MC, then bin holder values
  const B = pickBucketsUSD(mcap); // strictly increasing
  // Buckets labeling: <B0, <B1, <B2, <B3, <B4, >=B4 and <B5, >=B5
  const counts = [0,0,0,0,0,0]; // 6 buckets
  for (const v of valuesUSD) {
    if (v < B[0]) counts[0]++; else
    if (v < B[1]) counts[1]++; else
    if (v < B[2]) counts[2]++; else
    if (v < B[3]) counts[3]++; else
    if (v < B[4]) counts[4]++; else counts[5]++;
  }
  const maxCount = Math.max(...counts, 1);

  // Compact distribution by % of supply (fixed thresholds)
  // Thresholds are *percent of supply* per holder
  const tPct = [0.01, 0.05, 0.1, 0.5]; // last category is >= 1%
  let c0=0,c1=0,c2=0,c3=0,c4=0;
  for (const p of percents) {
    if (p < tPct[0]) c0++;
    else if (p < tPct[1]) c1++;
    else if (p < tPct[2]) c2++;
    else if (p < tPct[3]) c3++;
    else c4++; // >=0.5% (this includes 1%+, we’ll surface that wording below)
  }

  // Inequality (Gini)
  const g = gini(percents); // using percents is fine (scale-invariant)
  const gBadge = g >= 0.8 ? '🐋' : g >= 0.6 ? '🦈' : g >= 0.4 ? '🐠' : '🫧';
  const gLine = `Inequality (Gini): <b>${(g*100).toFixed(1)}%</b> ${gBadge} — <i>0% = equal, 100% = concentrated</i>`;

  // Build histogram lines
  const labels = [
    `< $${B[0]}`,
    `< $${B[1]}`,
    `< $${B[2]}`,
    `< $${B[3]}`,
    `< $${B[4]}`,
    `≥ $${B[4]}`
  ];
  const histo = labels.map((lab, i) => {
    return `${esc(lab.padEnd(7))} ${bar(counts[i], maxCount)} <b>(${counts[i]})</b>`;
  });

  // Explain whether we used all holders or top slice
  const scopeNote = Array.isArray(data.holdersAllPerc) ? '' : ' <i>(top holders subset)</i>';

  // Real “holders type”: $10+ vs <$10
  const realHoldersLine = `Real holders (≥ $10): <b>${gt10}</b>  ·  Small holders (&lt; $10): <b>${lt10}</b>`;

  // Compact supply share distribution
  const supplyDist = [
    `&lt;0.01% x${c0}`,
    `&lt;0.05% x${c1}`,
    `&lt;0.1% x${c2}`,
    `&lt;0.5% x${c3}`,
    `≥1% x${c4}`
  ].join('  ·  ');

  return [
    `💵 <b>Holder Value Distribution</b>${scopeNote}`,
    realHoldersLine,
    ...histo,
    gLine,
    ``,
    `📈 <b>Supply Share (per holder)</b>`,
    supplyDist,
  ].join('\n');
}

/* ------------------------------------------------------------------------- */

/**
 * Overview screen
 */
export function renderOverview(data) {
  const m = data.market || null;
  const name = esc(m?.name || 'Token');
  const sym  = esc(m?.symbol || '');
  const ca   = esc(data.tokenAddress);
  const t24  = trendBadge(m?.priceChange?.h24);

  const vol = m?.volume || {};
  const chg = m?.priceChange || {};
  const capLabel = (m?.marketCapSource === 'fdv') ? 'FDV (as cap)' : 'Market Cap';

  // ---- Moonshot detection & line ----
  const isMoonshot =
    !!m?.launchPadPair ||
    String(m?.dexId || '').toLowerCase() === 'moonshot' ||
    !!m?.moonshot;

  const moonProgress = (typeof m?.moonshot?.progress === 'number')
    ? Math.max(0, Math.min(100, Number(m.moonshot.progress)))
    : null;

  // Header icon: 🌙 only if moonshot
  const moonshotHeaderIcon = isMoonshot ? '🌙 ' : '';

  // Dedicated Moonshot line
  const moonshotLine = isMoonshot
    ? (moonProgress != null
        ? `Moonshot: <b>Yes</b>  ${esc(progressBar(moonProgress))}`
        : `Moonshot: <b>Yes</b>`)
    : `Moonshot: <b>No</b>`;

  const holdersLine =
    typeof data.holdersCount === 'number'
      ? `Holders: <b>${data.holdersCount.toLocaleString()}</b>`
      : `Holders: <i>N/A (explorer)</i>`;

  const top10Line =
    data.top10CombinedPct != null
      ? `Top 10 combined: <b>${esc(pct(data.top10CombinedPct))}</b>`
      : `Top 10 combined: <i>N/A</i>`;

  const burnedLine =
    data.burnedPct != null
      ? `Burned: <b>${esc(pct(data.burnedPct))}</b>`
      : `Burned: <i>N/A</i>`;

  const creatorAddr = data.creator?.address ? esc(shortAddr(data.creator.address)) : 'unknown';

  // -- Holder Distribution section --
  const distBlock = holderDistributionSection(data);

  const lines = [
    `${moonshotHeaderIcon}<b>${name}${sym ? ` (${sym})` : ''}</b>`,
    `<code>${ca}</code>`,
    moonshotLine,
    '',
    (m ? `${capLabel}: <b>${esc(money(m.marketCap))}</b>` : undefined),
    (m && typeof m.priceUsd === 'number')
      ? `Price: <b>${esc(money(m.priceUsd, 8))}</b>   ${t24}`
      : `<i>No market data yet (no Abstract pair indexed)</i>`,
    '',
    `Volume (24h): <b>${esc(money(vol.h24))}</b>`,
    (m ? `5m <b>${esc(money(vol.m5))}</b> • 1h <b>${esc(money(vol.h1))}</b> • 6h <b>${esc(money(vol.h6))}</b>` : undefined),
    '',
    `Change (24h): <b>${esc(pct(chg.h24))}</b>`,
    (m ? `5m <b>${esc(pct(chg.m5))}</b> • 1h <b>${esc(pct(chg.h1))}</b> • 6h <b>${esc(pct(chg.h6))}</b>` : undefined),
    '',
    holdersLine,
    `Creator: <code>${creatorAddr}</code> — <b>${esc(pct(data.creator?.percent))}</b>`,
    top10Line,
    burnedLine,
    '',
    ...(distBlock ? [distBlock, ''] : []), // insert the new section if we have data
    `<i>Pick a section:</i>`,
    `• <b>Buyers</b> — first 20 buyers + status`,
    ...(hasHolders(data) ? [`• <b>Holders</b> — top 20 holder percentages`] : []),
    '',
    `<i>Updated: ${esc(new Date(data.updatedAt).toLocaleString())}</i>`,
    `<i>Source: Dexscreener · Explorer</i>`
  ].filter(Boolean);

  const text = lines.join('\n');

  // Keyboard
  const navRow = hasHolders(data)
    ? [
        { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` },
        { text:'📊 Holders',     callback_data:`holders:${data.tokenAddress}:1` }
      ]
    : [
        { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` }
      ];

  const kb = {
    reply_markup: {
      inline_keyboard: [
        // socials row will be unshifted below if present
        [],
        navRow,
        [
          { text:'↻ Refresh',      callback_data:`refresh:${data.tokenAddress}` },
          { text:'ℹ️ About',       callback_data:'about' }
        ]
      ].filter(row => row.length)
    }
  };

  // Socials row (use only string URLs)
  const linkRow = [];
  const t = m?.socials?.twitter;
  const g = m?.socials?.telegram;
  const w = m?.socials?.website;

  if (typeof t === 'string' && t.length) linkRow.push({ text: '𝕏 Twitter', url: t });
  if (typeof g === 'string' && g.length) linkRow.push({ text: 'Telegram',  url: g });
  if (typeof w === 'string' && w.length) linkRow.push({ text: 'Website',   url: w });

  if (linkRow.length) kb.reply_markup.inline_keyboard.unshift(linkRow);

  return { text, extra: kb };
}

/**
 * Buyers screen with pagination
 * data.first20Buyers = [{ address, status, buys?, sells? }, ...]
 */
export function renderBuyers(data, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  const rows = (data.first20Buyers || []).slice(start, start + pageSize);
  const name = esc(data.market?.name || 'Token');

  const body = rows.map((r, i) => {
    const n = String(start + i + 1).padStart(2, '0');
    function formatStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'hold': return '🟢 Hold';
    case 'sold all': return '🔴 Sold All';
    case 'sold some': return '🟠 Sold Some';
    case 'bought more': return '🔵 Bought More';
    default: return status || 'N/A';
  }
}
    return `${n}. <code>${esc(shortAddr(r.address))}</code> — ${esc(r.status)}`;
  }).join('\n') || '<i>No buyers found yet</i>';

  const totalPages = Math.ceil((data.first20Buyers || []).length / pageSize) || 1;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    `🧑‍🤝‍🧑 <b>First 20 Buyers — ${name}</b>`,
    '',
    body,
    '',
    `Tip: Status uses final balance vs buy/sell history.`,
    '',
    `<i>Updated: ${esc(new Date(data.updatedAt).toLocaleString())}</i>  ·  <i>Page ${page}/${totalPages}</i>`
  ].join('\n');

  const prevCb = page > 1 ? `buyers:${data.tokenAddress}:${prev}` : 'noop';
  const nextCb = page < totalPages ? `buyers:${data.tokenAddress}:${next}` : 'noop';

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'◀️', callback_data: prevCb },
          { text:`${page}/${totalPages}`, callback_data:'noop' },
          { text:'▶️', callback_data: nextCb }
        ],
        [
          { text:'🏠 Overview', callback_data:`stats:${data.tokenAddress}` },
          ...(hasHolders(data) ? [{ text:'📊 Holders',  callback_data:`holders:${data.tokenAddress}:1` }] : [])
        ]
      ]
    }
  };

  return { text, extra: kb };
}

/**
 * Holders screen with pagination
 * data.holdersTop20 = [{ address, percent }]
 */
export function renderHolders(data, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  const rows = (data.holdersTop20 || []).slice(start, start + pageSize);
  const name = esc(data.market?.name || 'Token');

  const body = rows.length
    ? rows.map((h, i) => {
        const n = String(start + i + 1).padStart(2, '0');
        return `${n}. <code>${esc(shortAddr(h.address))}</code> — <b>${esc(pct(h.percent))}</b>`;
      }).join('\n')
    : '<i>Top holders unavailable.</i>';

  const totalPages = Math.ceil((data.holdersTop20 || []).length / pageSize) || 1;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    `📊 <b>Top Holders — ${name}</b>`,
    '',
    body,
    '',
    `Notes:`,
    `• Burn addresses (0x0 / 0xdead) are included in burned%.`,
    `• Top-10 combined is shown in the overview.`,
    '',
    `<i>Updated: ${esc(new Date(data.updatedAt).toLocaleString())}</i>  ·  <i>Page ${page}/${totalPages}</i>`
  ].join('\n');

  const prevCb = page > 1 ? `holders:${data.tokenAddress}:${prev}` : 'noop';
  const nextCb = page < totalPages ? `holders:${data.tokenAddress}:${next}` : 'noop';

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'◀️', callback_data: prevCb },
          { text:`${page}/${totalPages}`, callback_data:'noop' },
          { text:'▶️', callback_data: nextCb }
        ],
        [
          { text:'🏠 Overview',    callback_data:`stats:${data.tokenAddress}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${data.tokenAddress}:1` }
        ]
      ]
    }
  };

  return { text, extra: kb };
}

/**
 * Optional: About screen content
 */
export function renderAbout() {
  const text = [
    `🤖 <b>tABS Tools</b>`,
    '',
    `• Market: Dexscreener (Abstract)`,
    `• Transfers & creator: Explorer`,
    `• Refresh cooldown: 30s`,
    `• Data cache: 3 minutes`,
    '',
    `<i>Made for Abstract chain token analytics.</i>`
  ].join('\n');

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [{ text:'Back', callback_data: 'noop' }]
      ]
    }
  };
  return { text, extra };
}

/* ---------- helpers ---------- */
function hasHolders(data) {
  return Array.isArray(data.holdersTop20) && data.holdersTop20.length > 0;
}
