// src/renderers.js
// HTML renderers for Telegram UI (safe against Markdown/HTML issues)
import { esc, pct, money, shortAddr, trendBadge } from './ui_html.js';

/** tiny text progress bar (10 slots) */
function progressBar(pctNum) {
  if (typeof pctNum !== 'number' || !isFinite(pctNum)) return null;
  const p = Math.max(0, Math.min(100, pctNum));
  const filled = Math.round(p / 10);  // 0..10
  const empty  = 10 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${p.toFixed(2)}%`;
}

/* ---------- helpers ---------- */
function hasHolders(data) {
  return Array.isArray(data.holdersTop20) && data.holdersTop20.length > 0;
}
const BR = '\u200B';

/**
 * Overview screen (ordered for readability)
 */
export function renderOverview(data) {
  const m = data.market || null;
  const name = esc(m?.name || 'Token');
  const sym  = esc(m?.symbol || '');
  const ca   = esc(data.tokenAddress);

  const capLabel = (m?.marketCapSource === 'fdv') ? 'FDV (as cap)' : 'Market Cap';
  const vol = m?.volume || {};
  const chg = m?.priceChange || {};
  const t24 = trendBadge(m?.priceChange?.h24);

  // Moonshot detection
  const isMoonshot =
    !!m?.launchPadPair ||
    String(m?.dexId || '').toLowerCase() === 'moonshot' ||
    !!m?.moonshot;

  const moonProgress = (typeof m?.moonshot?.progress === 'number')
    ? Math.max(0, Math.min(100, Number(m.moonshot.progress)))
    : null;

  const moonshotHeaderIcon = isMoonshot ? '🌙 ' : '';
  const moonshotLine = isMoonshot
    ? (moonProgress != null
        ? `Moonshot: <b>Yes</b>  ${esc(progressBar(moonProgress))}`
        : `Moonshot: <b>Yes</b>`)
    : `Moonshot: <b>No</b>`;

  // info lines
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
  const creatorPct  = data.creator?.percent != null ? esc(pct(data.creator.percent)) : 'N/A';

  // ----- layout (your requested order) -----
  const lines = [
    `${moonshotHeaderIcon}<b>${name}${sym ? ` (${sym})` : ''}</b>`,
    `<code>${ca}</code>`,
    moonshotLine,

    '',
    BR,

    (m ? `${capLabel}: <b>${esc(money(m.marketCap))}</b>` : `<i>No market data yet</i>`),
    (m && typeof m.priceUsd === 'number')
      ? `Price: <b>${esc(money(m.priceUsd, 8))}</b>   ${t24}`
      : `<i>Price unavailable</i>`,
    '',
    BR,
    'Volume:',
    (m ? `24h <b>${esc(money(vol.h24))}</b>` : undefined),
    (m ? `5m <b>${esc(money(vol.m5))}</b> • 1h <b>${esc(money(vol.h1))}</b> • 6h <b>${esc(money(vol.h6))}</b>` : undefined),
    '',
    BR,
    'Change:',
    (m ? `24h <b>${esc(pct(chg.h24))}</b>` : undefined),
    (m ? `5m <b>${esc(pct(chg.m5))}</b> • 1h <b>${esc(pct(chg.h1))}</b> • 6h <b>${esc(pct(chg.h6))}</b>` : undefined),
    '',
    BR,
    holdersLine,
    top10Line,
    `Creator: <code>${creatorAddr}</code><b>${creatorPct}</b>`,
    burnedLine,
    '',
  BR,
    `<i>Pick a section:</i>`,
    `• <b>Buyers</b> — first 20 buyers + status`,
    ...(hasHolders(data) ? [`• <b>Holders</b> — top 20 holder percentages`] : []),
    BR,
    `<i>Updated: ${esc(new Date(data.updatedAt).toLocaleString())}</i>`,
    `<i>Source: Dexscreener · Explorer</i>`
  ].filter(Boolean);

  const text = lines.join('\n');

  // ----- keyboard -----
    const navRow = hasHolders(data)
    ? [
        { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` },
        { text:'📊 Holders',     callback_data:`holders:${data.tokenAddress}:1` },
        { text:'📈 Distribution',callback_data:`dist:${data.tokenAddress}:1` }, // NEW
      ]
    : [
        { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` },
        { text:'📈 Distribution',callback_data:`dist:${data.tokenAddress}:1` }, // NEW (still useful)
      ];

  const kb = {
    reply_markup: {
      inline_keyboard: [
        // socials row (added below if any)
        [],
        navRow,
        [
          { text:'↻ Refresh', callback_data:`refresh:${data.tokenAddress}` },
          { text:'ℹ️ About',  callback_data:'about' }
        ]
      ].filter(row => row.length)
    }
  };

  // socials row (urls only)
  const linkRow = [];
  const t = m?.socials?.twitter;
  const g = m?.socials?.telegram;
  const w = m?.socials?.website;

  if (typeof t === 'string' && t.length) linkRow.push({ text:'𝕏 Twitter', url:t });
  if (typeof g === 'string' && g.length) linkRow.push({ text:'Telegram',  url:g });
  if (typeof w === 'string' && w.length) linkRow.push({ text:'Website',   url:w });

  if (linkRow.length) kb.reply_markup.inline_keyboard.unshift(linkRow);

  return { text, extra: kb };
}

/* ---------- NEW: Distribution screen ---------- */

function giniFromPercents(percArr) {
  // percArr is [% of supply], positive numbers. Convert to shares summing to 1.
  const x = (percArr || []).filter(n => n > 0).map(n => n / 100);
  if (!x.length) return null;
  const sum = x.reduce((a,b)=>a+b,0);
  if (sum === 0) return null;
  const y = x.map(v => v / sum).sort((a,b)=>a-b);
  let cum = 0, area = 0;
  for (const v of y) {
    const prev = cum;
    cum += v;
    area += (prev + cum) / 2;
  }
  // area is the area under Lorenz curve (normalized). Gini = 1 - 2*area/1
  return Math.max(0, Math.min(1, 1 - 2 * area / y.length));
}

function pickBucketsUSD(marketCapUsd) {
  // 6 buckets chosen by MC scale (tweak as you like)
  const mc = Number(marketCapUsd || 0);
  if (mc < 100_000)  return [10, 50, 100, 250, 500, 1000];
  if (mc < 500_000)  return [10, 100, 250, 500, 1000, 2500];
  if (mc < 1_000_000)return [25, 250, 500, 1000, 2500, 5000];
  if (mc < 5_000_000)return [50, 500, 1000, 2500, 5000, 10_000];
  return                   [100, 1000, 2500, 5000, 10_000, 25_000];
}

function compactBar(n, total, width=20) {
  if (!total) return '[....................] 0';
  const r = Math.max(0, Math.min(1, n/total));
  const filled = Math.round(r*width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width-filled)}] ${n}`;
}

export function renderDistribution(data, page=1) {
  const m = data.market || {};
  const cap = m.marketCap ?? m.fdv ?? 0;
  const price = Number(m.priceUsd || 0);

  const decimals = Number(data.decimals ?? 18);
  const totalSupplyBn = BigInt(data.totalSupply || '0');
  const totalTokens = Number(totalSupplyBn) / (10 ** decimals || 1); // ok for display

  const percAll = Array.isArray(data.holdersAllPerc) ? data.holdersAllPerc : [];
  const top20 = Array.isArray(data.holdersTop20) ? data.holdersTop20.map(x=>x.percent) : [];
  const haveAll = percAll.length > 0;

  // If we don’t have all percents yet, fallback to top-20 only (still useful)
  const percSource = haveAll ? percAll : top20;

  // Compute USD value per holder (approx): value = percent/100 * totalTokens * price
  const holdersUSD = percSource.map(p => (p/100) * totalTokens * price);

  // Required splits: ≥$10 and <$10 (counts)
  const ge10 = holdersUSD.filter(v => v >= 10).length;
  const lt10 = holdersUSD.filter(v => v > 0 && v < 10).length;

  // Dynamic 6-bucket histogram (<= each threshold; last is “≥ last”)
  const thresholds = pickBucketsUSD(cap);
  const buckets = thresholds.map(t => ({
    label: `$≤${t.toLocaleString()}`,
    count: holdersUSD.filter(v => v > 0 && v <= t).length
  }));
  const lastLabel = `$≥${thresholds[thresholds.length-1].toLocaleString()}`;
  const lastCount = holdersUSD.filter(v => v > thresholds[thresholds.length-1]).length;

  // Supply share bands (fixed)
  const bands = [
    { label:'<0.01%', max:0.01 },
    { label:'<0.05%', max:0.05 },
    { label:'<0.10%', max:0.10 },
    { label:'<0.50%', max:0.50 },
    { label:'≥1.00%', max:Infinity },
  ];
  const supplyCounts = bands.map(b => ({
    label: b.label,
    count: (haveAll ? percAll : top20).filter(p => p > 0 && (b.max===Infinity ? p>=1 : p < b.max)).length
  }));

  const gini = giniFromPercents(percSource);
  const name = esc(m?.name || 'Token');

  // Build text
  const lines = [
    `📈 <b>Distribution — ${name}</b>`,
    ``,
    `Holders considered: <b>${(haveAll ? percAll.length : top20.length).toLocaleString()}</b> ${haveAll ? '' : '(top-20 only)'}`,
    (gini!=null ? `Inequality (Gini): <b>${(gini*100).toFixed(1)}%</b>  <i>(0% = even, 100% = concentrated)</i>` : `Inequality: <i>N/A</i>`),
    ``,
    `<b>Value split</b> (by USD at current price):`,
    `• ≥ $10: <b>${ge10.toLocaleString()}</b>  •  < $10: <b>${lt10.toLocaleString()}</b>`,
    ``,
    `<b>Histogram</b> (holders by USD value):`,
    ...buckets.map(b => `• ${esc(b.label)} ${compactBar(b.count, haveAll ? percAll.length : top20.length)}`),
    `• ${lastLabel} ${compactBar(lastCount, haveAll ? percAll.length : top20.length)}`,
    ``,
    `<b>Supply share bands</b> (holders by % of supply):`,
    ...supplyCounts.map(s => `• ${esc(s.label)} — <b>${s.count.toLocaleString()}</b>`),
    ``,
    `<i>Notes:</i>`,
    `• Based on current price × supply shares; approximate USD per holder.`,
    `• Buckets auto-scale with market cap.`,
  ];

  const text = lines.join('\n');

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🏠 Overview', callback_data:`stats:${data.tokenAddress}` },
          { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` },
          { text:'📊 Holders',     callback_data:`holders:${data.tokenAddress}:1` },
        ]
      ]
    }
  };

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
    'Tip: Status uses final balance vs buy/sell history.',
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
          ...(hasHolders(data) ? [{ text:'📊 Holders', callback_data:`holders:${data.tokenAddress}:1` }] : [])
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
    'Notes:',
    '• Burn addresses (0x0 / 0xdead) are included in burned%.',
    '• Top-10 combined is shown in the overview.',
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

/** Optional: About screen */
export function renderAbout() {
  const text = [
    '🤖 <b>tABS Tools</b>',
    '',
    '• Market: Dexscreener (Abstract)',
    '• Transfers & creator: Explorer',
    '• Refresh cooldown: 30s',
    '• Data cache: 3 minutes',
    '',
    '<i>Made for Abstract chain token analytics.</i>'
  ].join('\n');
  
  const extra = {
    reply_markup: {
      inline_keyboard: [[{ text:'Back', callback_data: 'noop' }]]
    }
  };
  return { text, extra };
}
