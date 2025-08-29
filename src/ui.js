// renderers.js
import { escapeMd, pct, money, num, shortAddr, trendBadge } from './ui.js';

export function renderOverview(data) {
  const m = data.market || {};
  const name = escapeMd(m.name || 'Token');
  const sym  = escapeMd(m.symbol || '');
  const ca   = escapeMd(data.tokenAddress);
  const creator = data.creator?.address ? escapeMd(shortAddr(data.creator.address)) : 'unknown';
  const t24 = trendBadge(m.priceChange?.h24);

  const text = [
    `🪙 Token Overview — *${name}* (${sym})`,
    `CA: \`${ca}\``,
    ``,
    `Price: *${escapeMd(money(m.priceUsd, 8))}*   ${t24}`,
    `24h Volume: *${escapeMd(money(m.volume24h))}*`,
    `Change: 1h *${escapeMd(pct(m.priceChange?.h1))}*  •  6h *${escapeMd(pct(m.priceChange?.h6))}*  •  24h *${escapeMd(pct(m.priceChange?.h24))}*`,
    `FDV (MCap): *${escapeMd(money(m.marketCap))}*`,
    ``,
    `Creator: \`${escapeMd(creator)}\` — *${escapeMd(pct(data.creator?.percent))}*`,
    `Top 10 combined: *${escapeMd(pct(data.top10CombinedPct))}*`,
    `Burned: *${escapeMd(pct(data.burnedPct))}*`,
    ``,
    `Pick a section:`,
    `• *Buyers* — first 20 buyers + status`,
    `• *Holders* — top 20 holder percentages`,
    ``,
    `_Updated: ${escapeMd(new Date(data.updatedAt).toLocaleString())}_`,
    `_Source: Dexscreener · Abscan (Abstract)_`
  ].join('\n');

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

export function renderBuyers(data, page=1, pageSize=10) {
  const start = (page-1)*pageSize;
  const rows = (data.first20Buyers || []).slice(start, start+pageSize);
  const name = escapeMd(data.market?.name || 'Token');
  const lines = rows.map((r,i)=>{
    const n = String(start+i+1).padStart(2,'0');
    return `${n}. ${escapeMd(shortAddr(r.address))} — ${escapeMd(r.status)}`;
  }).join('\n') || '_No buyers found yet_';
  const totalPages = Math.ceil((data.first20Buyers || []).length / pageSize) || 1;

  const text = [
    `🧑‍🤝‍🧑 First 20 Buyers — *${name}*`,
    ``,
    lines,
    ``,
    `Tip: Status compares current balance vs their first received amount.`,
    ``,
    `_Updated: ${escapeMd(new Date(data.updatedAt).toLocaleString())}_  ·  _Page ${page}/${totalPages}_`
  ].join('\n');

  const prev = Math.max(1, page-1);
  const next = Math.min(totalPages, page+1);

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'◀️', callback_data:`buyers:${data.tokenAddress}:${prev}`, disable_web_page_preview:true },
          { text:`${page}/${totalPages}`, callback_data:'noop' },
          { text:'▶️', callback_data:`buyers:${data.tokenAddress}:${next}` }
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

export function renderHolders(data, page=1, pageSize=10) {
  const start = (page-1)*pageSize;
  const rows = (data.holdersTop20 || []).slice(start, start+pageSize);
  const name = escapeMd(data.market?.name || 'Token');
  const lines = rows.map((h,i)=>{
    const n = String(start+i+1).padStart(2,'0');
    return `${n}. ${escapeMd(shortAddr(h.address))} — ${escapeMd(pct(h.percent))}`;
  }).join('\n') || '_No holders found yet_';

  const totalPages = Math.ceil((data.holdersTop20 || []).length / pageSize) || 1;
  const prev = Math.max(1, page-1);
  const next = Math.min(totalPages, page+1);

  const text = [
    `📊 Top Holders — *${name}*`,
    ``,
    lines,
    ``,
    `Notes:`,
    `• Burn addresses (0x0 / 0xdead) are included in burned%.`,
    `• Top-10 combined is shown in the overview.`,
    ``,
    `_Updated: ${escapeMd(new Date(data.updatedAt).toLocaleString())}_  ·  _Page ${page}/${totalPages}_`
  ].join('\n');

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'◀️', callback_data:`holders:${data.tokenAddress}:${prev}` },
          { text:`${page}/${totalPages}`, callback_data:'noop' },
          { text:'▶️', callback_data:`holders:${data.tokenAddress}:${next}` }
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
