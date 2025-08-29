// src/renderers.js
import { esc, pct, money, num, shortAddr, trendBadge } from './ui_html.js';

export function renderOverview(data) {
  const m = data.market || {};
  const name = esc(m.name || 'Token');
  const sym  = esc(m.symbol || '');
  const ca   = esc(data.tokenAddress);
  const creator = data.creator?.address ? esc(shortAddr(data.creator.address)) : 'unknown';
  const t24 = trendBadge(m.priceChange?.h24);

  const lines = [
    `🪙 <b>Token Overview — ${name}${sym ? ` (${sym})` : ''}</b>`,
    `CA: <code>${ca}</code>`,
    ``,
    `Price: <b>${esc(money(m.priceUsd, 8))}</b>   ${t24}`,
    `24h Volume: <b>${esc(money(m.volume24h))}</b>`,
    `Change: 1h <b>${esc(pct(m.priceChange?.h1))}</b>  •  6h <b>${esc(pct(m.priceChange?.h6))}</b>  •  24h <b>${esc(pct(m.priceChange?.h24))}</b>`,
    `FDV (MCap): <b>${esc(money(m.marketCap))}</b>`,
    ``,
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
  ];

  const text = lines.join('\n');

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${data.tokenAddress}:1` },
          { text:'📊 Holders',     callback_data:`holders:${data.tokenAddress}:1` }
        ],
        [
          { text:'↻ Refresh',      callback_data:`refresh:${data.tokenAddress}` },
          { text:'ℹ️ About',       callback_data:'about' }
        ]
      ]
    }
  };

  return { text, extra: kb };
}

export function renderBuyers(data, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  const rows = (data.first20Buyers || []).slice(start, start + pageSize);
  const name = esc(data.market?.name || 'Token');
  const lines = rows.map((r, i) => {
    const n = String(start + i + 1).padStart(2, '0');
    return `${n}. <code>${esc(shortAddr(r.address))}</code> — ${esc(r.status)}`;
  }).join('\n') || '<i>No buyers found yet</i>';

  const totalPages = Math.ceil((data.first20Buyers || []).length / pageSize) || 1;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    `🧑‍🤝‍🧑 <b>First 20 Buyers — ${name}</b>`,
    ``,
    lines,
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

export function renderHolders(data, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  const rows = (data.holdersTop20 || []).slice(start, start + pageSize);
  const name = esc(data.market?.name || 'Token');
  const lines = rows.map((h, i) => {
    const n = String(start + i + 1).padStart(2, '0');
    return `${n}. <code>${esc(shortAddr(h.address))}</code> — <b>${esc(pct(h.percent))}</b>`;
  }).join('\n') || '<i>No holders found yet</i>';

  const totalPages = Math.ceil((data.holdersTop20 || []).length / pageSize) || 1;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    `📊 <b>Top Holders — ${name}</b>`,
    ``,
    lines,
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
