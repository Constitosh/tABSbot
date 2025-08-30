// src/renderers.js
// HTML renderers for Telegram UI (safe against MarkdownV2 issues)
import { esc, pct, money, shortAddr, trendBadge } from './ui_html.js';

/**
 * Overview screen
 * Expects `data` shape from cache:
 * {
 *   tokenAddress, updatedAt,
 *   market: {
 *     name, symbol, priceUsd, volume{m5,h1,h6,h24},
 *     priceChange{m5,h1,h6,h24}, marketCap, marketCapSource, imageUrl,
 *     socials{twitter, telegram, website}, url, dexId, ...
 *   },
 *   holdersCount, top10CombinedPct, burnedPct,
 *   creator: { address, percent }
 * }
 */
export function renderOverview(data) {
  const m = data.market || {};
  const name = esc(m.name || 'Token');
  const sym  = esc(m.symbol || '');
  const ca   = esc(data.tokenAddress);
  const creator = data.creator?.address ? esc(shortAddr(data.creator.address)) : 'unknown';
  const t24 = trendBadge(m.priceChange?.h24);

  const capLabel = (m.marketCapSource === 'fdv') ? 'FDV (as cap)' : 'Market Cap';
  const holdersCountLine = (typeof data.holdersCount === 'number')
    ? `Holders: <b>${data.holdersCount.toLocaleString()}</b>`
    : null;

  const lines = [
    `🪙 <b>Token Overview — ${name}${sym ? ` (${sym})` : ''}</b>`,
    `CA: <code>${ca}</code>`,
    ``,
    `Price: <b>${esc(money(m.priceUsd, 8))}</b>   ${t24}`,
    `Volume: 5m <b>${esc(money(m.volume?.m5))}</b> • 1h <b>${esc(money(m.volume?.h1))}</b> • 6h <b>${esc(money(m.volume?.h6))}</b> • 24h <b>${esc(money(m.volume?.h24))}</b>`,
    `Change: 5m <b>${esc(pct(m.priceChange?.m5))}</b> • 1h <b>${esc(pct(m.priceChange?.h1))}</b> • 6h <b>${esc(pct(m.priceChange?.h6))}</b> • 24h <b>${esc(pct(m.priceChange?.h24))}</b>`,
    `${capLabel}: <b>${esc(money(m.marketCap))}</b>`,
    holdersCountLine || undefined,
    `Creator: <code>${creator}</code> — <b>${esc(pct(data.creator?.percent))}</b>`,
    `Top 10 combined: <b>${esc(pct(data.top10CombinedPct))}</b>`,
    `Burned: <b>${esc(pct(data.burnedPct))}</b>`,
    ``,
    `<i>Pick a section:</i>`,
    `• <b>Buyers</b> — first 20 buyers + status`,
    `• <b>Holders</b> — top 20 holder percentages`,
    ``,
    `<i>Updated: ${esc(new Date(data.updatedAt).toLocaleString())}</i>`,
    `<i>Source: Dexscreener · Abscan (Abstract)</i>`
  ].filter(Boolean);

  const text = lines.join('\n');

  // Keyboard
  const kb = {
    reply_markup: {
      inline_keyboard: [
        // link row (inserted below if we have socials)
        [],
        [
          { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` },
          { text:'📊 Holders',     callback_data:`holders:${data.tokenAddress}:1` }
        ],
        [
          { text:'↻ Refresh',      callback_data:`refresh:${data.tokenAddress}` },
          { text:'ℹ️ About',       callback_data:'about' }
        ]
      ].filter(row => row.length)
    }
  };

  // Add socials link row at the top if present
  const linkRow = [];
  if (m.socials?.twitter)  linkRow.push({ text: '𝕏 Twitter', url: m.socials.twitter });
  if (m.socials?.telegram) linkRow.push({ text: 'Telegram',  url: m.socials.telegram });
  if (m.socials?.website)  linkRow.push({ text: 'Website',   url: m.socials.website });
  if (linkRow.length) kb.reply_markup.inline_keyboard.unshift(linkRow);

  return { text, extra: kb };
}

// ...inside renderOverview(data) after kb is created:

const linkRow = [];
const t = m.socials?.twitter;
const g = m.socials?.telegram;
const w = m.socials?.website;

if (typeof t === 'string' && t.length) linkRow.push({ text: '𝕏 Twitter', url: t });
if (typeof g === 'string' && g.length) linkRow.push({ text: 'Telegram',  url: g });
if (typeof w === 'string' && w.length) linkRow.push({ text: 'Website',   url: w });

if (linkRow.length) kb.reply_markup.inline_keyboard.unshift(linkRow);

/**
 * Buyers screen with pagination
 * data.first20Buyers = [{ address, status }, ...] (already computed)
 */
export function renderBuyers(data, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  const rows = (data.first20Buyers || []).slice(start, start + pageSize);
  const name = esc(data.market?.name || 'Token');

  const body = rows.map((r, i) => {
    const n = String(start + i + 1).padStart(2, '0');
    return `${n}. <code>${esc(shortAddr(r.address))}</code> — ${esc(r.status)}`;
  }).join('\n') || '<i>No buyers found yet</i>';

  const totalPages = Math.ceil((data.first20Buyers || []).length / pageSize) || 1;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    `🧑‍🤝‍🧑 <b>First 20 Buyers — ${name}</b>`,
    ``,
    body,
    ``,
    `Tip: Status compares current balance vs their first received amount.`,
    ``,
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
          { text:'📊 Holders',  callback_data:`holders:${data.tokenAddress}:1` }
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

  const body = rows.map((h, i) => {
    const n = String(start + i + 1).padStart(2, '0');
    return `${n}. <code>${esc(shortAddr(h.address))}</code> — <b>${esc(pct(h.percent))}</b>`;
  }).join('\n') || '<i>No holders found yet</i>';

  const totalPages = Math.ceil((data.holdersTop20 || []).length / pageSize) || 1;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    `📊 <b>Top Holders — ${name}</b>`,
    ``,
    body,
    ``,
    `Notes:`,
    `• Burn addresses (0x0 / 0xdead) are included in burned%.`,
    `• Top-10 combined is shown in the overview.`,
    ``,
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
    ``,
    `• Market: Dexscreener (Abstract)`,
    `• Holders & transfers: Abscan (Abstract explorer)`,
    `• Refresh cooldown: 30s`,
    `• Data cache: 3 minutes`,
    ``,
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