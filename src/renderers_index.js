// src/renderers_index.js
import { esc, pct } from './ui_html.js';

// 10-tick bar, fraction in [0..1]
function bar10(frac) {
  const f = Math.max(0, Math.min(1, Number(frac||0)));
  const n = Math.round(f * 10);
  return `[${'█'.repeat(n)}${'░'.repeat(10 - n)}]`;
}

function linesForDist(title, items, total) {
  const T = Math.max(1, Number(total||0));
  const rows = [];
  rows.push(title);
  for (const it of (items || [])) {
    const c = Number(it.count || 0);
    const frac = c / T;
    rows.push(`• ${it.label} — ${c.toLocaleString()} ${bar10(frac)}`);
  }
  return rows;
}

export function renderIndexView(tokenSummary, indexResult) {
  const ca = esc(tokenSummary?.tokenAddress || '');

  if (!indexResult || !indexResult.ready) {
    const text = [
      `📈 <b>Index</b>`,
      ``,
      `<i>Holder distribution is being prepared…</i>`,
      ``,
      `This runs once and is cached for 6 hours.`,
    ].join('\n');

    const kb = {
      reply_markup: {
        inline_keyboard: [
          [
            { text:'🏠 Overview', callback_data:`stats:${tokenSummary?.tokenAddress}` },
            { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${tokenSummary?.tokenAddress}:1` },
            ...(Array.isArray(tokenSummary?.holdersTop20) && tokenSummary.holdersTop20.length
              ? [{ text:'📊 Holders', callback_data:`holders:${tokenSummary.tokenAddress}:1` }]
              : [])
          ]
        ]
      }
    };
    return { text, extra: kb };
  }

  const idx = indexResult.data || {};
  const gini = Number(idx.gini || 0);
  const lpNote = idx.lpExcluded ? ' (LP excluded)' : '';
  const holders = Number(idx.holdersCount || 0);

  const header = [
    `📈 <b>Index</b>`,
    ``,
    `Holders: <b>${holders.toLocaleString()}</b>`,
    `Top-10 combined: <b>${esc(pct(idx.top10CombinedPct||0))}</b>${lpNote}`,
    `Inequality (Gini): <b>${gini.toFixed(4)}</b>${lpNote} <i>(0=fair • 1=concentrated)</i>`,
    ...(Number(idx.holdersGte10 || 0) > 0 ? [ `Holders ≥ $10: <b>${Number(idx.holdersGte10).toLocaleString()}</b>` ] : []),
    ``,
  ];

  const distPctLines = linesForDist('Distribution by % of supply', idx.distPct, holders);
  const distUsdLines = linesForDist('Distribution by estimated value', idx.distUsd, holders);

  const text = [
    ...header,
    ...distPctLines, '',
    ...distUsdLines, '',
    `<i>Snapshot cached for ~6h.</i>`,
  ].join('\n');

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🏠 Overview', callback_data:`stats:${tokenSummary?.tokenAddress}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${tokenSummary?.tokenAddress}:1` },
          ...(Array.isArray(tokenSummary?.holdersTop20) && tokenSummary.holdersTop20.length
            ? [{ text:'📊 Holders', callback_data:`holders:${tokenSummary.tokenAddress}:1` }]
            : [])
        ],
        ...(idx.lpAddress ? [[
          { text:`LP ${String(idx.lpAddress).slice(0,6)}…${String(idx.lpAddress).slice(-4)}`, callback_data:'noop' }
        ]] : [])
      ]
    }
  };

  return { text, extra: kb };
}