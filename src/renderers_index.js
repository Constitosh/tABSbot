// src/renderers_index.js
import { esc } from './ui_html.js';

/**
 * Expects payload from indexWorker:
 * {
 *   tokenAddress, updatedAt,
 *   holdersCount, top10CombinedPct, gini,
 *   pctDist:  [{label,count}],   // supply % distribution (filtered)
 *   valueDist:[{label,count}],   // $-value distribution (filtered)
 *   meta: { excluded: { lp, token, burn:true } }
 * }
 */

function fmtPct(n, d = 2) {
  if (!Number.isFinite(n)) return '+0.00%';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}${Math.abs(n).toFixed(d)}%`;
}
function bars(count, total, slots = 10) {
  const n = Math.max(0, Math.min(slots, Math.round((total > 0 ? (count / total) : 0) * slots)));
  return `[${'█'.repeat(n)}${'░'.repeat(slots - n)}]`;
}

export function renderIndexView(idx) {
  const holders = Number(idx?.holdersCount || 0);
  const top10   = Number(idx?.top10CombinedPct || 0);
  const gini    = Number(idx?.gini || 0);

  const pctDist   = Array.isArray(idx?.pctDist) ? idx.pctDist : [];
  const valueDist = Array.isArray(idx?.valueDist) ? idx.valueDist : [];

  const head = [
    `📈 <b>Index</b>`,
    ``,
    `Holders: <b>${holders.toLocaleString()}</b>`,
    `Top-10 combined: <b>${esc(fmtPct(top10, 2))}</b>`,
    `Inequality (Gini): <b>${gini.toFixed(4)}</b> <i>(0=fair • 1=concentrated)</i>`,
    ``,
  ];

  const pctLines = pctDist.length
    ? [
        `Distribution by % of supply`,
        ...pctDist.map(b => `• ${esc(b.label)} — <b>${b.count}</b> ${bars(b.count, holders)}`),
        ``,
      ]
    : [];

  const valLines = valueDist.length
    ? [
        `Distribution by estimated value`,
        ...valueDist.map(b => `• ${esc(b.label)} — <b>${b.count}</b> ${bars(b.count, holders)}`),
        ``,
      ]
    : [];

  const foot = [
    `Snapshot excludes LP/CA pools and burn addresses.`,
    `Cached ~6h.`,
  ];

  const text = [...head, ...pctLines, ...valLines, ...foot].join('\n');

  const extra = {
    reply_markup: {
      inline_keyboard: [[
        { text:'🏠 Overview', callback_data:`stats:${idx.tokenAddress}` },
        { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${idx.tokenAddress}:1` },
        { text:'📊 Holders', callback_data:`holders:${idx.tokenAddress}:1` },
      ]]
    },
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  return { text, extra };
}