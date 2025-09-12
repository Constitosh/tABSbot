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
    `Creator: <code>${creatorAddr}</code>: <b>${creatorPct}</b>`,
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
        { text:'📊 Holders',     callback_data:`holders:${data.tokenAddress}:1` }
      ]
    : [
        { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` }
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

    return `${n}. <code>${esc(shortAddr(r.address))}</code> — ${formatStatus(r.status)}`;
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
