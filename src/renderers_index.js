// src/renderers_index.js
import { esc, money } from './ui_html.js';

function bar(n, total) {
  if (!total) return '';
  const width = 12; // 12 chars bar
  const frac = Math.max(0, Math.min(1, n / total));
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '▉'.repeat(filled) + '░'.repeat(width - filled);
}
function num(x){ return Number(x||0).toLocaleString(); }

export function renderIndexView(snap) {
  const name = esc(snap?.market?.name || 'Token');
  const sym  = esc(snap?.market?.symbol || '');
  const cap  = Number(snap?.market?.capUsd || 0);

  // Histogram rows
  const totalH = (snap?.counts || []).reduce((a,b)=>a+b,0);
  const lines = [];
  const bins = snap?.bins || [];
  const counts = snap?.counts || [];
  const values = snap?.values || [];
  for (let i = 0; i <= bins.length; i++) {
  const rawLabel =
    (i < bins.length)
      ? `&lt;$${bins[i]}`             // <-- escape <
      : `≥$${bins[bins.length-1]}`;
  const c = counts[i] || 0;
  const v = values[i] || 0;

  // pad without breaking &lt; (treat label as plain text length ~ use fixed width 7 as before)
  const padded = (i < bins.length)
    ? `&lt;$${String(bins[i]).padEnd(5,' ')}`
    : `≥$${String(bins[bins.length-1]).padEnd(6,' ')}`;

  lines.push(
    `${padded} ${bar(c, totalH)}  <b>${num(c)}</b>  ·  ${esc(money(v,2))}`
  );
}
  // % supply bands
  const bands = (snap?.pctSupplyBands || []).map(b => `${esc(b.label)}: <b>${num(b.cnt)}</b>`).join(' • ');

  // Minimal Gini explainer
  const giniLine = `Gini: <b>${(Number(snap?.gini||0)*100).toFixed(1)}%</b> — 0% = even, 100% = concentrated`;

  const text = [
    `📈 <b>Index — ${name}${sym ? ` (${sym})` : ''}</b>`,
    ``,
    `Cap: <b>${esc(money(cap,0))}</b>   ·   Holders: <b>${num(snap?.holdersCount || 0)}</b>`,
    `Real holders (≥$10): <b>${num(snap?.realHolders||0)}</b>  ·  <$10: <b>${num(snap?.microHolders||0)}</b>`,
    giniLine,
    ``,
    `<b>Value Histogram</b> (holders per USD bucket; bar = share of holders)`,
    ...lines,
    ``,
    `<b>Supply Distribution</b>`,
    bands,
    ``,
    `<i>Updated: ${new Date(snap?.updatedAt||Date.now()).toLocaleString()}</i>`,
  ].join('\n');

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🏠 Overview', callback_data:`stats:${snap.tokenAddress}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${snap.tokenAddress}:1` },
          { text:'📊 Holders', callback_data:`holders:${snap.tokenAddress}:1` },
        ],
        [
          { text:'↻ Refresh Index', callback_data:`index_refresh:${snap.tokenAddress}` }
        ]
      ]
    }
  };

  return { text, extra: kb };
}